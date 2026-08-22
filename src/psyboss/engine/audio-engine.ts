/**
 * PSYBOSS AudioEngine — the main-thread orchestrator.
 *
 * Owns: AudioContext, the clock AudioWorklet, the master bus graph, the sound bank,
 * and the sample-accurate voice scheduler.
 *
 * The clock worklet is the timing authority. This engine NEVER uses setInterval or
 * setTimeout for musical timing. It reads transport posts from the worklet and
 * schedules Web Audio nodes at sample-accurate audio-context times.
 */

import type { BusEnvelope } from '@/psybus/types'
import { renderSoundBank, dspProvenance, type StereoBuffer } from './dsp'

export interface TransportState {
  bpm: number
  beat: number
  bar: number
  phase: number
  playing: boolean
  audioTime: number
}

export interface MeterState {
  rms: number // dBFS
  peak: number // dBFS
}

type TransportListener = (t: TransportState) => void
type MeterListener = (m: MeterState) => void

const DEFAULT_BPM = 144
const BEATS_PER_BAR = 4

export class AudioEngine {
  private ctx: AudioContext | null = null
  private clockNode: AudioWorkletNode | null = null
  private masterGain: GainNode | null = null
  private limiter: DynamicsCompressorNode | null = null

  private trackGains: GainNode[] = []
  private soundBank: Map<string, AudioBuffer> = new Map()

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
  private workletReady = false

  get currentTransport(): TransportState {
    return { ...this.transport }
  }

  get currentMeter(): MeterState {
    return { ...this.meter }
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

  /** Initialise the audio graph. Must be called from a user gesture (browser policy). */
  async init(): Promise<void> {
    if (this.ctx) return
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    this.ctx = ctx

    // Load the worklet module
    await ctx.audioWorklet.addModule('/worklets/psyboss-clock.js')
    this.workletReady = true

    // ── Master bus graph ──
    // trackGains[i] → masterGain → limiter → clockNode (passthrough+meter) → destination
    this.masterGain = ctx.createGain()
    this.masterGain.gain.value = 0.8

    this.limiter = ctx.createDynamicsCompressor()
    // brickwall-ish: high ratio, low threshold, fast attack, lookahead via knee 0
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

    // per-track gains (4 tracks, Scope 1)
    for (let i = 0; i < 4; i++) {
      const g = ctx.createGain()
      g.gain.value = 0.75
      g.connect(this.masterGain)
      this.trackGains.push(g)
    }

    // wire the bus
    this.masterGain.connect(this.limiter)
    this.limiter.connect(this.clockNode)
    this.clockNode.connect(ctx.destination)

    // ── Render the procedural sound bank ──
    const bank = renderSoundBank(ctx.sampleRate)
    for (const [key, stereo] of bank.entries()) {
      const buf = ctx.createBuffer(2, stereo.left.length, ctx.sampleRate)
      buf.copyToChannel(stereo.left, 0)
      buf.copyToChannel(stereo.right, 1)
      this.soundBank.set(key, buf)
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
        // fire any armed trigs whose target bar has arrived
        this.flushArmedTrigs()
      } else if (m.kind === 'meter') {
        this.meter = { rms: m.rms, peak: m.peak }
        this.emitMeter()
      }
    }

    // resume context (it may start suspended)
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
  }

  /** Request a scene trigger, bar-quantized. If stopped, starts playback first. */
  requestTrig(track: number, scene: number): void {
    if (!this.ctx || !this.workletReady) return
    if (!this.transport.playing) {
      // start playback, then arm for the first bar (beat 0)
      this.armTrig(track, scene)
      this.play()
      return
    }
    this.armTrig(track, scene)
  }

  private armTrig(track: number, scene: number) {
    this.armedTrigs.push({ track, scene })
  }

  /**
   * When the worklet posts a new bar, compute the audio-time of THAT bar's start
   * (which is ~now) and schedule any armed trigs. Because the worklet posts on the
   * bar boundary, scheduling at ctx.currentTime lands sample-accurately on the bar.
   */
  private flushArmedTrigs() {
    if (this.armedTrigs.length === 0 || !this.ctx) return
    // schedule slightly ahead (2ms) to cover message latency
    const when = this.ctx.currentTime + 0.002
    for (const trig of this.armedTrigs) {
      this.scheduleVoice(trig.track, trig.scene, when)
    }
    this.armedTrigs = []
  }

  private scheduleVoice(track: number, scene: number, when: number) {
    if (!this.ctx) return
    const key = `${track}:${scene}`
    const buf = this.soundBank.get(key)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.connect(this.trackGains[track] ?? this.masterGain!)
    src.start(when)
  }

  play(): void {
    if (!this.clockNode || !this.ctx) return
    if (this.ctx.state === 'suspended') this.ctx.resume()
    this.clockNode.port.postMessage({ kind: 'play' })
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

  /** Provenance for a sound (for PSYBUS compliance). */
  provenanceFor(track: number, scene: number) {
    return dspProvenance(`${track}:${scene}`)
  }
}

// ── Singleton (client-only) ──────────────────────────────────────────────────
let _engine: AudioEngine | null = null

export function getEngine(): AudioEngine {
  if (typeof window === 'undefined') {
    throw new Error('AudioEngine is browser-only (it owns an AudioContext)')
  }
  if (!_engine) {
    _engine = new AudioEngine()
  }
  return _engine
}
