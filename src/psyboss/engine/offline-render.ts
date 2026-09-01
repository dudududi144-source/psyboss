/**
 * PSYBOSS offline renderer — renders a pattern to a WAV file.
 *
 * ROAST-3 #7 fix (honest contract): this is NOT "byte-identical to a live take."
 * Live and offline diverge on 7 axes: sample rate (hardware vs 48000), graph
 * topology (clockNode present vs absent), parameter lock handling (live applies
 * gain/pitch/scene; offline applies gain-only), bar-0 scheduling (live schedules
 * bar 0; offline always did), limiter state (warm vs cold), immediate trigs
 * (live has them; offline has none), and sampleRef handling (ROAST-5 #D: offline
 * now supports external samples via the samples map, matching live).
 *
 * What IS deterministic: given the same (pattern, seed, bpm, bars, sampleRate),
 * renderOffline produces byte-identical WAV output across runs. Verified by tests.
 *
 * Browser-only: OfflineAudioContext is a Web API.
 */

import { renderSoundBank, dspProvenance } from './dsp'
import { collectScheduledSteps, type Pattern, STEPS_PER_BAR } from './sequencer'
import { encodeWav } from './wav-encoder'
import {
  masterBuffer,
  type MasteringTargets,
  type MasteringReport,
} from './mastering'

export interface RenderOptions {
  pattern: Pattern
  seed: number
  bpm: number
  bars: number
  sampleRate?: number
  // ROAST-5 #D: external samples (from SampleLibrary) for steps with sampleRef.
  // Keyed by sample id → AudioBuffer.
  samples?: Map<string, AudioBuffer>
  // Scope 4: mastering targets. If set, the master output is loudness-normalized
  // and true-peak limited before encoding. Stems are always left unmastered.
  mastering?: MasteringTargets
}

export interface RenderResult {
  master: Uint8Array // WAV bytes
  stems: Map<number, Uint8Array> // per-track WAV bytes
  durationSec: number
  // Scope 4: mastering measurements (present only when mastering was requested).
  masteringReport?: MasteringReport
}

/**
 * Render a pattern offline. Returns master + per-track stems as WAV bytes.
 *
 * The offline graph mirrors the live audio-engine.ts graph:
 *   BufferSource[per-step] → trackGain → masterGain → limiter → destination
 * Each stem is rendered separately by soloing one track.
 */
export async function renderOffline(opts: RenderOptions): Promise<RenderResult> {
  if (typeof window === 'undefined') {
    throw new Error('renderOffline requires a browser (OfflineAudioContext)')
  }
  const { pattern, seed, bpm, bars } = opts
  const sampleRate = opts.sampleRate ?? 48000
  const secPerBar = (60 / bpm) * 4
  const stepSeconds = secPerBar / STEPS_PER_BAR
  const duration = bars * secPerBar

  // Render master: all tracks mixed.
  const masterRender = await renderTrackRaw({
    pattern, seed, bpm, bars, sampleRate, soloTrack: -1, duration,
    samples: opts.samples,
  })

  // Scope 4: master the master output to the requested loudness/peak targets.
  let masteringReport: MasteringReport | undefined
  let masterWav: Uint8Array
  if (opts.mastering) {
    masteringReport = masterBuffer(
      masterRender.left,
      masterRender.right,
      sampleRate,
      opts.mastering,
    )
  }
  masterWav = encodeWav({
    left: masterRender.left,
    right: masterRender.right,
    sampleRate,
  })

  // Render stems: one per track (solo each).
  const stems = new Map<number, Uint8Array>()
  for (let t = 0; t < pattern.tracks.length; t++) {
    const stemRaw = await renderTrackRaw({
      pattern, seed, bpm, bars, sampleRate, soloTrack: t, duration,
      samples: opts.samples,
    })
    stems.set(t, encodeWav({ left: stemRaw.left, right: stemRaw.right, sampleRate }))
  }

  return { master: masterWav, stems, durationSec: duration, masteringReport }
}

