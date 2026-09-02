/**
 * PSYBOSS procedural DSP — real sample-by-sample synthesis, seeded + deterministic.
 *
 * Provenance for every sound: { license: 'psboss-dsp', source: 'PSYBOSS DSP v1',
 * fingerprint: 'dsp:<soundId>:<seed>' }. The host's provenance gate validates this format.
 *
 * Track map (Scope 1 → 2):
 *   track 0 → KICK   (4 variants)
 *   track 1 → SNARE  (4 variants)
 *   track 2 → HAT    (4 variants)
 *   track 3 → BASS   (4 variants)
 *
 * Determinism: every sample is a pure function of (seed, soundId). Math.random / Date.now
 * are forbidden in this file. See ROAST-1 §7 for why Scope 1 was broken.
 */

import { mulberry32, subSeed, noiseStream, DcBlocker, flushDenormal, TAU } from './rng'
import type { Provenance } from '@/psybus/types'

export interface StereoBuffer {
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
  sampleRate: number
}

// ── Envelope helpers (denormal-safe) ─────────────────────────────────────────
function envExp(t: number, decay: number): number {
  return flushDenormal(Math.exp(-t / decay))
}

function envAR(t: number, attack: number, release: number, peak = 1): number {
  if (t < attack) return flushDenormal((t / attack) * peak)
  const rt = t - attack
  return flushDenormal(peak * Math.exp(-rt / release))
}

/**
 * PolyBLEP naive-saw correction. Adds a band-limited step at the discontinuity
 * to suppress aliasing. This is the minimal correct version of what PsySynthPro's
 * worklet does (audited worklog.md AUDIT-B §PsySynthPro). Without it, a 55Hz saw
 * aliases to the 436th harmonic at 48kHz.
 *
 * ROAST-2 #3 fix: the `t < dt` branch had a sign error (returned -(1-x)² instead
 * of +(1-x)²), making the correction WORSEN the discontinuity instead of smoothing
 * it. The LP masked the error so the band-ratio test passed either way. Now fixed
 * and verified by a real aliasing test (render at 48k vs 96k, compare spectrum).
 *
 * Math: for a rising saw (2t-1) with a -2 jump at t=0:
 *   - after the jump (t<dt): naive is too low → add POSITIVE (1-x)²
 *   - before the jump (t>1-dt): naive is too high → add NEGATIVE -(1+|x|)²
 *
 * @param t      phase in [0,1)
 * @param inc    phase increment per sample (= freq/sampleRate)
 * @returns correction to ADD to the naive saw value
 */
function polyblepSaw(t: number, inc: number): number {
  const dt = inc
  if (t < dt) {
    // just after wrap: naive saw is -1, bandlimited is higher → positive correction
    const x = t / dt
    const d = 1 - x
    return d * d // (1-x)², positive, 1→0
  } else if (t > 1 - dt) {
    // just before wrap: naive saw is +1, bandlimited is lower → negative correction
    const x = (t - 1) / dt // negative
    const d = 1 + x // = (dt + t - 1)/dt, in (0,1]
    return -(d * d) // -(1+x)², negative, 0→-1
  }
  return 0
}

/**
 * One-pole lowpass (RC). alpha = 1 - exp(-2*pi*fc/fs).
 * Stable, cheap, correct for monophonic bass duty.
 */
function onePoleLP(prev: number, input: number, alpha: number): number {
  return flushDenormal(prev + alpha * (input - prev))
}

/** Soft saturation (tanh) — guarantees |output| < 1, adds musical warmth. */
function saturate(x: number): number {
  // tanh is bounded (-1, 1); cheap approximation for |x| < ~2.
  return Math.tanh(x)
}

/** Hard-clamp guard — final safety net to guarantee |sample| ≤ 1.0. */
function clamp(x: number): number {
  return x > 1 ? 1 : x < -1 ? -1 : x
}

