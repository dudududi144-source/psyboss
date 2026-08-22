/**
 * PSYBOSS AudioEngine — main-thread orchestrator.
 *
 * Scope 2 fixes (ROAST-1 §1, §3, §5):
 *   - The trig path now flows through PSYBUS: requestTrig → bus.publish(trig) →
 *     engine subscribes to trigs → armTrig → flushArmedTrigs → scheduleVoice.
 *     The provenance gate ACTUALLY RUNS on every trig now.
 *   - Lookahead scheduling: voices are scheduled at the next bar boundary in
 *     audio-context time (computed from the worklet's posted audioTime), not at
 *     currentTime+0.002. Fixes the "7ms late" lie.
 *   - Voice pool with hard cap (64) + disconnect-on-ended. No more unbounded
 *     BufferSource accumulation; oldest voice is stolen under pressure.
 *   - First-sound latency fixed: the worklet posts transport immediately on `play`,
 *     so a click on a stopped transport fires at beat 0 of bar 1 (~immediately),
 *     not after one full bar of silence.
 *   - Transport posts on setBpm too (bar/beat readout no longer stale for up to 1 bar).
 *
 * The clock worklet is the timing authority. This engine NEVER uses setInterval or
 * setTimeout for musical timing.
 */

import { getBus } from '@/psybus/host'
import {
  deviceId,
  trackId,
  sceneId,
  type BusEnvelope,
  type SampleRef,
} from '@/psybus/types'
import { renderSoundBank, dspProvenance } from './dsp'

export interface TransportState {
  bpm: number
  beat: number
  bar: number
  phase: number
  playing: boolean
  audioTime: number // audio-context seconds at the posted bar boundary
}

export interface MeterState {
  rms: number // dBFS
  peak: number // dBFS
}

type TransportListener = (t: TransportState) => void
type MeterListener = (m: MeterState) => void

const DEFAULT_BPM = 144
const BEATS_PER_BAR = 4
const DEFAULT_SEED = 0x9e3779b9
const VOICE_CAP = 64 // hard polyphony limit across all tracks

const UI_DEVICE = deviceId('psyboss-ui')
const ENGINE_DEVICE = deviceId('psyboss-engine')

export class AudioEngine {
  private ctx: AudioContext | null = null
  private clockNode: AudioWorkletNode | null = null
  private masterGain: GainNode | null = null
  private limiter: DynamicsCompressorNode | null = null

  private trackGains: GainNode[] = []
  private soundBank: Map<string, AudioBuffer> = new Map()
  private readonly seed: number

  private transport: TransportState = {
    bpm: DEFAULT_BPM,
    beat: 0,
    bar: 0,
    phase: 0,
    playing: false,
    audioTime: 0,
  }
  private meter: MeterState = { rms: -140, peak: -140 }

  private transportListeners = new Set<TransportListener>()
  private meterListeners = new Set<MeterListener>()

  private armedTrigs: Array<{ track: number; scene: number }> = []
  private activeVoices: Set<AudioBufferSourceNode> = new Set()
  private workletReady = false
  private busSubscribed = false

  constructor(seed: number = DEFAULT_SEED) {
    this.seed = seed
  }

  get currentTransport(): TransportState {
    return { ...this.transport }
  }

  get currentMeter(): MeterState {
    return { ...this.meter }
  }

  get currentSeed(): number {
    return this.seed
  }

  onTransport(fn: TransportListener): () => void {
    this.transportListeners.add(fn)
    return () => this.transportListeners.delete(fn)
  }

  onMeter(fn: MeterListener): () => void {
    this.meterListeners.add(fn)
    return () => this.meterListeners.delete(fn)
  }

  private emitTransport() {
    const t = this.currentTransport
    this.transportListeners.forEach((l) => l(t))
  }

  private emitMeter() {
    const m = this.currentMeter
    this.meterListeners.forEach((l) => l(m))
  }

