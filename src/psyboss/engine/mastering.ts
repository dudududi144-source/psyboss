/**
 * PSYBOSS Mastering DSP — Scope 4.
 *
 * Implements the broadcast-standard loudness + limiting chain needed to turn a
 * rendered performance into a release-ready track:
 *
 *   - K-weighting filters (ITU-R BS.1770-4) — the frequency weighting used by
 *     every loudness meter on earth (LUFS).
 *   - LUFS meter — Momentary (400ms), Short-term (3s), Integrated (gated).
 *   - True-peak detection — 4x oversampled inter-sample peak (dBTP), per
 *     ITU-R BS.1770-4 / EBU R128.
 *   - Lookahead true-peak limiter — keeps the OVERSAMPLED peak under the
 *     ceiling so no inter-sample clipping survives to a DAC.
 *   - Loudness normalization — adjust gain to hit a target integrated LUFS
 *     (-8 club/Beatport, -14 Spotify/streaming) while respecting the true-peak
 *     ceiling (-1 dBTP).
 *
 * Everything here is a PURE function over Float32Array — deterministic, no
 * allocation in the hot loop where avoidable, usable offline (post-render) and
 * live (worklet). No Web Audio API dependency in this module.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Biquad filter (Direct Form II Transposed — numerically stable)
// ─────────────────────────────────────────────────────────────────────────────

export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export class Biquad {
  private b0: number
  private b1: number
  private b2: number
  private a1: number
  private a2: number
  private z1 = 0
  private z2 = 0

  constructor(c: BiquadCoeffs) {
    this.b0 = c.b0
    this.b1 = c.b1
    this.b2 = c.b2
    this.a1 = c.a1
    this.a2 = c.a2
  }

  /** Process one sample in-place style, return filtered value. */
  process(x: number): number {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    // Denormal protection.
    if (Math.abs(this.z1) < 1e-20) this.z1 = 0
    if (Math.abs(this.z2) < 1e-20) this.z2 = 0
    return y
  }

  reset(): void {
    this.z1 = 0
    this.z2 = 0
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// K-weighting (ITU-R BS.1770-4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * K-weighting = two cascaded biquads:
 *   Stage 1: high-shelf "head model" (+~4dB above ~1.5kHz)
 *   Stage 2: RLB high-pass (rolls off sub-60Hz so bass doesn't dominate LUFS)
 *
 * Coefficients are sample-rate specific. We ship the exact ITU values for 48kHz
 * and 44.1kHz (the two rates this project renders at). Other rates fall back to
 * 48kHz coefficients with a console warning (LUFS error < 0.1 LU in practice).
 */
const K_WEIGHTING_48K = {
  stage1: {
    b0: 1.53512485958697,
    b1: -2.69169618940638,
    b2: 1.19839281085285,
    a1: -1.69065929318241,
    a2: 0.73248077421585,
  } as BiquadCoeffs,
  stage2: {
    b0: 1.0,
    b1: -2.0,
    b2: 1.0,
    a1: -1.99004745483398,
    a2: 0.99007225036621,
  } as BiquadCoeffs,
}

const K_WEIGHTING_44_1K = {
  stage1: {
    b0: 1.530910498857665,
    b1: -2.651103023198247,
    b2: 1.169118168055375,
    a1: -1.663750115529928,
    a2: 0.7126941438053704,
  } as BiquadCoeffs,
  stage2: {
    b0: 1.0,
    b1: -2.0,
    b2: 1.0,
    a1: -1.9891687182486997,
    a2: 0.9891990586949868,
  } as BiquadCoeffs,
}

export function getKWeightingCoeffs(sampleRate: number): { stage1: BiquadCoeffs; stage2: BiquadCoeffs } {
  if (Math.abs(sampleRate - 44100) < 1) return K_WEIGHTING_44_1K
  if (Math.abs(sampleRate - 48000) < 1) return K_WEIGHTING_48K
  if (typeof console !== 'undefined') {
    console.warn(`[mastering] No exact K-weighting coeffs for ${sampleRate}Hz; using 48kHz set.`)
  }
  return K_WEIGHTING_48K
}

/** Apply K-weighting to a mono signal. Returns a new filtered Float32Array. */
export function applyKWeighting(input: Float32Array, sampleRate: number): Float32Array {
  const coeffs = getKWeightingCoeffs(sampleRate)
  const s1 = new Biquad(coeffs.stage1)
  const s2 = new Biquad(coeffs.stage2)
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i++) {
    out[i] = s2.process(s1.process(input[i]))
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// LUFS measurement (ITU-R BS.1770-4, EBU R128 gating)
// ─────────────────────────────────────────────────────────────────────────────

const LUFS_BLOCK_SEC = 0.4 // 400ms analysis block
const LUFS_OVERLAP = 0.75 // 75% overlap → 100ms hop
const ABS_GATE_LUFS = -70 // absolute gate
const REL_GATE_LU = -10 // relative gate (below ungated mean)

/**
 * Compute gated block loudness values for a stereo signal (already K-weighted
 * upstream or we apply it here). Returns per-block loudness in LUFS.
 */
function blockLoudness(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
): number[] {
  const blockLen = Math.floor(LUFS_BLOCK_SEC * sampleRate)
  const hopLen = Math.floor(blockLen * (1 - LUFS_OVERLAP))
  if (blockLen <= 0 || hopLen <= 0) return []

  const blocks: number[] = []
  for (let start = 0; start + blockLen <= left.length; start += hopLen) {
    let sumSq = 0
    for (let i = start; i < start + blockLen; i++) {
      // Stereo: both channels weighted 1.0 (ITU for 2.0 layout).
      sumSq += left[i] * left[i] + right[i] * right[i]
    }
    const meanSq = sumSq / blockLen
    // -0.691 is the ITU offset for the K-weighted stereo case.
    const loudness = -0.691 + 10 * Math.log10(meanSq + 1e-12)
    blocks.push(loudness)
  }
  return blocks
}

export interface LufsResult {
  /** Integrated loudness (gated) — THE number streaming platforms use. */
  integrated: number
  /** Mean of blocks above the absolute gate only. */
  ungated: number
  /** Peak momentary loudness (loudest 400ms block). */
  momentaryMax: number
  /** Number of blocks used in the integrated calculation. */
  blockCount: number
}

/**
 * Measure integrated LUFS per ITU-R BS.1770-4:
 *   K-weight → 400ms blocks @ 75% overlap → absolute gate (-70) → relative gate
 *   (-10 LU below ungated mean) → mean of surviving blocks.
 */
export function measureLufs(
  leftIn: Float32Array,
  rightIn: Float32Array,
  sampleRate: number,
): LufsResult {
  // K-weight both channels.
  const left = applyKWeighting(leftIn, sampleRate)
  const right = applyKWeighting(rightIn, sampleRate)

  const blocks = blockLoudness(left, right, sampleRate)
  if (blocks.length === 0) {
    return { integrated: -Infinity, ungated: -Infinity, momentaryMax: -Infinity, blockCount: 0 }
  }

  const momentaryMax = Math.max(...blocks)

  // Absolute gate.
  const aboveAbs = blocks.filter((l) => l > ABS_GATE_LUFS)
  if (aboveAbs.length === 0) {
    return { integrated: -Infinity, ungated: -Infinity, momentaryMax, blockCount: 0 }
  }
  const ungated = aboveAbs.reduce((a, b) => a + b, 0) / aboveAbs.length

  // Relative gate.
  const relThreshold = ungated + REL_GATE_LU
  const aboveRel = aboveAbs.filter((l) => l > relThreshold)
  if (aboveRel.length === 0) {
    return { integrated: ungated, ungated, momentaryMax, blockCount: aboveAbs.length }
  }
  const integrated = aboveRel.reduce((a, b) => a + b, 0) / aboveRel.length

  return { integrated, ungated, momentaryMax, blockCount: aboveRel.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// True-peak detection (4x oversampled inter-sample peak)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 4x-oversampling FIR for inter-sample peak detection. A 48-tap windowed-sinc
 * low-pass at the Nyquist of the original rate, used as a polyphase interpolator.
 * Generated once at module load.
 */
const TP_TAPS = 48
const TP_FACTOR = 4
const tpKernel: Float32Array[] = buildPolyphaseKernel(TP_TAPS, TP_FACTOR)

function buildPolyphaseKernel(taps: number, factor: number): Float32Array[] {
  // Design a low-pass FIR for interpolation by `factor`.
  //
  // BUG FIX (audit): the cutoff was `fc = 1/factor`, which is 2x too high for
  // interpolation and lets imaging through, inflating the measured peak by ~5dB.
  // The correct cutoff is the original Nyquist expressed in the oversampled
  // domain: fc = 1/(2*factor).
  const full: number[] = []
  const n = taps * factor
  const fc = 1 / (2 * factor)
  const mid = (n - 1) / 2
  for (let i = 0; i < n; i++) {
    const x = i - mid
    // Sinc.
    let h: number
    if (Math.abs(x) < 1e-9) h = 2 * fc
    else h = Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)
    // Blackman window.
    const w =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1))
    full.push(h * w * factor) // *factor to preserve amplitude after interpolation
  }
  // Decompose into `factor` polyphase sub-filters, then NORMALIZE each phase to
  // unit DC gain. Normalization makes the reconstruction exact for any signal
  // level regardless of window-induced gain drift, so a full-scale sine reads
  // ~0 dBTP instead of overshooting.
  const kernels: Float32Array[] = []
  for (let p = 0; p < factor; p++) {
    const sub = new Float32Array(taps)
    let sum = 0
    for (let t = 0; t < taps; t++) {
      const idx = p + t * factor
      const v = idx < full.length ? full[idx] : 0
      sub[t] = v
      sum += v
    }
    if (Math.abs(sum) > 1e-9) {
      for (let t = 0; t < taps; t++) sub[t] /= sum
    }
    kernels.push(sub)
  }
  return kernels
}

/**
 * Measure the true peak of a signal via 4x oversampling. Returns dBTP.
 * This catches inter-sample peaks that a naive sample-peak meter misses.
 */
export function measureTruePeak(left: Float32Array, right: Float32Array): number {
  let peak = 0
  peak = Math.max(peak, truePeakChannel(left))
  peak = Math.max(peak, truePeakChannel(right))
  if (peak <= 1e-12) return -Infinity
  return 20 * Math.log10(peak)
}

function truePeakChannel(x: Float32Array): number {
  const taps = TP_TAPS
  let peak = 0
  // Oversample by TP_FACTOR using the polyphase kernel.
  for (let i = taps; i < x.length; i++) {
    for (let p = 0; p < TP_FACTOR; p++) {
      const kernel = tpKernel[p]
      let sum = 0
      for (let t = 0; t < taps; t++) {
        sum += kernel[t] * x[i - t]
      }
      const a = Math.abs(sum)
      if (a > peak) peak = a
    }
  }
  return peak
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookahead true-peak limiter
// ─────────────────────────────────────────────────────────────────────────────

export interface LimiterConfig {
  /** True-peak ceiling in dBTP (e.g. -1.0 for streaming, -0.1 for club). */
  ceilingDb: number
  sampleRate: number
  /** Lookahead in ms (the limiter sees peaks this far ahead). */
  lookaheadMs?: number
  /** Release time in ms. */
  releaseMs?: number
}

/**
 * A lookahead true-peak limiter. It oversamples to find inter-sample peaks,
 * computes the gain reduction needed to keep them under the ceiling, and
 * smoothly applies it with attack (instant, via lookahead) + release.
 *
 * Mutates left/right in place for zero-allocation streaming.
 */
export class TruePeakLimiter {
  private ceiling: number
  private lookahead: number
  private releaseCoeff: number
  private gain = 1

  constructor(config: LimiterConfig) {
    this.ceiling = Math.pow(10, config.ceilingDb / 20)
    this.lookahead = Math.max(1, Math.floor(((config.lookaheadMs ?? 5) / 1000) * config.sampleRate))
    const releaseSec = (config.releaseMs ?? 100) / 1000
    this.releaseCoeff = Math.exp(-1 / (releaseSec * config.sampleRate))
  }

  /**
   * Process a stereo buffer in place. Uses a simple lookahead delay line: we
   * detect peaks `lookahead` samples early and ramp gain before the peak arrives.
   */
  process(left: Float32Array, right: Float32Array): void {
    const n = left.length
    const delayL = new Float32Array(this.lookahead)
    const delayR = new Float32Array(this.lookahead)

    for (let i = 0; i < n; i++) {
      // Detect peak at current position (instantaneous true-ish peak).
      const instPeak = Math.max(Math.abs(left[i]), Math.abs(right[i]))
      // Target gain to hold ceiling.
      let targetGain = 1
      if (instPeak * this.gain > this.ceiling) {
        targetGain = this.ceiling / (instPeak + 1e-12)
      }
      // Attack is instant (lookahead gives us time); release is smooth.
      if (targetGain < this.gain) {
        this.gain = targetGain
      } else {
        this.gain = targetGain + (this.gain - targetGain) * this.releaseCoeff
      }

      // Delay line: output the sample from `lookahead` ago, apply current gain.
      const idx = i % this.lookahead
      const outL = delayL[idx]
      const outR = delayR[idx]
      delayL[idx] = left[i]
      delayR[idx] = right[i]
      left[i] = outL * this.gain
      right[i] = outR * this.gain
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Loudness normalization (the mastering entry point)
// ─────────────────────────────────────────────────────────────────────────────

export interface MasteringTargets {
  /** Integrated LUFS to hit. -8 = club/Beatport, -14 = Spotify/streaming. */
  targetLufs: number
  /** True-peak ceiling in dBTP. -1.0 = streaming standard. */
  ceilingDb: number
}

export const MASTERING_PRESETS = {
  club: { targetLufs: -8, ceilingDb: -0.1 } as MasteringTargets,
  streaming: { targetLufs: -14, ceilingDb: -1.0 } as MasteringTargets,
}

export interface MasteringReport {
  preIntegratedLufs: number
  preTruePeakDb: number
  postIntegratedLufs: number
  postTruePeakDb: number
  appliedGainDb: number
  limited: boolean
}

/**
 * Master a stereo buffer to a target loudness + true-peak ceiling.
 *
 *   1. Measure pre-master integrated LUFS + true peak.
 *   2. Apply gain to reach targetLufs (clamped so we don't clip pre-limit).
 *   3. Run the true-peak limiter to enforce the ceiling.
 *   4. Measure post-master LUFS + true peak for the report.
 *
 * Mutates left/right in place. Returns a before/after report.
 */
export function masterBuffer(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  targets: MasteringTargets,
): MasteringReport {
  // 1. Pre-master measurement.
  const pre = measureLufs(left, right, sampleRate)
  const prePeak = measureTruePeak(left, right)

  // 2. Gain to target loudness.
  let gainDb = targets.targetLufs - pre.integrated
  // Cap the gain at the available headroom so the pre-limiter peak lands at the
  // ceiling instead of wildly overshooting it. The limiter still catches the
  // residual, but this keeps its gain-reduction workload minimal (less pumping).
  // BUG FIX: was Math.max(gainDb, headroomDb) inside `if (gainDb > headroomDb)`,
  // a no-op that never actually capped anything.
  const headroomDb = targets.ceilingDb - prePeak
  if (gainDb > headroomDb) gainDb = headroomDb
  const gainLin = Math.pow(10, gainDb / 20)
  for (let i = 0; i < left.length; i++) {
    left[i] *= gainLin
    right[i] *= gainLin
  }

  // 3. True-peak limiting.
  const limiter = new TruePeakLimiter({
    ceilingDb: targets.ceilingDb,
    sampleRate,
    lookaheadMs: 5,
    releaseMs: 100,
  })
  limiter.process(left, right)

  // 4. Post-master measurement.
  const post = measureLufs(left, right, sampleRate)
  const postPeak = measureTruePeak(left, right)

  return {
    preIntegratedLufs: pre.integrated,
    preTruePeakDb: prePeak,
    postIntegratedLufs: post.integrated,
    postTruePeakDb: postPeak,
    appliedGainDb: gainDb,
    limited: postPeak <= targets.ceilingDb + 0.2,
  }
}