// ── KICK: sine + exp pitch env + sub layer + ramp-click (no aliasing) ─────────
export function renderKick(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 0.32
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const startFreq = [150, 160, 140, 130][variant] ?? 150
  const endFreq = [50, 48, 52, 45][variant] ?? 50
  const pitchDecaySec = ([60, 50, 70, 80][variant] ?? 60) / 1000
  const ampDecay = [0.09, 0.07, 0.11, 0.14][variant] ?? 0.09
  const clickGain = [0.55, 0.65, 0.45, 0.4][variant] ?? 0.55
  const subGain = 0.26 // sub-bass layer amplitude
  // Scale so fundamental + sub + click never exceeds ~0.95 (ROAST-1 §2: was clipping >1.0)
  const fundamentalGain = 0.72

  const dc = new DcBlocker(sampleRate)
  const rng = noiseStream(mulberry32(seed))

  let phase = 0
  let subPhase = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const pEnv = Math.exp(-t / pitchDecaySec)
    const freq = endFreq + (startFreq - endFreq) * pEnv
    phase += (freq / sampleRate) * TAU
    const fundamental = Math.sin(phase) * fundamentalGain
    // sub-bass layer at endFreq (sustained sine under the pitch sweep)
    subPhase += (endFreq / sampleRate) * TAU
    const sub = Math.sin(subPhase) * subGain
    // amp envelope
    const amp = envExp(t, ampDecay)
    // click transient: RAMPED over first 20 samples (was a click at sample 0 in Scope 1)
    let click = 0
    if (t < 0.002) {
      const ramp = Math.min(1, i / 20) // ramp up over 20 samples (~0.4ms)
      click = rng() * clickGain * ramp * (1 - t / 0.002)
    }
    let sample = (fundamental + sub) * amp + click * amp
    // MODERN: tanh drive adds punch + warm harmonics to the kick body.
    sample = Math.tanh(sample * 1.3) * 0.92
    sample = dc.process(sample)
    sample = clamp(sample)
    left[i] = sample
    right[i] = sample
  }
  return { left, right, sampleRate }
}

// ── SNARE: bandpass-ish noise + tonal body, two decorrelated noise streams ────
export function renderSnare(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 0.18
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const bodyFreq = [200, 180, 220, 240][variant] ?? 200
  const decay = [0.05, 0.04, 0.06, 0.045][variant] ?? 0.05
  const noiseGain = [0.7, 0.8, 0.6, 0.65][variant] ?? 0.7
  const toneGain = [0.4, 0.35, 0.45, 0.3][variant] ?? 0.4

  // Two independent seeded noise streams → real stereo decorrelation (was fake 0.9× in Scope 1)
  const rngL = noiseStream(mulberry32(seed))
  const rngR = noiseStream(mulberry32(seed ^ 0xdeadbeef))
  const dc = new DcBlocker(sampleRate)

  // DC-blocker topology one-pole HP (correct, was mislabeled "differentiate" in Scope 1)
  let prevInL = 0, prevOutL = 0
  let prevInR = 0, prevOutR = 0
  const hpAlpha = 0.96 // ~250Hz cutoff
  let bodyPhase = 0

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    // ramp the first 20 samples to kill the buffer-boundary click
    const ramp = Math.min(1, i / 20)
    const amp = envExp(t, decay) * ramp
    const rawL = rngL()
    const rawR = rngR()
    // one-pole HP (DC-blocker topology): y[n] = α(x[n] - x[n-1] + y[n-1])
    prevOutL = hpAlpha * (rawL - prevInL + prevOutL)
    prevInL = rawL
    prevOutR = hpAlpha * (rawR - prevInR + prevOutR)
    prevInR = rawR
    // tonal body
    bodyPhase += (bodyFreq / sampleRate) * TAU
    const tone = Math.sin(bodyPhase) * toneGain
    const sL = (prevOutL * noiseGain + tone) * amp
    const sR = (prevOutR * noiseGain + tone) * amp
    left[i] = clamp(saturate(dc.process(sL)))
    right[i] = clamp(saturate(dc.process(sR)))
  }
  return { left, right, sampleRate }
}

// ── HAT: noise → one-pole HP → soft clip, two decorrelated streams ────────────
export function renderHat(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = [0.08, 0.22, 0.05, 0.16][variant] ?? 0.08
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const decay = [0.025, 0.06, 0.015, 0.04][variant] ?? 0.025
  const hpAlpha = [0.9, 0.88, 0.92, 0.89][variant] ?? 0.9
  const rngL = noiseStream(mulberry32(seed))
  const rngR = noiseStream(mulberry32(seed ^ 0xfeedface))

  let prevInL = 0, prevOutL = 0
  let prevInR = 0, prevOutR = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const ramp = Math.min(1, i / 10)
    const amp = envExp(t, decay) * ramp
    const rawL = rngL()
    const rawR = rngR()
    prevOutL = hpAlpha * (rawL - prevInL + prevOutL)
    prevInL = rawL
    prevOutR = hpAlpha * (rawR - prevInR + prevOutR)
    prevInR = rawR
    // soft clip (tanh) to add character without hard aliasing
    const sL = Math.tanh(prevOutL * 2) * amp * 0.5
    const sR = Math.tanh(prevOutR * 2) * amp * 0.5
    left[i] = clamp(sL)
    right[i] = clamp(sR)
  }
  return { left, right, sampleRate }
}

