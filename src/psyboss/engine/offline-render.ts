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
import { mulberry32 } from './rng'
import { collectScheduledSteps, type Pattern, STEPS_PER_BAR } from './sequencer'
import { encodeWav } from './wav-encoder'
import {
  masterBuffer,
  type MasteringTargets,
  type MasteringReport,
} from './mastering'
import type { Arrangement } from './arrangement'

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
  // +1.6s tail so the delay/reverb tails of the last hits ring out naturally.
  const FX_TAIL_SEC = 1.6
  const length = Math.ceil((duration + FX_TAIL_SEC) * sampleRate)
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
  masterGain.gain.value = 0.92
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -1.0
  limiter.knee.value = 0
  limiter.ratio.value = 20
  limiter.attack.value = 0.003
  limiter.release.value = 0.05
  masterGain.connect(limiter) // dry

  // ── Effects bus (mirror of the live audio-engine graph) ──
  // Stereo tempo delay + convolver reverb, summed into the limiter so the
  // exported WAV sounds produced and spacious, not dry.
  const delaySend = ctx.createGain()
  delaySend.gain.value = 0.26
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
  masterGain.connect(delaySend)
  delaySend.connect(delayL)
  delaySend.connect(delayR)
  delayL.connect(dampL)
  dampL.connect(fbL)
  fbL.connect(delayL)
  delayR.connect(dampR)
  dampR.connect(fbR)
  fbR.connect(delayR)
  const delayMerge = ctx.createChannelMerger(2)
  delayL.connect(delayMerge, 0, 0)
  delayR.connect(delayMerge, 0, 1)
  delayMerge.connect(limiter)

  const reverbSend = ctx.createGain()
  reverbSend.gain.value = 0.16
  const convolver = ctx.createConvolver()
  convolver.buffer = makeReverbIR(ctx, 2.4, seed)
  masterGain.connect(reverbSend)
  reverbSend.connect(convolver)
  convolver.connect(limiter)

  limiter.connect(ctx.destination)

  // Per-track gains + sidechain bus (mirror of the live audio-engine).
  const sidechainGain = ctx.createGain()
  sidechainGain.gain.value = 1.0
  sidechainGain.connect(masterGain)
  const trackGains: GainNode[] = []
  const trackFilters: BiquadFilterNode[] = []
  // Per-track high-pass cutoffs (mirror of live engine) — low end = kick+bass only.
  const HPF_HZ = [30, 40, 150, 200, 300, 120, 120, 100, 150, 200]
  for (let t = 0; t < pattern.tracks.length; t++) {
    const g = ctx.createGain()
    g.gain.value = 0.95
    const hpf = ctx.createBiquadFilter()
    hpf.type = 'highpass'
    hpf.frequency.value = HPF_HZ[t] ?? 100
    hpf.Q.value = 0.707
    const filt = ctx.createBiquadFilter()
    filt.type = 'lowpass'
    filt.frequency.value = 18000
    filt.Q.value = 0.7
    g.connect(hpf)
    hpf.connect(filt)
    if (t === 0) {
      filt.connect(masterGain) // kick bypasses the sidechain
    } else {
      filt.connect(sidechainGain)
    }
    trackGains.push(g)
    trackFilters.push(filt)
  }

  // Schedule every step across all bars.
  const secPerBar = (60 / bpm) * 4
  const stepSeconds = secPerBar / STEPS_PER_BAR
  for (let bar = 0; bar < bars; bar++) {
    const barStartTime = bar * secPerBar

    // Build-up/drop filter automation (mirror of the live engine) — full mix only,
    // stems stay clean/unfiltered.
    if (soloTrack === -1) {
      const PHRASE = 8
      if (bar % PHRASE === 0) {
        const leadFilter = trackFilters[2]
        if (leadFilter) {
          leadFilter.frequency.setValueAtTime(700, barStartTime)
          leadFilter.frequency.exponentialRampToValueAtTime(18000, barStartTime + secPerBar * 4)
          leadFilter.frequency.setValueAtTime(18000, barStartTime + secPerBar * 4)
        }
        const bassFilter = trackFilters[1]
        if (bassFilter) {
          bassFilter.frequency.setValueAtTime(900, barStartTime)
          bassFilter.frequency.exponentialRampToValueAtTime(12000, barStartTime + secPerBar * 4)
          bassFilter.frequency.setValueAtTime(12000, barStartTime + secPerBar * 4)
        }
      }
    }

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
      // Sidechain pump (mirror of live engine): duck non-kick bus under each kick.
      if (s.track === 0) {
        const sg = sidechainGain.gain
        sg.setValueAtTime(1.0, s.audioTime)
        sg.linearRampToValueAtTime(0.35, s.audioTime + 0.008)
        sg.setTargetAtTime(1.0, s.audioTime + 0.04, 0.08)
      }
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

// ─────────────────────────────────────────────────────────────────────────────
// Arrangement rendering (Scope 4) — full-length track from a clip timeline
// ─────────────────────────────────────────────────────────────────────────────

export interface ArrangementRenderResult {
  master: Uint8Array // full-length WAV
  durationSec: number
  clipCount: number
  masteringReport?: MasteringReport
}

/**
 * Render an arrangement to a single full-length WAV.
 *
 * Walks the clips in startBar order, renders each pattern for its lengthBars at
 * the clip's (or arrangement's) bpm/seed, then concatenates the raw stereo audio
 * into one continuous buffer. Optionally masters the result.
 *
 * Deterministic: same arrangement + seeds → byte-identical output.
 */
export async function renderArrangement(opts: {
  arrangement: Arrangement
  sampleRate?: number
  samples?: Map<string, AudioBuffer>
  mastering?: MasteringTargets
}): Promise<ArrangementRenderResult> {
  if (typeof window === 'undefined') {
    throw new Error('renderArrangement requires a browser (OfflineAudioContext)')
  }
  const { arrangement } = opts
  const sampleRate = opts.sampleRate ?? 48000

  // Render each clip to raw float audio, in timeline order.
  const sortedClips = [...arrangement.clips].sort((a, b) => a.startBar - b.startBar)
  const rendered: Array<{ left: Float32Array; right: Float32Array }> = []
  for (const clip of sortedClips) {
    const clipBpm = clip.bpm ?? arrangement.bpm
    const clipSeed = clip.seed ?? arrangement.seed
    const raw = await renderTrackRaw({
      pattern: clip.pattern,
      seed: clipSeed,
      bpm: clipBpm,
      bars: clip.lengthBars,
      sampleRate,
      soloTrack: -1,
      duration: clip.lengthBars * ((60 / clipBpm) * 4),
      samples: opts.samples,
    })
    rendered.push(raw)
  }

  // Concatenate all clips into one buffer.
  const totalLen = rendered.reduce((acc, r) => acc + r.left.length, 0)
  const left = new Float32Array(totalLen)
  const right = new Float32Array(totalLen)
  let offset = 0
  for (const r of rendered) {
    left.set(r.left, offset)
    right.set(r.right, offset)
    offset += r.left.length
  }

  // Optional mastering.
  let masteringReport: MasteringReport | undefined
  if (opts.mastering) {
    masteringReport = masterBuffer(left, right, sampleRate, opts.mastering)
  }

  const master = encodeWav({ left, right, sampleRate })
  return {
    master,
    durationSec: totalLen / sampleRate,
    clipCount: sortedClips.length,
    masteringReport,
  }
}

/** Generate a deterministic stereo reverb impulse response (decaying noise). */
function makeReverbIR(ctx: OfflineAudioContext, duration: number, seed: number): AudioBuffer {
  const rate = ctx.sampleRate
  const length = Math.floor(rate * duration)
  const impulse = ctx.createBuffer(2, length, rate)
  const rng = mulberry32((0x5eed ^ seed) >>> 0)
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch)
    for (let i = 0; i < length; i++) {
      const decay = Math.pow(1 - i / length, 2.8)
      data[i] = (rng() * 2 - 1) * decay * 0.5
    }
  }
  return impulse
}
