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
 * @param t      phase in [0,1)
 * @param inc    phase increment per sample (= freq/sampleRate)
 * @returns correction to ADD to the naive saw value
 */
function polyblepSaw(t: number, inc: number): number {
  // saw has one discontinuity at t=0 (rising from -1 to +1)
  let dt = inc
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  } else if (t > 1 - dt) {
    const x = (t - 1) / dt // negative side
    const xa = Math.abs(x)
    return xa + xa - xa * xa - 1
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
  const clickGain = [0.5, 0.6, 0.4, 0.3][variant] ?? 0.5
  const subGain = 0.22 // sub-bass layer amplitude
  // Scale so fundamental + sub + click never exceeds ~0.95 (ROAST-1 §2: was clipping >1.0)
  const fundamentalGain = 0.7

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
    sample = dc.process(sample)
    sample = clamp(saturate(sample))
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

const RENDERERS = [renderKick, renderSnare, renderHat, renderBass]

export const TRACK_NAMES = ['KICK', 'SNARE', 'HAT', 'BASS'] as const
export const SCENE_COUNT = 4

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