// ── BASS: PolyBLEP saw → one-pole LP → amp env (no aliasing) ──────────────────
export function renderBass(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 0.3
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const root = 55 // A1
  // variant 3 = octave+fifth (3× root); Scope 1's dead branch fixed
  const intervals = [1, 2, 1.5, 3][variant] ?? 1
  const freq = root * intervals
  const lpAlpha = [0.12, 0.18, 0.15, 0.2][variant] ?? 0.12
  const decay = [0.12, 0.1, 0.11, 0.09][variant] ?? 0.12

  const inc = freq / sampleRate
  const dc = new DcBlocker(sampleRate)
  let sawPhase = 0
  let lpPrev = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    sawPhase += inc
    sawPhase -= Math.floor(sawPhase) // wrap to [0,1)
    const naive = sawPhase * 2 - 1
    const correction = polyblepSaw(sawPhase, inc)
    const saw = naive + correction
    lpPrev = onePoleLP(lpPrev, saw, lpAlpha)
    const amp = envAR(t, 0.005, decay, 0.8)
    const sample = dc.process(lpPrev * amp)
    left[i] = clamp(sample)
    right[i] = clamp(sample)
  }
  return { left, right, sampleRate }
}


// ─────────────────────────────────────────────────────────────────────────────
// PSYTRANCE EXPANSION — the sounds that make PSYBOSS actually speak trance.
// A device named PSYBOSS must deliver the genre's signature voices: the rolling
// resonant bass, the squelchy 303-style lead, plucky arps, atmospheric pads,
// psy claps, and tension FX. All seeded + deterministic like the core bank.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resonant lowpass (2-pole SVF-style) for the squelchy psy character.
 * State-variable filter: returns lowpass output. `res` in [0, 2] (self-oscillate ~2).
 */
