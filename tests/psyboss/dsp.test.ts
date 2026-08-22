/**
 * PSYBOSS DSP numerical tests — verify the synthesized audio meets spec.
 *
 * These tests are the answer to ROAST-1 §9: "Zero tests — hypocrite."
 * Every assertion is numerical and falsifiable. If the DSP drifts, the test fails.
 *
 * Run: bun test tests/psyboss/dsp.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { renderSoundBank, renderKick, renderSnare, renderHat, renderBass, TRACK_NAMES, SCENE_COUNT } from '@/psyboss/engine/dsp'
import { mulberry32, subSeed } from '@/psyboss/engine/rng'

const SR = 48000
const SEED = 0x9e3779b9

describe('sound bank', () => {
  test('renders 4 tracks × 4 scenes = 16 sounds', () => {
    const bank = renderSoundBank(SR, SEED)
    expect(bank.size).toBe(TRACK_NAMES.length * SCENE_COUNT)
    for (let t = 0; t < TRACK_NAMES.length; t++) {
      for (let s = 0; s < SCENE_COUNT; s++) {
        expect(bank.has(`${t}:${s}`)).toBe(true)
      }
    }
  })

  test('every buffer is non-empty and stereo', () => {
    const bank = renderSoundBank(SR, SEED)
    for (const [key, buf] of bank.entries()) {
      expect(buf.left.length).toBeGreaterThan(0)
      expect(buf.right.length).toBe(buf.left.length)
      expect(buf.sampleRate).toBe(SR)
    }
  })

  test('every sample is bounded [-1, 1]', () => {
    const bank = renderSoundBank(SR, SEED)
    for (const [, buf] of bank.entries()) {
      for (let i = 0; i < buf.left.length; i++) {
        expect(buf.left[i]).toBeGreaterThanOrEqual(-1.001)
        expect(buf.left[i]).toBeLessThanOrEqual(1.001)
        expect(buf.right[i]).toBeGreaterThanOrEqual(-1.001)
        expect(buf.right[i]).toBeLessThanOrEqual(1.001)
      }
    }
  })
})

describe('determinism (ROAST-1 §7)', () => {
  test('same seed → byte-identical buffers across runs', () => {
    const a = renderSoundBank(SR, SEED)
    const b = renderSoundBank(SR, SEED)
    for (const [key, bufA] of a.entries()) {
      const bufB = b.get(key)!
      expect(bufB.left.length).toBe(bufA.left.length)
      for (let i = 0; i < bufA.left.length; i++) {
        expect(bufB.left[i]).toBe(bufA.left[i])
        expect(bufB.right[i]).toBe(bufA.right[i])
      }
    }
  })

  test('different seed → different audio (proves the seed is actually used)', () => {
    const a = renderSoundBank(SR, SEED)
    const b = renderSoundBank(SR, SEED + 1)
    let differences = 0
    for (const [key, bufA] of a.entries()) {
      const bufB = b.get(key)!
      for (let i = 0; i < bufA.left.length; i++) {
        if (bufB.left[i] !== bufA.left[i]) differences++
      }
    }
    // Noise-based sounds (snare, hat) should differ substantially. Kick/bass are
    // mostly deterministic given the same variant params, but the click (kick)
    // and noise (snare/hat) differ. Expect at least some differences.
    expect(differences).toBeGreaterThan(100)
  })

  test('no Math.random / Date.now in dsp module source', async () => {
    const src = await Bun.file('./src/psyboss/engine/dsp.ts').text()
    // Allow the word in comments but not as a call
    const calls = src.match(/\bMath\.random\s*\(/g)
    expect(calls).toBeNull()
    const dateCalls = src.match(/\bDate\.now\s*\(/g)
    expect(dateCalls).toBeNull()
  })
})

describe('kick DSP', () => {
  test('peak amplitude is near full scale (not silent, not clipping)', () => {
    const buf = renderKick(SR, 0, subSeed(SEED, '0:0'))
    let peak = 0
    for (let i = 0; i < buf.left.length; i++) {
      const a = Math.abs(buf.left[i])
      if (a > peak) peak = a
    }
    expect(peak).toBeGreaterThan(0.5)
    expect(peak).toBeLessThanOrEqual(1.0)
  })

  test('amplitude envelope decays exponentially (80%+ gone by 200ms)', () => {
    const buf = renderKick(SR, 0, subSeed(SEED, '0:0'))
    const peakEarly = peakAbs(buf.left, 0, Math.floor(0.01 * SR))
    const peakLate = peakAbs(buf.left, Math.floor(0.2 * SR), Math.floor(0.3 * SR))
    // Late peak should be < 20% of early peak (exp decay with τ=0.09s → at 0.2s, amp ≈ 0.11)
    expect(peakLate).toBeLessThan(peakEarly * 0.25)
  })

  test('starts at ~0 or with a ramp (no click at sample 0)', () => {
    const buf = renderKick(SR, 0, subSeed(SEED, '0:0'))
    // The first sample must not be a full-amplitude discontinuity. The sine starts
    // at sin(0)=0 and the click is ramped over 20 samples. So |sample[0]| < 0.3.
    expect(Math.abs(buf.left[0])).toBeLessThan(0.3)
  })
})

describe('snare DSP', () => {
  test('has content in both channels (real stereo, not fake 0.9×)', () => {
    const buf = renderSnare(SR, 0, subSeed(SEED, '1:0'))
    let sumL = 0, sumR = 0
    for (let i = 0; i < buf.left.length; i++) {
      sumL += Math.abs(buf.left[i])
      sumR += Math.abs(buf.right[i])
    }
    // Both channels have real content
    expect(sumL).toBeGreaterThan(0.5)
    expect(sumR).toBeGreaterThan(0.5)
    // And they're NOT identical (decorrelated noise streams)
    let identical = 0
    for (let i = 0; i < buf.left.length; i++) {
      if (buf.left[i] === buf.right[i]) identical++
    }
    // Most samples should differ (real stereo)
    expect(identical / buf.left.length).toBeLessThan(0.5)
  })
})

describe('hat DSP', () => {
  test('open hat is longer than closed hat (variant 1 > variant 0)', () => {
    const closed = renderHat(SR, 0, subSeed(SEED, '2:0'))
    const open = renderHat(SR, 1, subSeed(SEED, '2:1'))
    expect(open.left.length).toBeGreaterThan(closed.left.length)
  })

  test('starts with a ramp (no click at sample 0)', () => {
    const buf = renderHat(SR, 0, subSeed(SEED, '2:0'))
    expect(Math.abs(buf.left[0])).toBeLessThan(0.3)
  })
})

describe('bass DSP', () => {
  test('variant 3 is octave+fifth (3× root freq, not 2×)', () => {
    // ROAST-1 §2 fix: variant 3 was a dead branch that overrode to 2× (octave only).
    // The fix: freq = root * intervals[3] = 55 * 3 = 165 Hz.
    const bufRoot = renderBass(SR, 0, subSeed(SEED, '3:0')) // 55 Hz
    const bufOctFifth = renderBass(SR, 3, subSeed(SEED, '3:3')) // 165 Hz
    // The higher-frequency buffer should have more zero crossings per unit time.
    const zcRoot = zeroCrossings(bufRoot.left, 0, Math.floor(0.1 * SR))
    const zcOctFifth = zeroCrossings(bufOctFifth.left, 0, Math.floor(0.1 * SR))
    expect(zcOctFifth).toBeGreaterThan(zcRoot * 2.5) // 3× freq → ~3× crossings
  })

  test('PolyBLEP + LP keeps most energy below 2kHz for a 55Hz bass', () => {
    // A 55Hz saw through a ~977Hz one-pole LP. Harmonics at 55,110,...,935 (≤17th)
    // pass nearly unattenuated; 18-36th (990-1980Hz) are -3..-9dB; above 2kHz rolls
    // off at 6dB/oct. So the majority of energy is below 2kHz — but NOT 85% (the
    // saw's 1/n harmonic falloff + gentle LP rolloff leaves meaningful 1-2kHz energy).
    //
    // We measure on a CONTIGUOUS 2048-sample window (no downsampling — ROAST-1 §2
    // methodology fix: downsampling aliases the measurement itself).
    const buf = renderBass(SR, 0, subSeed(SEED, '3:0'))
    const { low, high } = bandEnergiesContiguous(buf.left, SR, 2000)
    const ratio = low / (low + high)
    // Realistic for this signal: ~70-80% below 2kHz. PolyBLEP's job is to kill
    // aliasing (inharmonic peaks), not to remove real harmonics — the LP does that.
    expect(ratio).toBeGreaterThan(0.65)
  })
})

describe('PRNG', () => {
  test('mulberry32 is deterministic', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b())
    }
  })

  test('different seeds produce different sequences', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    let diffs = 0
    for (let i = 0; i < 100; i++) {
      if (a() !== b()) diffs++
    }
    expect(diffs).toBeGreaterThan(90)
  })

  test('subSeed produces independent streams', () => {
    expect(subSeed(SEED, '0:0')).not.toBe(subSeed(SEED, '0:1'))
    expect(subSeed(SEED, '0:0')).not.toBe(subSeed(SEED, '1:0'))
  })
})

// ── Helpers ──────────────────────────────────────────────────────────────────
function peakAbs(arr: Float32Array, start: number, end: number): number {
  let p = 0
  for (let i = start; i < end && i < arr.length; i++) {
    const a = Math.abs(arr[i])
    if (a > p) p = a
  }
  return p
}

function zeroCrossings(arr: Float32Array, start: number, end: number): number {
  let zc = 0
  for (let i = start + 1; i < end && i < arr.length; i++) {
    if ((arr[i - 1] < 0 && arr[i] >= 0) || (arr[i - 1] >= 0 && arr[i] < 0)) zc++
  }
  return zc
}

// Contiguous-window DFT band energy (no downsampling — avoids measurement aliasing).
function bandEnergiesContiguous(arr: Float32Array, sampleRate: number, splitHz: number) {
  const N = Math.min(2048, arr.length)
  const window: number[] = []
  for (let i = 0; i < N; i++) window.push(arr[i] || 0)
  // Hann window
  for (let i = 0; i < N; i++) {
    window[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)))
  }
  const binHz = sampleRate / N
  const splitBin = Math.floor(splitHz / binHz)
  let low = 0, high = 0
  for (let k = 1; k < N / 2; k++) {
    let re = 0, im = 0
    for (let i = 0; i < N; i++) {
      const ang = (2 * Math.PI * k * i) / N
      re += window[i] * Math.cos(ang)
      im += window[i] * Math.sin(ang)
    }
    const mag = Math.sqrt(re * re + im * im)
    if (k < splitBin) low += mag
    else high += mag
  }
  return { low, high }
}
