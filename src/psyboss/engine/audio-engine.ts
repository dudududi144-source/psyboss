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
import { renderSoundBank, dspProvenance, TRACK_NAMES } from './dsp'
import { mulberry32 } from './rng'
import { collectScheduledSteps, type Pattern, type ParameterLock, STEPS_PER_BAR } from './sequencer'
import { sectionAtBar } from './song-structure'
import { SampleLibrary, type LoadedSample, type SampleMetadata, validateMetadata } from './sample-library'

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
  private delaySend: GainNode | null = null
  private reverbSend: GainNode | null = null
  private sidechainGain: GainNode | null = null
  private trackFilters: BiquadFilterNode[] = []
  private filterAutoEnabled = true
  private masterFilter: BiquadFilterNode | null = null
  private trackLFOOscs: OscillatorNode[] = []
  private trackLFODepthGains: GainNode[] = []
  private chorusSend: GainNode | null = null
  private chorusLFO: OscillatorNode | null = null
  private phaserSend: GainNode | null = null
  private phaserLFO: OscillatorNode | null = null
  private phaserFilters: BiquadFilterNode[] = []
  private exciterSend: GainNode | null = null
  private songMode = false
  private lastSectionIndex = -1

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

  private armedTrigs: Array<{ track: number; scene: number; immediate: boolean }> = []
  private activeVoices: Set<AudioBufferSourceNode> = new Set()
  private workletReady = false
  private busSubscribed = false
  private currentPattern: Pattern | null = null
  private sampleLibrary: SampleLibrary | null = null
  private lastScheduledBar: number = -1 // ROAST-4 #1: de-duplicate pattern scheduling per bar

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

  /**
   * Resolve a public-asset URL relative to the document base URI.
   * Handles the GitHub Pages basePath (/psyboss) transparently: on Pages the
   * baseURI already includes the subpath, so relative resolution lands on the
   * correct file. Locally the baseURI is the server root, so it resolves there.
   */
  private resolveAssetUrl(relativePath: string): string {
    if (typeof document === 'undefined') return '/' + relativePath
    let base = document.baseURI
    if (!base.endsWith('/')) base += '/'
    return new URL(relativePath, base).toString()
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

    // Resolve the worklet URL relative to the document base so it works both
    // locally (no basePath) and on GitHub Pages (basePath = /psyboss).
    // ROAST-6 #A fix: was hardcoded '/worklets/psyboss-clock.js' which 404s on
    // GitHub Pages because the absolute path ignores the /psyboss basePath.
    const workletUrl = this.resolveAssetUrl('worklets/psyboss-clock.js')
    await ctx.audioWorklet.addModule(workletUrl)
    this.workletReady = true

    // ── Master bus graph ──
    // trackGains[i] → masterGain → limiter → clockNode (passthrough+meter) → destination
    this.masterGain = ctx.createGain()
    this.masterGain.gain.value = 0.92

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

    // ── Sidechain bus (the classic psytrance pump) ──
    // Everything except the kick routes through sidechainGain. When a kick fires,
    // triggerSidechainDuck() momentarily dips this bus so the low end breathes
    // around each kick — THE defining dynamic of psytrance.
    this.sidechainGain = ctx.createGain()
    this.sidechainGain.gain.value = 1.0
    this.sidechainGain.connect(this.masterGain)

    // Per-track HIGH-PASS cutoffs (mixing cleanup): the low end belongs to the
    // kick + bass only. Everything else is HPF'd so the mix has no mud and the
    // low end stays tight and punchy — a core commercial-mixing technique.
    const HPF_HZ = [30, 40, 150, 200, 300, 120, 120, 100, 150, 200]

    for (let i = 0; i < TRACK_NAMES.length; i++) {
      const g = ctx.createGain()
      g.gain.value = 0.95
      // Per-track high-pass (mud removal).
      const hpf = ctx.createBiquadFilter()
      hpf.type = 'highpass'
      hpf.frequency.value = HPF_HZ[i] ?? 100
      hpf.Q.value = 0.707
      // Per-track lowpass for build-up/drop filter automation (commercial movement).
      const filt = ctx.createBiquadFilter()
      filt.type = 'lowpass'
      filt.frequency.value = 18000 // open by default
      filt.Q.value = 0.7
      g.connect(hpf)
      hpf.connect(filt)
      if (i === 0) {
        filt.connect(this.masterGain) // kick bypasses the sidechain
      } else {
        filt.connect(this.sidechainGain)
      }
      this.trackGains.push(g)
      this.trackFilters.push(filt)
      // Per-track filter LFO — adds movement to the sound (like Serum's LFOs).
      const lfo = ctx.createOscillator()
      lfo.frequency.value = 1
      const lfoDepth = ctx.createGain()
      lfoDepth.gain.value = 0 // off by default
      lfo.connect(lfoDepth)
      lfoDepth.connect(filt.frequency)
      lfo.start()
      this.trackLFOOscs.push(lfo)
      this.trackLFODepthGains.push(lfoDepth)
    }

    // ── Effects bus (modern production polish) ──
    // masterGain feeds the dry path AND two sends: a stereo tempo delay and a
    // convolver reverb. Both returns sum into the limiter so the whole mix is
    // glued + limited together — this is what makes it sound produced, not dry.
    // ── Master performance filter (real-time DJ-style sweep) ──
    // Everything (dry + delay + reverb) passes through this lowpass, so the
    // player can sweep the ENTIRE mix in real time. Open by default (19kHz).
    this.masterFilter = ctx.createBiquadFilter()
    this.masterFilter.type = 'lowpass'
    this.masterFilter.frequency.value = 19000
    this.masterFilter.Q.value = 0.5

    this.buildFxBus(ctx)

    this.masterGain.connect(this.masterFilter) // dry
    this.buildStereoWidener(ctx) // masterFilter -> mid/side widener -> limiter
    this.buildExtraFx(ctx) // chorus + phaser + exciter (off by default)
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

    // ── Initialize the sample library (for user-loaded samples) ──
    this.sampleLibrary = new SampleLibrary(ctx)

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
              // If transport was stopped when the trig arrived, mark it immediate so
              // flushArmedTrigs fires it NOW (not at the next bar boundary, which
              // would be 1.67s of silence). ROAST-2 #3 fix.
              this.armTrig(trackNum, sceneNum, !this.transport.playing)
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

  private armTrig(track: number, scene: number, immediate = false) {
    this.armedTrigs.push({ track, scene, immediate })
  }

  private scheduleVoice(track: number, scene: number, when: number, locks: ParameterLock[] = [], sampleRef?: SampleRef) {
    if (!this.ctx) return
    // Determine the buffer: external sample (if sampleRef provided) or procedural sound bank.
    let buf: AudioBuffer | undefined
    if (sampleRef && this.sampleLibrary) {
      const loaded = this.sampleLibrary.get(sampleRef.id)
      if (loaded) buf = loaded.buffer
    }
    if (!buf) {
      const key = `${track}:${scene}`
      buf = this.soundBank.get(key)
    }
    if (!buf) return

    // Sidechain: when a KICK fires, duck the rest of the mix (the psy pump).
    if (track === 0) {
      this.triggerSidechainDuck(when)
    }

    // Voice cap: steal the oldest voice if we'd exceed the limit.
    // ROAST-3 #6 fix: remove synchronously (was: async onended → size hit 65).
    if (this.activeVoices.size >= VOICE_CAP) {
      const oldest = this.activeVoices.values().next().value
      if (oldest) {
        this.activeVoices.delete(oldest) // synchronous removal
        try { oldest.stop() } catch { /* already stopped */ }
        try { oldest.disconnect() } catch { /* already disconnected */ }
      }
    }

    const src = this.ctx.createBufferSource()
    src.buffer = buf

    // Apply parameter locks (ROAST-3 #3 fix: was silently dropped in live path).
    // Supported: 'gain' → per-voice GainNode, 'pitch' → playbackRate, 'scene' → buffer lookup.
    const gainLock = locks.find((l) => l.param === 'gain')
    const pitchLock = locks.find((l) => l.param === 'pitch')
    const sceneLock = locks.find((l) => l.param === 'scene')

    // Scene override: use a different buffer if the lock specifies one.
    if (sceneLock) {
      const altKey = `${track}:${Math.round(sceneLock.value)}`
      const altBuf = this.soundBank.get(altKey)
      if (altBuf) src.buffer = altBuf
    }

    // Pitch override via playbackRate.
    if (pitchLock) {
      src.playbackRate.value = Math.max(0.25, Math.min(4, pitchLock.value))
    }

    // Gain override via per-voice GainNode.
    if (gainLock) {
      const gainNode = this.ctx.createGain()
      gainNode.gain.value = gainLock.value
      src.connect(gainNode)
      gainNode.connect(this.trackGains[track] ?? this.masterGain!)
    } else {
      src.connect(this.trackGains[track] ?? this.masterGain!)
    }

    this.activeVoices.add(src)
    src.onended = () => {
      this.activeVoices.delete(src)
      try { src.disconnect() } catch { /* already disconnected */ }
    }
    try {
      src.start(when)
    } catch {
      try { src.start() } catch { /* give up */ }
      this.activeVoices.delete(src)
      try { src.disconnect() } catch { /* already disconnected */ }
    }
  }

  play(): void {
    if (!this.clockNode || !this.ctx) return
    if (this.ctx.state === 'suspended') this.ctx.resume()
    this.lastScheduledBar = -1 // ROAST-4 #1: reset so bar 0 gets scheduled on play
    this.clockNode.port.postMessage({ kind: 'play' })
    this.transport = { ...this.transport, playing: true }
    this.emitTransport()
  }

  stop(): void {
    if (!this.clockNode) return
    this.clockNode.port.postMessage({ kind: 'stop' })
    this.transport = { ...this.transport, playing: false }
    this.armedTrigs = []
    this.lastScheduledBar = -1 // ROAST-4 #1: reset for next play
    this.emitTransport()
  }

  setBpm(bpm: number): void {
    if (!this.clockNode) return
    this.clockNode.port.postMessage({ kind: 'setBpm', bpm })
    this.transport = { ...this.transport, bpm }
    this.emitTransport()
  }

  /**
   * Real-time master performance filter — sweeps the ENTIRE mix (dry + FX).
   * 19000 = fully open. Smoothed via setTargetAtTime for musical sweeps.
   */
  setMasterFilter(hz: number): void {
    if (!this.ctx || !this.masterFilter) return
    const clamped = Math.max(60, Math.min(19000, hz))
    this.masterFilter.frequency.setTargetAtTime(clamped, this.ctx.currentTime, 0.02)
  }

  /**
   * Song mode: when ON, the engine applies the SONG_STRUCTURE arc live —
   * muting/unmuting tracks per section so the set evolves like a real track.
   * When OFF, all tracks play at their normal level.
   */
  setSongMode(on: boolean): void {
    this.songMode = on
    this.lastSectionIndex = -1 // force re-evaluation on next bar
    if (!on && this.ctx) {
      // Restore all track gains to normal.
      for (const g of this.trackGains) {
        g.gain.setTargetAtTime(0.95, this.ctx.currentTime, 0.05)
      }
    }
  }

  isSongMode(): boolean {
    return this.songMode
  }

  /**
   * PERFORMANCE: play a pitched note on a track live (playable keyboard).
   * Plays the track's root buffer (scene 0) at a pitch-shifted playbackRate,
   * so any chromatic note is reachable from the one rendered buffer. semitones
   * is the offset from the track's root (0 = root, +12 = one octave up).
   */
  playNote(track: number, semitones: number, velocity: number = 0.8): void {
    if (!this.ctx) return
    const buf = this.soundBank.get(`${track}:0`)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = Math.pow(2, semitones / 12)
    const gain = this.ctx.createGain()
    gain.gain.value = Math.max(0, Math.min(1, velocity))
    src.connect(gain)
    gain.connect(this.trackGains[track] ?? this.masterGain!)
    if (this.activeVoices.size >= VOICE_CAP) {
      const oldest = this.activeVoices.values().next().value
      if (oldest) {
        this.activeVoices.delete(oldest)
        try { oldest.stop() } catch { /* already stopped */ }
        try { oldest.disconnect() } catch { /* already disconnected */ }
      }
    }
    this.activeVoices.add(src)
    src.onended = () => {
      this.activeVoices.delete(src)
      try { src.disconnect() } catch { /* already disconnected */ }
    }
    src.start()
    // A played kick should also pump the mix.
    if (track === 0 && this.ctx) {
      this.triggerSidechainDuck(this.ctx.currentTime)
    }
  }

  /**
   * PERFORMANCE + MORPHING: play two scenes of a track crossfaded by `morph`.
   * morph=0 -> scene 0 only, morph=1 -> scene 1 only, in between -> crossfade.
   * This is the Octatrack-style crossfader: blend between two scene sounds in
   * real time. Both buffers play at the same pitch (semitones), gains crossfaded.
   */
  playMorph(track: number, semitones: number, morph: number, velocity: number = 0.8): void {
    if (!this.ctx) return
    const m = Math.max(0, Math.min(1, morph))
    const bufA = this.soundBank.get(`${track}:0`)
    const bufB = this.soundBank.get(`${track}:1`)
    const vel = Math.max(0, Math.min(1, velocity))
    const rate = Math.pow(2, semitones / 12)
    const dest = this.trackGains[track] ?? this.masterGain!

    const spawn = (buf: AudioBuffer | undefined, gainVal: number) => {
      if (!buf || gainVal < 0.001) return
      if (this.activeVoices.size >= VOICE_CAP) {
        const oldest = this.activeVoices.values().next().value
        if (oldest) {
          this.activeVoices.delete(oldest)
          try { oldest.stop() } catch { /* already stopped */ }
          try { oldest.disconnect() } catch { /* already disconnected */ }
        }
      }
      const src = this.ctx!.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = rate
      const g = this.ctx!.createGain()
      g.gain.value = gainVal
      src.connect(g)
      g.connect(dest)
      this.activeVoices.add(src)
      src.onended = () => {
        this.activeVoices.delete(src)
        try { src.disconnect() } catch { /* already disconnected */ }
      }
      src.start()
    }

    spawn(bufA, (1 - m) * vel)
    spawn(bufB, m * vel)
    if (track === 0 && this.ctx) {
      this.triggerSidechainDuck(this.ctx.currentTime)
    }
  }

  /**
   * PERFORMANCE + SLICING: play a specific slice of a loaded sample.
   * Cuts the sample into numSlices equal parts on the fly and plays sliceIndex.
   * This is the Octatrack-style slice playback for fills, breaks, and stutters.
   */
  playSlice(sampleId: string, sliceIndex: number, numSlices: number, velocity: number = 0.8): void {
    if (!this.ctx || !this.sampleLibrary) return
    const loaded = this.sampleLibrary.get(sampleId)
    if (!loaded) return
    const buffer = loaded.buffer
    const totalFrames = buffer.length
    const n = Math.max(1, Math.floor(numSlices))
    const idx = Math.max(0, Math.min(n - 1, Math.floor(sliceIndex)))
    const framesPerSlice = Math.floor(totalFrames / n)
    const startFrame = idx * framesPerSlice
    const endFrame = idx === n - 1 ? totalFrames : (idx + 1) * framesPerSlice
    const sliceFrames = Math.max(1, endFrame - startFrame)

    const sliceBuffer = this.ctx.createBuffer(buffer.numberOfChannels, sliceFrames, buffer.sampleRate)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const srcData = buffer.getChannelData(ch)
      const sliceData = sliceBuffer.getChannelData(ch)
      for (let f = 0; f < sliceFrames; f++) {
        sliceData[f] = srcData[startFrame + f] ?? 0
      }
    }

    if (this.activeVoices.size >= VOICE_CAP) {
      const oldest = this.activeVoices.values().next().value
      if (oldest) {
        this.activeVoices.delete(oldest)
        try { oldest.stop() } catch { /* already stopped */ }
        try { oldest.disconnect() } catch { /* already disconnected */ }
      }
    }
    const src = this.ctx.createBufferSource()
    src.buffer = sliceBuffer
    const gain = this.ctx.createGain()
    gain.gain.value = Math.max(0, Math.min(1, velocity))
    src.connect(gain)
    gain.connect(this.masterGain!)
    this.activeVoices.add(src)
    src.onended = () => {
      this.activeVoices.delete(src)
      try { src.disconnect() } catch { /* already disconnected */ }
    }
    src.start()
  }

  /** PERFORMANCE: per-track volume (live mixing fader). */
  setTrackVolume(track: number, volume: number): void {
    if (!this.ctx || !this.trackGains[track]) return
    const v = Math.max(0, Math.min(1, volume))
    this.trackGains[track].gain.setTargetAtTime(v, this.ctx.currentTime, 0.02)
  }

  /** PERFORMANCE: per-track mute/solo (live mixing). */
  setTrackMute(track: number, muted: boolean): void {
    if (!this.ctx || !this.trackGains[track]) return
    const target = muted ? 0.0001 : 0.95
    this.trackGains[track].gain.setTargetAtTime(target, this.ctx.currentTime, 0.02)
  }

  /**
   * MODULATION: per-track filter LFO. Modulates the track's lowpass cutoff with
   * an LFO — the movement that makes electronic sounds come alive (à la Serum).
   * rate in Hz, depthPct 0-100 (0 = off). Depth maps to +/-5000 Hz of cutoff swing.
   */
  setTrackLFO(track: number, rate: number, depthPct: number): void {
    if (!this.ctx) return
    const lfo = this.trackLFOOscs[track]
    const depth = this.trackLFODepthGains[track]
    if (!lfo || !depth) return
    lfo.frequency.setTargetAtTime(Math.max(0.05, rate), this.ctx.currentTime, 0.02)
    const depthHz = (Math.max(0, Math.min(100, depthPct)) / 100) * 5000
    depth.gain.setTargetAtTime(depthHz, this.ctx.currentTime, 0.02)
  }

  /** Set the current pattern for sequencer playback. null = scene-matrix only. */
  setPattern(pattern: Pattern | null): void {
    this.currentPattern = pattern
  }

  getPattern(): Pattern | null {
    return this.currentPattern
  }

  /**
   * Build the effects bus: a stereo tempo delay (damped feedback, ping-pong-ish)
   * and a convolver reverb, both summed into the limiter. This is the production
   * polish that turns dry one-shots into a spacious, glued mix.
   */
  private buildFxBus(ctx: AudioContext): void {
    // ── Stereo tempo delay ──
    // Two delays at related times (3:4) for rhythmic stereo movement. Feedback
    // loops run through a lowpass so repeats get darker (classic psy technique).
    this.delaySend = ctx.createGain()
    this.delaySend.gain.value = 0.26
    const dTime = 0.34
    const delayL = ctx.createDelay(2.0)
    delayL.delayTime.value = dTime
    const delayR = ctx.createDelay(2.0)
    delayR.delayTime.value = dTime * 0.75
    const fbL = ctx.createGain()
    fbL.gain.value = 0.38
    const fbR = ctx.createGain()
    fbR.gain.value = 0.38
    const dampL = ctx.createBiquadFilter()
    dampL.type = 'lowpass'
    dampL.frequency.value = 2800
    const dampR = ctx.createBiquadFilter()
    dampR.type = 'lowpass'
    dampR.frequency.value = 2800

    this.masterGain!.connect(this.delaySend)
    this.delaySend.connect(delayL)
    this.delaySend.connect(delayR)
    delayL.connect(dampL)
    dampL.connect(fbL)
    fbL.connect(delayL)
    delayR.connect(dampR)
    dampR.connect(fbR)
    fbR.connect(delayR)
    const delayMerge = ctx.createChannelMerger(2)
    delayL.connect(delayMerge, 0, 0)
    delayR.connect(delayMerge, 0, 1)
    delayMerge.connect(this.masterFilter!)

    // ── Convolver reverb (deterministic generated IR) ──
    this.reverbSend = ctx.createGain()
    this.reverbSend.gain.value = 0.16
    const convolver = ctx.createConvolver()
    convolver.buffer = this.createReverbIR(ctx, 2.4)
    this.masterGain!.connect(this.reverbSend)
    this.reverbSend.connect(convolver)
    convolver.connect(this.masterFilter!)
  }

  /**
   * Sidechain pump: dip the non-kick bus when a kick fires, then recover.
   * Fast attack (~8ms duck), musical release back to unity.
   */
  private triggerSidechainDuck(atTime: number): void {
    if (!this.ctx || !this.sidechainGain) return
    const g = this.sidechainGain.gain
    g.cancelScheduledValues(atTime)
    g.setValueAtTime(1.0, atTime)
    g.linearRampToValueAtTime(0.35, atTime + 0.008)
    g.setTargetAtTime(1.0, atTime + 0.04, 0.08)
  }

  /**
   * Mid/side STEREO WIDENER (frequency-dependent, mastering-grade).
   * Splits the mix into mid (L+R) and side (L-R), high-passes the side so the
   * BASS STAYS MONO (essential for club playback), then boosts the side to widen
   * the highs/mids. This is the stereo polish that makes a mix sound professional.
   */
  private buildStereoWidener(ctx: AudioContext): void {
    const WIDTH = 1.3 // side boost factor (>1 = wider)
    const SIDE_HPF_HZ = 200 // below this, keep mono (bass/kick centered)

    const splitter = ctx.createChannelSplitter(2)
    const merger = ctx.createChannelMerger(2)

    const midL = ctx.createGain(); midL.gain.value = 0.5
    const midR = ctx.createGain(); midR.gain.value = 0.5
    const sideL = ctx.createGain(); sideL.gain.value = 0.5
    const sideR = ctx.createGain(); sideR.gain.value = -0.5

    this.masterFilter!.connect(splitter)
    splitter.connect(midL, 0)
    splitter.connect(midR, 1)
    splitter.connect(sideL, 0)
    splitter.connect(sideR, 1)

    const midSum = ctx.createGain()
    midL.connect(midSum)
    midR.connect(midSum)

    const sideSum = ctx.createGain()
    sideL.connect(sideSum)
    sideR.connect(sideSum)

    const sideHPF = ctx.createBiquadFilter()
    sideHPF.type = 'highpass'
    sideHPF.frequency.value = SIDE_HPF_HZ
    const widthGain = ctx.createGain()
    widthGain.gain.value = WIDTH
    sideSum.connect(sideHPF)
    sideHPF.connect(widthGain)

    const outL = ctx.createGain()
    const outR = ctx.createGain()
    const sideInvert = ctx.createGain(); sideInvert.gain.value = -1
    midSum.connect(outL)
    widthGain.connect(outL)
    midSum.connect(outR)
    widthGain.connect(sideInvert)
    sideInvert.connect(outR)

    outL.connect(merger, 0, 0)
    outR.connect(merger, 0, 1)
    merger.connect(this.limiter!)
  }

  /**
   * EXTRA FX — chorus, phaser, exciter (all off by default, user-controlled).
   * These add the polish/movement that separates a demo from a produced track.
   * All route into masterFilter so they pass through the widener + limiter.
   */
  private buildExtraFx(ctx: AudioContext): void {
    // ── Chorus: delayed copy with LFO-modulated delay time (thickens the sound) ──
    this.chorusSend = ctx.createGain()
    this.chorusSend.gain.value = 0
    const chorusDelay = ctx.createDelay(0.1)
    chorusDelay.delayTime.value = 0.02
    this.chorusLFO = ctx.createOscillator()
    this.chorusLFO.frequency.value = 0.5
    const chorusLFODepth = ctx.createGain()
    chorusLFODepth.gain.value = 0.004
    this.chorusLFO.connect(chorusLFODepth)
    chorusLFODepth.connect(chorusDelay.delayTime)
    this.chorusLFO.start()
    this.masterGain!.connect(this.chorusSend)
    this.chorusSend.connect(chorusDelay)
    chorusDelay.connect(this.masterFilter!)

    // ── Phaser: 4 cascaded allpass filters swept by an LFO ──
    this.phaserSend = ctx.createGain()
    this.phaserSend.gain.value = 0
    let phaserNode: AudioNode = this.phaserSend
    this.phaserFilters = []
    for (let i = 0; i < 4; i++) {
      const ap = ctx.createBiquadFilter()
      ap.type = 'allpass'
      ap.frequency.value = 400 + i * 400
      ap.Q.value = 1
      phaserNode.connect(ap)
      phaserNode = ap
      this.phaserFilters.push(ap)
    }
    this.phaserLFO = ctx.createOscillator()
    this.phaserLFO.frequency.value = 0.3
    const phaserLFODepth = ctx.createGain()
    phaserLFODepth.gain.value = 300
    this.phaserLFO.connect(phaserLFODepth)
    for (const ap of this.phaserFilters) {
      phaserLFODepth.connect(ap.frequency)
    }
    this.phaserLFO.start()
    this.masterGain!.connect(this.phaserSend)
    phaserNode.connect(this.masterFilter!)

    // ── Exciter: high-passed harmonics with tanh drive (adds air/shine) ──
    this.exciterSend = ctx.createGain()
    this.exciterSend.gain.value = 0
    const exciterHPF = ctx.createBiquadFilter()
    exciterHPF.type = 'highpass'
    exciterHPF.frequency.value = 3000
    const exciterShaper = ctx.createWaveShaper()
    exciterShaper.curve = this.makeDriveCurve()
    this.masterGain!.connect(this.exciterSend)
    this.exciterSend.connect(exciterHPF)
    exciterHPF.connect(exciterShaper)
    exciterShaper.connect(this.masterFilter!)
  }

  /** Symmetric tanh drive curve for the exciter. */
  private makeDriveCurve(): Float32Array<ArrayBuffer> {
    const n = 1024
    const curve = new Float32Array(new ArrayBuffer(n * 4))
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.tanh(x * 3)
    }
    return curve
  }

  /** Set chorus send amount (0-1) + LFO rate. */
  setChorus(amount: number, rate: number = 0.5): void {
    if (!this.ctx || !this.chorusSend) return
    this.chorusSend.gain.setTargetAtTime(Math.max(0, Math.min(1, amount)), this.ctx.currentTime, 0.02)
    if (this.chorusLFO) this.chorusLFO.frequency.setTargetAtTime(rate, this.ctx.currentTime, 0.02)
  }

  /** Set phaser send amount (0-1) + LFO rate. */
  setPhaser(amount: number, rate: number = 0.3): void {
    if (!this.ctx || !this.phaserSend) return
    this.phaserSend.gain.setTargetAtTime(Math.max(0, Math.min(1, amount)), this.ctx.currentTime, 0.02)
    if (this.phaserLFO) this.phaserLFO.frequency.setTargetAtTime(rate, this.ctx.currentTime, 0.02)
  }

  /** Set exciter send amount (0-1). Adds high-frequency harmonics/shine. */
  setExciter(amount: number): void {
    if (!this.ctx || !this.exciterSend) return
    this.exciterSend.gain.setTargetAtTime(Math.max(0, Math.min(1, amount)), this.ctx.currentTime, 0.02)
  }

  /**
   * Generate a deterministic stereo reverb impulse response (decaying noise). */
  private createReverbIR(ctx: AudioContext, duration: number): AudioBuffer {
    const rate = ctx.sampleRate
    const length = Math.floor(rate * duration)
    const impulse = ctx.createBuffer(2, length, rate)
    const rng = mulberry32((0x5eed ^ this.seed) >>> 0)
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch)
      for (let i = 0; i < length; i++) {
        const decay = Math.pow(1 - i / length, 2.8)
        data[i] = (rng() * 2 - 1) * decay * 0.5
      }
    }
    return impulse
  }

  /** Get the sample library (for UI to add/list samples). */
  getSampleLibrary(): SampleLibrary | null {
    return this.sampleLibrary
  }

  /**
   * Load a sample file with license metadata. Returns a SampleRef that can be
   * used in a `trig` envelope. The provenance gate will validate it at publish time.
   *
   * ROAST-4 #3 fix: validateMetadata is now called here (was: dead code, only
   * called from tests — the exact psy-sampler addFromBuffer hole PSYBOSS's own
   * ROAST.md documents).
   */
  async loadSample(file: File, metadata: SampleMetadata): Promise<SampleRef> {
    if (!this.sampleLibrary) throw new Error('Engine not initialized')
    const errors = validateMetadata(metadata)
    if (errors.length > 0) {
      throw new Error(`Invalid sample metadata: ${errors.join(', ')}`)
    }
    return this.sampleLibrary.add(file, metadata)
  }

  /** List loaded samples (for UI display). */
  listSamples(): LoadedSample[] {
    return this.sampleLibrary?.list() ?? []
  }

  /**
   * Schedule armed trigs + pattern steps.
   *
   * ROAST-4 #1 fix: the ROAST-3 #1 (bar-0 scheduling) and #2 (16th-note posts) fixes
   * CONFLICTED — flushArmedTrigs ran on every 16th-note post, re-scheduling the whole
   * bar 16× with drifting audioTime (which was a 16th boundary, not a bar boundary).
   * Result: 2048 voices/bar vs cap 64 = 1984 stolen.
   *
   * Fix: track `lastScheduledBar`. Pattern scheduling only runs ONCE per bar (when
   * `transport.bar` changes). The 16th-note posts still update the UI highlight via
   * the transport listener, but flushArmedTrigs skips pattern scheduling if the bar
   * hasn't changed. armedTrigs (scene-matrix clicks) still flush on every post.
   */
  private flushArmedTrigs() {
    if (!this.ctx) return
    if (this.armedTrigs.length === 0 && !this.currentPattern) return
    const secPerBar = (60 / this.transport.bpm) * BEATS_PER_BAR
    const stepSeconds = secPerBar / STEPS_PER_BAR
    const now = this.ctx.currentTime
    const quantumSec = 128 / this.ctx.sampleRate

    // Immediate trigs (from scene-matrix clicks while stopped).
    for (const trig of this.armedTrigs) {
      if (!trig.immediate) continue
      const safeWhen = Math.max(now + 0.005, now + quantumSec)
      this.scheduleVoice(trig.track, trig.scene, safeWhen)
    }

    // Quantized armed trigs (scene-matrix clicks while playing) → next bar boundary.
    // ROAST-5 #A fix: barStartTime = transport.audioTime (the audio-context time at the
    // bar boundary, posted by the worklet). Was: transport.bar * secPerBar — WRONG because
    // transport.bar is a counter, not an audio-context time. That made all steps play at
    // the downbeat (clamped by Web Audio), not at their 16th-note positions.
    const barStartTime = this.transport.audioTime
    const nextBarTime = barStartTime + secPerBar
    const safeNextBar = Math.max(nextBarTime, now + quantumSec)
    for (const trig of this.armedTrigs) {
      if (trig.immediate) continue
      this.scheduleVoice(trig.track, trig.scene, safeNextBar)
    }
    this.armedTrigs = []

    // Pattern playback: ONLY schedule when a NEW bar has arrived (de-duplicate)
    // AND transport is actually playing. ROAST-6 #1 fix: was missing the playing
    // guard — stop() posts transport (playing=false) which triggered flushArmedTrigs,
    // which scheduled 2 bars of voices because currentPattern was still set.
    if (this.currentPattern && this.transport.playing && this.transport.bar !== this.lastScheduledBar) {
      const currentBar = this.transport.bar
      this.lastScheduledBar = currentBar

      // ── Song mode: apply the section arc (mute/unmute tracks per section) ──
      if (this.songMode && this.ctx) {
        const { activeTracks, sectionIndex } = sectionAtBar(currentBar)
        if (sectionIndex !== this.lastSectionIndex) {
          this.lastSectionIndex = sectionIndex
          for (let i = 0; i < this.trackGains.length; i++) {
            const target = activeTracks.has(i) ? 0.95 : 0.001
            this.trackGains[i].gain.setTargetAtTime(target, this.ctx.currentTime, 0.08)
          }
        }
      }

      // ── Filter automation: the commercial build-up/drop movement ──
      // Every 8-bar phrase the LEAD filter sweeps open over the first 4 bars
      // (build-up tension) then stays open for 4 bars (release). This is the
      // evolving motion that separates a static loop from a living psytrance track.
      if (this.filterAutoEnabled && this.trackFilters.length > 2) {
        const PHRASE = 8
        const barInPhrase = currentBar % PHRASE
        if (barInPhrase === 0) {
          const leadFilter = this.trackFilters[2] // LEAD
          const openHz = 18000
          const closedHz = 700
          leadFilter.frequency.cancelScheduledValues(barStartTime)
          leadFilter.frequency.setValueAtTime(closedHz, barStartTime)
          leadFilter.frequency.exponentialRampToValueAtTime(openHz, barStartTime + secPerBar * 4)
          leadFilter.frequency.setValueAtTime(openHz, barStartTime + secPerBar * 4)
          // Bass gets a gentler opening so the low end breathes without losing weight.
          const bassFilter = this.trackFilters[1]
          bassFilter.frequency.cancelScheduledValues(barStartTime)
          bassFilter.frequency.setValueAtTime(900, barStartTime)
          bassFilter.frequency.exponentialRampToValueAtTime(12000, barStartTime + secPerBar * 4)
          bassFilter.frequency.setValueAtTime(12000, barStartTime + secPerBar * 4)
        }
      }

      // Current bar (bar N): schedule steps from barStartTime onward.
      // Steps already in the past (we're mid-bar) are skipped.
      const currentBarScheduled = collectScheduledSteps(
        this.currentPattern,
        0,
        STEPS_PER_BAR,
        currentBar,
        stepSeconds,
        barStartTime,
        this.seed,
      )
      for (const s of currentBarScheduled) {
        if (s.audioTime >= now - quantumSec) {
          this.scheduleVoice(s.track, s.scene, Math.max(s.audioTime, now + quantumSec), s.locks, s.sampleRef)
        }
      }

      // Next bar (bar N+1): schedule the full bar ahead.
      const nextBar = currentBar + 1
      const nextBarScheduled = collectScheduledSteps(
        this.currentPattern,
        0,
        STEPS_PER_BAR,
        nextBar,
        stepSeconds,
        nextBarTime,
        this.seed,
      )
      for (const s of nextBarScheduled) {
        this.scheduleVoice(s.track, s.scene, s.audioTime, s.locks, s.sampleRef)
      }
    }
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