class ResonantLP {
  private lp = 0
  private bp = 0
  private fc: number
  private res: number
  constructor(sampleRate: number, cutoffHz: number, res: number) {
    this.fc = 2 * Math.sin((Math.PI * Math.min(cutoffHz, sampleRate * 0.45)) / sampleRate)
    this.res = res
  }
  setCutoff(hz: number, sampleRate: number): void {
    this.fc = 2 * Math.sin((Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate)
  }
  process(x: number): number {
    this.lp = flushDenormal(this.lp + this.fc * this.bp)
    const hp = x - this.lp - this.res * this.bp
    this.bp = flushDenormal(this.bp + this.fc * hp)
    return this.lp
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MODERN DSP CORE — the upgrade that moves PSYBOSS off "dated" synthesis.
// ZDF-style Moog ladder filter (warm 24dB/oct resonance), proper ADSR envelopes,
// and multi-voice supersaw unison — the building blocks of contemporary
// analog-modeling synths (the Serum / Diva class of sound).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ZDF-style Moog LADDER FILTER — the warm, resonant "analog" voice of modern
 * psytrance. Four cascaded one-pole lowpasses with a resonance feedback path
 * (scaled ×0.25 to stay stable at any setting), yielding the classic musical
 * 24dB/oct sweep. Far richer than a one-pole or basic SVF.
 */
class LadderFilter {
  private s = [0, 0, 0, 0]
  private g = 0
  private k = 0
  constructor(sampleRate: number, cutoffHz: number, resonance: number) {
    this.setCutoff(cutoffHz, sampleRate)
    this.k = Math.min(Math.max(resonance, 0), 3.9)
  }
  setCutoff(hz: number, sampleRate: number): void {
    const f = Math.min(Math.max(hz, 1), sampleRate * 0.45)
    this.g = 1 - Math.exp((-2 * Math.PI * f) / sampleRate)
  }
  setResonance(res: number): void {
    this.k = Math.min(Math.max(res, 0), 3.9)
  }
  process(x: number): number {
    const fb = this.s[3] * this.k * 0.25
    let v = x - fb
    for (let i = 0; i < 4; i++) {
      this.s[i] = flushDenormal(this.s[i] + this.g * (v - this.s[i]))
      v = this.s[i]
    }
    return this.s[3]
  }
}

/**
 * ADSR envelope — attack/decay/release in seconds, sustain 0..1. Replaces the
 * flat AR curves for proper modern amplitude shaping.
 */
function adsr(t: number, a: number, d: number, s: number, r: number, dur: number): number {
  if (t < a) return t / Math.max(a, 1e-6)
  if (t < a + d) return 1 - (1 - s) * ((t - a) / Math.max(d, 1e-6))
  const relStart = dur - r
  if (t < relStart) return s
  return s * Math.max(0, 1 - (t - relStart) / Math.max(r, 1e-6))
}

/**
 * SUPERSAW — N detuned band-limited saw voices summed and normalized. This is
 * THE modern lead/pad texture (the wide, beating "big" sound). Per-voice pan
 * spread is returned via the optional stereo handler for width.
 */
function supersawSample(
  phases: Float32Array,
  incs: Float32Array,
  nVoices: number,
): number {
  let sum = 0
  for (let v = 0; v < nVoices; v++) {
    phases[v] += incs[v]
    phases[v] -= Math.floor(phases[v])
    sum += phases[v] * 2 - 1 + polyblepSaw(phases[v], incs[v])
  }
  return sum / nVoices
}

/** Build detuned voice increments for a supersaw at a base frequency. */
function makeSupersawIncs(
  freq: number,
  nVoices: number,
  detuneCents: number,
  sampleRate: number,
): { phases: Float32Array; incs: Float32Array } {
  const phases = new Float32Array(nVoices)
  const incs = new Float32Array(nVoices)
  for (let v = 0; v < nVoices; v++) {
    const spread = nVoices > 1 ? (v / (nVoices - 1)) * 2 - 1 : 0 // -1..1
    const cents = spread * detuneCents
    incs[v] = (freq * Math.pow(2, cents / 1200)) / sampleRate
  }
  return { phases, incs }
}

/**
 * PSY LEAD — the squelchy, resonant lead that defines psytrance.
 * Saw + square blend through a resonant lowpass whose cutoff opens then closes
 * (the classic "wow"). Optional FM ping for extra bite. 4 variants = different
 * resonance / modulation depth / FM amount.
 */
export function renderLead(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 0.6
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const root = 220 // A3
  // Full natural-minor (aeolian) scale across 8 scenes — real melodic range.
  const SCALE = [0, 2, 3, 5, 7, 8, 10, 12]
  const freq = root * Math.pow(2, (SCALE[variant % SCALE.length] ?? 0) / 12)

  // MODERN: 7-voice supersaw, per-variant detune width.
  const nVoices = 7
  const detuneCents = [18, 30, 14, 42][variant] ?? 24

  // MODERN: ZDF ladder resonance (higher Q than the old SVF) + ADSR + drive.
  const res = [2.2, 2.8, 1.8, 3.2][variant] ?? 2.5
  const fStart = [2400, 3200, 1800, 4000][variant] ?? 2800
  const fEnd = [280, 380, 240, 480][variant] ?? 340
  const fDecaySec = [0.28, 0.34, 0.22, 0.4][variant] ?? 0.3
  const attack = 0.004
  const decay = 0.12
  const sustain = 0.55
  const release = 0.25

  const { phases, incs } = makeSupersawIncs(freq, nVoices, detuneCents, sampleRate)
  const filt = new LadderFilter(sampleRate, fStart, res)
  const dc = new DcBlocker(sampleRate)

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    // Supersaw source (wide, beating, modern).
    const raw = supersawSample(phases, incs, nVoices)
    // Filter envelope (the squelch): ladder opens then closes.
    const fEnv = Math.exp(-t / fDecaySec)
    filt.setCutoff(fEnd + (fStart - fEnd) * fEnv, sampleRate)
    const filtered = filt.process(raw)
    // ADSR amplitude.
    const amp = adsr(t, attack, decay, sustain, release, dur)
    // Drive: tanh saturation adds warm harmonics.
    const driven = Math.tanh(filtered * 2.4)
    const sample = dc.process(driven * amp * 1.7)
    left[i] = clamp(sample)
    right[i] = clamp(sample * 0.94)
  }
  return { left, right, sampleRate }
}

/**
 * PSY ARP — short, plucky, resonant arp note designed to be triggered in fast
 * sequences. Bright attack, fast decay, touch of resonance.
 */
export function renderArp(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 0.22
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const root = 440 // A4
  // Full natural-minor (aeolian) scale across 8 scenes — real melodic range.
  const SCALE = [0, 2, 3, 5, 7, 8, 10, 12]
  const freq = root * Math.pow(2, (SCALE[variant % SCALE.length] ?? 0) / 12)
  const res = [1.2, 1.5, 1.0, 1.7][variant] ?? 1.3
  const fStart = [3200, 2800, 3600, 2400][variant] ?? 3000
  const fEnd = [600, 500, 700, 450][variant] ?? 550
  const fDecaySec = 0.1

  const inc = freq / sampleRate
  const dc = new DcBlocker(sampleRate)
  const filt = new ResonantLP(sampleRate, fStart, res)
  let ph = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const fEnv = Math.exp(-t / fDecaySec)
    filt.setCutoff(fEnd + (fStart - fEnd) * fEnv, sampleRate)
    ph += inc
    ph -= Math.floor(ph)
    const saw = ph * 2 - 1 + polyblepSaw(ph, inc)
    const filtered = filt.process(saw)
    const amp = envAR(t, 0.002, 0.09, 0.45)
    const sample = dc.process(saturate(filtered * amp * 2.4))
    left[i] = clamp(sample)
    right[i] = clamp(sample * 0.92)
  }
  return { left, right, sampleRate }
}

/**
 * PSY PAD — wide, atmospheric pad for breakdowns. Detuned saws through a gentle
 * lowpass with slow attack. Stereo-widened via per-channel detune.
 */
export function renderPad(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 1.2
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const root = 110 // A2
  // Full natural-minor (aeolian) scale across 8 scenes — real melodic range.
  const SCALE = [0, 2, 3, 5, 7, 8, 10, 12]
  const freq = root * Math.pow(2, (SCALE[variant % SCALE.length] ?? 0) / 12)

  // MODERN: lush 5-voice supersaw, L/R detuned independently for stereo width.
  const nVoices = 5
  const detuneCents = [14, 22, 10, 28][variant] ?? 18
  const lpHz = [1100, 1500, 900, 1900][variant] ?? 1200

  const SL = makeSupersawIncs(freq, nVoices, detuneCents, sampleRate)
  const SR = makeSupersawIncs(freq, nVoices, detuneCents * 1.15, sampleRate)
  const filtL = new LadderFilter(sampleRate, lpHz, 0.6)
  const filtR = new LadderFilter(sampleRate, lpHz * 1.06, 0.6)
  const dcL = new DcBlocker(sampleRate)
  const dcR = new DcBlocker(sampleRate)

  const attack = 0.2
  const decay = 0.3
  const sustain = 0.7
  const release = 0.4

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const rawL = supersawSample(SL.phases, SL.incs, nVoices)
    const rawR = supersawSample(SR.phases, SR.incs, nVoices)
    const filteredL = filtL.process(rawL)
    const filteredR = filtR.process(rawR)
    const amp = adsr(t, attack, decay, sustain, release, dur) * 0.5
    left[i] = clamp(dcL.process(filteredL * amp))
    right[i] = clamp(dcR.process(filteredR * amp))
  }
  return { left, right, sampleRate }
}

