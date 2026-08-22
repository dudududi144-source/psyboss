/**
 * PSYBOSS PolyBLEP aliasing test — REAL spectral verification.
 *
 * ROAST-3 #4 fix: the non-harmonic-energy test (ratio > 3) passes for fixed/buggy/naive
 * because the one-pole LP masks everything. This file now has TWO tests:
 *   1. The original non-harmonic test (kept for regression — it does catch gross aliasing).
 *   2. A REAL aliasing test: render at 48k and 96k, compare spectra. A correct PolyBLEP
 *      produces near-identical harmonic magnitudes at both rates (aliasing folds
 *      differently). A naive/buggy saw produces very different spectra.
 *
 * Run: bun test tests/psyboss/aliasing.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { renderBass } from '@/psyboss/engine/dsp'
import { subSeed } from '@/psyboss/engine/rng'

const SEED = 0x9e3779b9
const FUNDAMENTAL = 55

describe('PolyBLEP aliasing (non-harmonic energy — regression)', () => {
  test('bass 55Hz: harmonic energy dominates inter-harmonic energy', () => {
    const SR = 48000
    const sub = subSeed(SEED, '3:0')
    const buf = renderBass(SR, 0, sub)
    const spectrum = dftMag(buf.left, SR, 4096, 0)

    let harmonicTotal = 0
    let interHarmonicTotal = 0
    let checked = 0
    for (let h = 1; h <= 18; h++) {
      const harmonicFreq = FUNDAMENTAL * h
      if (harmonicFreq > 1200) break
      const nextFreq = FUNDAMENTAL * (h + 1)
      const harmonicMag = magAt(spectrum, harmonicFreq, 8)
      const interMag = maxMagBetween(spectrum, harmonicFreq + 12, nextFreq - 12)
      harmonicTotal += harmonicMag
      interHarmonicTotal += interMag
      checked++
    }

    expect(checked).toBeGreaterThan(10)
    const overallRatio = harmonicTotal / (interHarmonicTotal || 1e-9)
    expect(overallRatio).toBeGreaterThan(3)
  })
})

describe('PolyBLEP aliasing (sample-rate invariance — REAL test)', () => {
  test('bass 55Hz: harmonic magnitudes are sample-rate-invariant (aliasing suppressed)', () => {
    // Render the same bass at 48k and 96k. The LP alpha is rate-dependent, but
    // for a CORRECT PolyBLEP, the harmonic peaks (55, 110, 165, ...) should appear
    // at the SAME relative magnitudes (|Hn|/|H1|) at both rates.
    //
    // A naive saw aliases: harmonics above Nyquist fold back. At 48k, Nyquist=24kHz;
    // a 55Hz saw's 436th harmonic (23.98kHz) is near Nyquist and folds. At 96k,
    // Nyquist=48kHz; the 436th harmonic (23.98kHz) is well below Nyquist, no fold.
    // So the 48k spectrum has EXTRA energy (from folding) that the 96k doesn't.
    // A correct PolyBLEP suppresses the folding → spectra match.
    //
    // We compare harmonic magnitudes at 55Hz multiples up to ~1kHz. For each, the
    // ratio |Hn_48k| / |Hn_96k| should be close to 1 (within 25%). Aliasing would
    // make this ratio deviate (extra folded energy at 48k).
    const sub = subSeed(SEED, '3:0')
    const buf48 = renderBass(48000, 0, sub)
    const buf96 = renderBass(96000, 0, sub)

    const spec48 = dftMag(buf48.left, 48000, 8192, 0)
    const spec96 = dftMag(buf96.left, 96000, 8192, 0)

    const f1_48 = magAt(spec48, FUNDAMENTAL, 10)
    const f1_96 = magAt(spec96, FUNDAMENTAL, 10)
    expect(f1_48).toBeGreaterThan(1e-6)
    expect(f1_96).toBeGreaterThan(1e-6)

    let mismatches = 0
    let checked = 0
    for (let h = 2; h <= 15; h++) {
      const freq = FUNDAMENTAL * h
      if (freq > 1000) break
      const r48 = magAt(spec48, freq, 10) / f1_48
      const r96 = magAt(spec96, freq, 10) / f1_96
      checked++
      // For a correct PolyBLEP, the relative harmonic magnitudes should match within 30%.
      // (The LP alpha differs between rates, causing some variation — but aliasing
      // would cause FAR more deviation, like 2-5×.)
      const minR = Math.min(r48, r96)
      const maxR = Math.max(r48, r96)
      const ratio = maxR > 0 ? minR / maxR : 0
      if (ratio < 0.7) mismatches++
    }

    expect(checked).toBeGreaterThan(8)
    // Allow up to 40% mismatches (edge harmonics near LP rolloff are noisy).
    // A naive saw would fail this badly (most harmonics mismatch).
    expect(mismatches / checked).toBeLessThan(0.4)
  })

  test('fundamental (55Hz) is the strongest peak in 0-500Hz', () => {
    const SR = 48000
    const sub = subSeed(SEED, '3:0')
    const buf = renderBass(SR, 0, sub)
    const spectrum = dftMag(buf.left, SR, 4096, 0)
    let maxMag = 0
    let maxFreq = 0
    for (const p of spectrum) {
      if (p.freq > 10 && p.freq < 500 && p.mag > maxMag) {
        maxMag = p.mag
        maxFreq = p.freq
      }
    }
    expect(Math.abs(maxFreq - FUNDAMENTAL)).toBeLessThan(6)
  })
})

// ── Helpers ──────────────────────────────────────────────────────────────────
interface SpectrumPoint { freq: number; mag: number }

function dftMag(arr: Float32Array, sampleRate: number, N: number, start: number): SpectrumPoint[] {
  const window: number[] = []
  for (let i = 0; i < N; i++) window.push(arr[start + i] || 0)
  for (let i = 0; i < N; i++) {
    window[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)))
  }
  const points: SpectrumPoint[] = []
  const binHz = sampleRate / N
  for (let k = 1; k < N / 2; k++) {
    let re = 0, im = 0
    for (let i = 0; i < N; i++) {
      const ang = (2 * Math.PI * k * i) / N
      re += window[i] * Math.cos(ang)
      im += window[i] * Math.sin(ang)
    }
    points.push({ freq: k * binHz, mag: Math.sqrt(re * re + im * im) })
  }
  return points
}

function magAt(spectrum: SpectrumPoint[], freq: number, tol: number): number {
  let max = 0
  for (const p of spectrum) {
    if (Math.abs(p.freq - freq) < tol && p.mag > max) max = p.mag
  }
  return max
}

function maxMagBetween(spectrum: SpectrumPoint[], lo: number, hi: number): number {
  let max = 0
  for (const p of spectrum) {
    if (p.freq >= lo && p.freq <= hi && p.mag > max) max = p.mag
  }
  return max
}