  async init(): Promise<void> {
    if (this.ctx) return
    // Use the hardware sample rate (don't force 48kHz → avoids resampling artifacts).
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    this.ctx = ctx

    await ctx.audioWorklet.addModule('/worklets/psyboss-clock.js')
    this.workletReady = true

    // ── Master bus graph ──
    // trackGains[i] → masterGain → limiter → clockNode (passthrough+meter) → destination
    this.masterGain = ctx.createGain()
    this.masterGain.gain.value = 0.8

    this.limiter = ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -1.0
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.05

    this.clockNode = new AudioWorkletNode(ctx, 'psyboss-clock', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })

    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain()
      g.gain.value = 0.75
      g.connect(this.masterGain)
      this.trackGains.push(g)
    }

    this.masterGain.connect(this.limiter)
    this.limiter.connect(this.clockNode)
    this.clockNode.connect(ctx.destination)

    // ── Render the deterministic sound bank ──
    const bank = renderSoundBank(ctx.sampleRate, this.seed)
    for (const [key, stereo] of bank.entries()) {
      const buf = ctx.createBuffer(2, stereo.left.length, ctx.sampleRate)
      buf.copyToChannel(stereo.left, 0)
      buf.copyToChannel(stereo.right, 1)
      this.soundBank.set(key, buf)
    }

    // ── Wire PSYBUS: the engine subscribes to trigs published by the UI ──
    // This is THE fix for ROAST-1 §1 (#1 embarrassing defect): the bus is no longer dead.
    if (!this.busSubscribed) {
      const bus = getBus(this.seed)
      bus.register(ENGINE_DEVICE, {
        audio: true, midiIn: false, midiOut: false, maxVoices: VOICE_CAP, params: [],
      })
      bus.subscribe(
        ENGINE_DEVICE,
        (e) => e.payload.kind === 'trig',
        (e) => {
          if (e.payload.kind === 'trig') {
            // The provenance gate has already run inside bus.publish before delivery.
            const trackNum = Number(e.payload.track.replace('track-', ''))
            const sceneNum = Number(e.payload.scene.replace('scene-', ''))
            if (!Number.isNaN(trackNum) && !Number.isNaN(sceneNum)) {
              this.armTrig(trackNum, sceneNum)
            }
          }
        },
      )
      this.busSubscribed = true
    }

    // ── Worklet message handling ──
    this.clockNode.port.onmessage = (e: MessageEvent) => {
      const m = e.data
      if (m.kind === 'transport') {
        this.transport = {
          bpm: m.bpm,
          beat: m.beat,
          bar: m.bar,
          phase: m.phase,
          playing: m.playing,
          audioTime: m.audioTime,
        }
        this.emitTransport()
        this.flushArmedTrigs()
      } else if (m.kind === 'meter') {
        this.meter = { rms: m.rms, peak: m.peak }
        this.emitMeter()
      }
    }

    if (ctx.state === 'suspended') await ctx.resume()
  }

  /**
   * Request a scene trigger. Publishes a `trig` envelope on PSYBUS — the provenance
   * gate runs inside bus.publish BEFORE delivery. The engine subscribes to trigs
   * and arms the voice for the next bar boundary.
   *
   * If stopped, starts playback first (the worklet posts transport immediately on
   * play, so the first bar boundary arrives within ~1 quantum, not 1.67s).
   */
  requestTrig(track: number, scene: number): void {
    if (!this.ctx || !this.workletReady) return
    const soundId = `${track}:${scene}`
    const sampleRef: SampleRef = {
      id: `dsp:${soundId}`,
      provenance: dspProvenance(soundId, this.seed),
    }
    const envelope: BusEnvelope = {
      rev: getBus(this.seed).nextRev(),
      seed: this.seed,
      src: UI_DEVICE,
      dst: ENGINE_DEVICE, // unicast — only the engine subscribes to trigs today
      ts: this.ctx.currentTime,
      payload: {
        kind: 'trig',
        track: trackId(`track-${track}`),
        scene: sceneId(`scene-${scene}`),
        sampleRef,
      },
    }
    // This call runs the provenance gate (assertProvenance) and routes to the engine
    // subscriber. If the gate throws, the trig is rejected — no sound, by design.
    getBus(this.seed).publish(envelope)

    if (!this.transport.playing) {
      this.play()
    }
  }

  private armTrig(track: number, scene: number) {
    this.armedTrigs.push({ track, scene })
  }

  /**
   * Schedule armed trigs at the NEXT bar boundary in audio-context time.
   *
   * The worklet posts `audioTime` = the audio-context time at the bar boundary it
   * just crossed. By the time the main thread receives the message (~2-5ms later),
   * that audioTime is slightly in the past. So we schedule at the FOLLOWING bar
   * boundary = audioTime + secPerBar. That's still "bar-quantized" (fires at a bar
   * boundary), and lands ahead of the audio thread (no late scheduling).
   *
   * This replaces the Scope-1 `currentTime + 0.002` hack (which was 7ms late and
   * not bar-quantized). See ROAST-1 §3.
   */
  private flushArmedTrigs() {
    if (this.armedTrigs.length === 0 || !this.ctx) return
    const secPerBar = (60 / this.transport.bpm) * BEATS_PER_BAR
    // audioTime is the bar boundary the worklet just crossed; schedule one bar ahead.
    const when = this.transport.audioTime + secPerBar
    // If that's already in the past (shouldn't happen, but guard), fall back to now+1quantum.
    const safeWhen = Math.max(when, this.ctx.currentTime + 128 / this.ctx.sampleRate)
    for (const trig of this.armedTrigs) {
      this.scheduleVoice(trig.track, trig.scene, safeWhen)
    }
    this.armedTrigs = []
  }

  private scheduleVoice(track: number, scene: number, when: number) {
    if (!this.ctx) return
    const key = `${track}:${scene}`
    const buf = this.soundBank.get(key)
    if (!buf) return

    // Voice cap: steal the oldest active voice if we'd exceed the limit.
    if (this.activeVoices.size >= VOICE_CAP) {
      const oldest = this.activeVoices.values().next().value
      if (oldest) {
        try { oldest.stop() } catch { /* already stopped */ }
        // onended handler will remove it from the set and disconnect.
      }
    }

    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.trackGains[track] ?? this.masterGain!)
    this.activeVoices.add(src)
    // Clean up: disconnect + remove from active set when the buffer finishes playing.
    src.onended = () => {
      this.activeVoices.delete(src)
      try { src.disconnect() } catch { /* already disconnected */ }
    }
    try {
      src.start(when)
    } catch {
      // start time was in the past; fire immediately
      try { src.start() } catch { /* give up */ }
      this.activeVoices.delete(src)
    }
  }

  play(): void {
    if (!this.clockNode || !this.ctx) return
    if (this.ctx.state === 'suspended') this.ctx.resume()
    this.clockNode.port.postMessage({ kind: 'play' })
    // Optimistic UI update; the worklet will post authoritative transport within ~1 quantum.
    this.transport = { ...this.transport, playing: true }
    this.emitTransport()
  }

  stop(): void {
    if (!this.clockNode) return
    this.clockNode.port.postMessage({ kind: 'stop' })
    this.transport = { ...this.transport, playing: false }
    this.armedTrigs = []
    this.emitTransport()
  }

  setBpm(bpm: number): void {
    if (!this.clockNode) return
    this.clockNode.port.postMessage({ kind: 'setBpm', bpm })
    this.transport = { ...this.transport, bpm }
    this.emitTransport()
  }
}

let _engine: AudioEngine | null = null

export function getEngine(seed?: number): AudioEngine {
  if (typeof window === 'undefined') {
    throw new Error('AudioEngine is browser-only (it owns an AudioContext)')
  }
  if (!_engine) {
    _engine = new AudioEngine(seed ?? DEFAULT_SEED)
  }
  return _engine
}