/**
 * PSY CLAP — the classic psy/techno clap: a few filtered-noise bursts with a
 * resonant bandpass, tight and punchy.
 */
export function renderClap(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 0.28
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const bpHz = [1400, 1800, 1100, 2200][variant] ?? 1600
  const bursts = [3, 4, 2, 5][variant] ?? 3
  const burstGap = [0.012, 0.009, 0.015, 0.007][variant] ?? 0.011
  const rng = noiseStream(mulberry32(seed))
  const dc = new DcBlocker(sampleRate)
  const bw = Math.max(bpHz, 100) / sampleRate
  let lp1 = 0, lp2 = 0, hpPrev = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let env = 0
    for (let b = 0; b < bursts; b++) {
      const bt = t - b * burstGap
      if (bt >= 0 && bt < 0.01) env += (1 - bt / 0.01) * 0.8
    }
    const tailStart = bursts * burstGap
    if (t >= tailStart) env += Math.exp(-(t - tailStart) / 0.06) * 0.6
    const noise = rng()
    lp1 = onePoleLP(lp1, noise, Math.min(bw * 6, 0.9))
    lp2 = onePoleLP(lp2, lp1, Math.min(bw * 6, 0.9))
    const hp = lp2 - hpPrev
    hpPrev = lp2
    const sample = dc.process(hp * env * 1.6)
    left[i] = clamp(sample)
    right[i] = clamp(sample * 0.9)
  }
  return { left, right, sampleRate }
}