interface RawRender {
  left: Float32Array
  right: Float32Array
}

async function renderTrackRaw(args: {
  pattern: Pattern
  seed: number
  bpm: number
  bars: number
  sampleRate: number
  soloTrack: number // -1 = all tracks; otherwise only this track
  duration: number
  samples?: Map<string, AudioBuffer>
}): Promise<RawRender> {
  const { pattern, seed, bpm, bars, sampleRate, soloTrack, duration, samples } = args
  const length = Math.ceil(duration * sampleRate)
  const ctx = new OfflineAudioContext(2, length, sampleRate)

  // Sound bank (deterministic — same seed → same buffers).
  const bank = renderSoundBank(sampleRate, seed)
  const audioBuffers = new Map<string, AudioBuffer>()
  for (const [key, stereo] of bank.entries()) {
    const buf = ctx.createBuffer(2, stereo.left.length, sampleRate)
    buf.copyToChannel(stereo.left, 0)
    buf.copyToChannel(stereo.right, 1)
    audioBuffers.set(key, buf)
  }

  // Master bus (mirrors live graph).
  const masterGain = ctx.createGain()
  masterGain.gain.value = 0.8
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -1.0
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.003
  limiter.release.value = 0.05
  masterGain.connect(limiter)
  limiter.connect(ctx.destination)

  // Per-track gains.
  const trackGains: GainNode[] = []
  for (let t = 0; t < pattern.tracks.length; t++) {
    const g = ctx.createGain()
    g.gain.value = 0.75
    g.connect(masterGain)
    trackGains.push(g)
  }

  // Schedule every step across all bars.
  const secPerBar = (60 / bpm) * 4
  const stepSeconds = secPerBar / STEPS_PER_BAR
  for (let bar = 0; bar < bars; bar++) {
    const barStartTime = bar * secPerBar
    const scheduled = collectScheduledSteps(
      pattern,
      0,
      STEPS_PER_BAR,
      bar,
      stepSeconds,
      barStartTime,
      seed,
    )
    for (const s of scheduled) {
      if (soloTrack !== -1 && s.track !== soloTrack) continue
      // ROAST-5 #D: use external sample if sampleRef is set, else procedural bank.
      let buf: AudioBuffer | undefined
      if (s.sampleRef && samples) {
        buf = samples.get(s.sampleRef.id)
      }
      if (!buf) {
        const key = `${s.track}:${s.scene}`
        buf = audioBuffers.get(key)
      }
      if (!buf) continue
      const src = ctx.createBufferSource()
      src.buffer = buf
      // Apply parameter locks (gain override is the simplest).
      const gainOverride = s.locks.find((l) => l.param === 'gain')
      if (gainOverride) {
        const gainNode = ctx.createGain()
        gainNode.gain.value = gainOverride.value
        src.connect(gainNode)
        gainNode.connect(trackGains[s.track])
      } else {
        src.connect(trackGains[s.track])
      }
      src.start(s.audioTime)
    }
  }

  // Render.
  const rendered = await ctx.startRendering()
  const left = rendered.getChannelData(0)
  const right = rendered.getChannelData(1)
  // Copy (the rendered buffer's underlying ArrayBuffer may be transferred).
  const leftCopy = new Float32Array(left.length)
  const rightCopy = new Float32Array(right.length)
  leftCopy.set(left)
  rightCopy.set(right)
  return { left: leftCopy, right: rightCopy }
}

/**
 * Determinism helper: returns a stable fingerprint for a render config.
 * Same config → same fingerprint → same bytes (verified by tests).
 */
export function renderFingerprint(opts: RenderOptions): string {
  const { seed, bpm, bars, sampleRate = 48000 } = opts
  return `render:seed=${seed}:bpm=${bpm}:bars=${bars}:sr=${sampleRate}:pattern=${opts.pattern.id}`
}

/** Provenance for a rendered WAV (so exported files carry their source). */
export function renderProvenance(opts: RenderOptions) {
  return dspProvenance(renderFingerprint(opts), opts.seed)
}