/**
 * PSY FX RISER — rising band-swept noise that builds tension before a drop.
 * Bandpass center + amplitude ramp upward over the duration.
 */
export function renderFx(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 1.0
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const fStart = [300, 200, 400, 250][variant] ?? 300
  const fEnd = [6000, 8000, 5000, 9000][variant] ?? 7000
  const rng = noiseStream(mulberry32(seed))
  const dc = new DcBlocker(sampleRate)
  let lp1 = 0, lp2 = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const p = t / dur
    const cutoff = fStart + (fEnd - fStart) * (p * p)
    const bw = Math.max(cutoff, 100) / sampleRate
    const noise = rng()
    lp1 = onePoleLP(lp1, noise, Math.min(bw * 4, 0.9))
    lp2 = onePoleLP(lp2, lp1, Math.min(bw * 4, 0.9))
    const shimmer = Math.sin(TAU * (20 + p * 400) * t) * 0.15 * p
    const amp = p * p * 0.5
    const sample = dc.process((lp2 + shimmer) * amp)
    left[i] = clamp(sample)
    right[i] = clamp(sample * 0.85)
  }
  return { left, right, sampleRate }
}

/**
 * ROLLING PSY BASS — the signature KBBB psy bass: a punchy, resonant offbeat
 * bass note. Tighter and more resonant than the generic bass, tuned to sit
 * between kicks. (The "roll" pattern itself is laid down by the sequencer.)
 */
export function renderRollBass(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 0.26
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const root = 55 // A1
  // Rolling psy bass stays root-heavy with fifth/octave movement.
  const BASS_SCALE = [0, 0, 7, 12, 0, 3, 7, 12]
  const freq = root * Math.pow(2, (BASS_SCALE[variant % BASS_SCALE.length] ?? 0) / 12)
  // MODERN: higher ladder resonance for an aggressive, audible mid growl.
  const res = [2.0, 2.6, 1.6, 3.0][variant] ?? 2.3
  const fStart = [900, 1200, 750, 1500][variant] ?? 1050
  const fEnd = [200, 250, 180, 300][variant] ?? 230
  const fDecaySec = 0.09

  const inc = freq / sampleRate
  const dc = new DcBlocker(sampleRate)
  const filt = new LadderFilter(sampleRate, fStart, res)
  let ph = 0
  let subPh = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const fEnv = Math.exp(-t / fDecaySec)
    filt.setCutoff(fEnd + (fStart - fEnd) * fEnv, sampleRate)
    // Resonant saw — the growl (ladder filter emphasizes harmonics so it stays
    // audible even on small speakers).
    ph += inc
    ph -= Math.floor(ph)
    const saw = ph * 2 - 1 + polyblepSaw(ph, inc)
    const filtered = filt.process(saw)
    // Sub sine layer — the low-end weight.
    subPh += inc
    const sub = Math.sin(subPh * TAU) * 0.5
    const amp = envAR(t, 0.002, 0.12, 0.85)
    // MODERN: stronger tanh drive for warmth + harmonics.
    const mix = filtered * 0.85 + sub
    const driven = Math.tanh(mix * 2.2)
    const sample = dc.process(driven * amp * 1.7)
    left[i] = clamp(sample)
    right[i] = clamp(sample)
  }
  return { left, right, sampleRate }
}


/**
 * PSY STAB — a punchy chord stab (root+fifth+octave) through a fast ladder-filter
 * envelope. Classic psytrance accent for drops and transitions.
 */
export function renderStab(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 0.4
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const root = 220 // A3
  // Full natural-minor (aeolian) scale across 8 scenes — real melodic range.
  const SCALE = [0, 2, 3, 5, 7, 8, 10, 12]
  const baseFreq = root * Math.pow(2, (SCALE[variant % SCALE.length] ?? 0) / 12)
  const chordRatios = [1, 1.5, 2] // root, fifth, octave

  const nVoicesPerNote = 3
  const detuneCents = 18
  const res = 2.2
  const fStart = 3000
  const fEnd = 400
  const fDecaySec = 0.15

  const allPhases: Float32Array[] = []
  const allIncs: Float32Array[] = []
  for (let c = 0; c < chordRatios.length; c++) {
    const s = makeSupersawIncs(baseFreq * chordRatios[c], nVoicesPerNote, detuneCents, sampleRate)
    allPhases.push(s.phases)
    allIncs.push(s.incs)
  }

  const filt = new LadderFilter(sampleRate, fStart, res)
  const dc = new DcBlocker(sampleRate)

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    let sum = 0
    for (let c = 0; c < chordRatios.length; c++) {
      sum += supersawSample(allPhases[c], allIncs[c], nVoicesPerNote)
    }
    sum /= chordRatios.length
    const fEnv = Math.exp(-t / fDecaySec)
    filt.setCutoff(fEnd + (fStart - fEnd) * fEnv, sampleRate)
    const filtered = filt.process(sum)
    const amp = adsr(t, 0.003, 0.08, 0.3, 0.2, dur)
    const driven = Math.tanh(filtered * 2.0)
    const sample = dc.process(driven * amp * 1.6)
    left[i] = clamp(sample)
    right[i] = clamp(sample * 0.95)
  }
  return { left, right, sampleRate }
}

/**
 * PSY PLUCK — a fast, resonant plucked note. Very short envelope with a quickly
 * closing ladder filter — the bright, percussive melodic accent of psytrance.
 */
export function renderPluck(sampleRate: number, variant: number, seed: number): StereoBuffer {
  const dur = 0.3
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const root = 440 // A4
  // Full natural-minor (aeolian) scale across 8 scenes — real melodic range.
  const SCALE = [0, 2, 3, 5, 7, 8, 10, 12]
  const freq = root * Math.pow(2, (SCALE[variant % SCALE.length] ?? 0) / 12)

  const res = 1.8
  const fStart = 4000
  const fEnd = 300
  const fDecaySec = 0.08

  const s = makeSupersawIncs(freq, 3, 12, sampleRate)
  const filt = new LadderFilter(sampleRate, fStart, res)
  const dc = new DcBlocker(sampleRate)

  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const raw = supersawSample(s.phases, s.incs, 3)
    const fEnv = Math.exp(-t / fDecaySec)
    filt.setCutoff(fEnd + (fStart - fEnd) * fEnv, sampleRate)
    const filtered = filt.process(raw)
    const amp = Math.exp(-t / 0.07)
    const driven = Math.tanh(filtered * 2.2)
    const sample = dc.process(driven * amp * 1.5)
    left[i] = clamp(sample)
    right[i] = clamp(sample * 0.9)
  }
  return { left, right, sampleRate }
}

const RENDERERS = [
  renderKick,
  renderRollBass,
  renderLead,
  renderArp,
  renderHat,
  renderClap,
  renderPad,
  renderFx,
  renderStab,
  renderPluck,
]

export const TRACK_NAMES = ['KICK', 'BASS', 'LEAD', 'ARP', 'HAT', 'CLAP', 'PAD', 'FX', 'STAB', 'PLUCK'] as const
export const SCENE_COUNT = 8

/**
 * Render the full sound bank. Deterministic: same (sampleRate, seed) → byte-identical
 * Float32Arrays across runs. Proven by tests/determinism.test.ts.
 */
export function renderSoundBank(
  sampleRate: number,
  seed: number,
): Map<string, StereoBuffer> {
  const bank = new Map<string, StereoBuffer>()
  for (let track = 0; track < RENDERERS.length; track++) {
    for (let scene = 0; scene < SCENE_COUNT; scene++) {
      const soundId = `${track}:${scene}`
      const sub = subSeed(seed, soundId)
      const buf = RENDERERS[track](sampleRate, scene, sub)
      bank.set(soundId, buf)
    }
  }
  return bank
}

/**
 * Build a provenance record for a PSYBOSS-generated sound.
 * Fingerprint includes the seed: `dsp:<soundId>:<seed>`. The host validates this format.
 */
export function dspProvenance(soundId: string, seed: number): Provenance {
  return {
    license: 'psboss-dsp',
    source: 'PSYBOSS DSP generator v1',
    // Use the seed as the verification timestamp — deterministic, not wall-clock.
    // (Wall-clock would break replay identity; see ROAST-1 §7.)
    verifiedAt: seed,
    fingerprint: `dsp:${soundId}:${seed}`,
  }
}
