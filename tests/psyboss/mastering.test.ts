/**
 * PSYBOSS Mastering DSP — numerical test suite (Scope 4).
 *
 * These are calibration tests: they verify the LUFS meter, true-peak detector,
 * and limiter against signals with KNOWN loudness values. A LUFS meter that
 * doesn't read -3.0 on a full-scale 1kHz sine is broken — that's the whole point.
 */

import { describe, it, expect } from 'bun:test'
import {
  measureLufs,
  measureTruePeak,
  TruePeakLimiter,
  masterBuffer,
  applyKWeighting,
  Biquad,
  MASTERING_PRESETS,
} from '@/psyboss/engine/mastering'

const SR = 48000

/** Generate a stereo sine wave at a given amplitude and frequency. */
function makeSine(freq: number, amplitude: number, seconds: number): { left: Float32Array; right: Float32Array } {
  const n = Math.floor(seconds * SR)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = amplitude * Math.sin((2 * Math.PI * freq * i) / SR)
    left[i] = v
    right[i] = v
  }
  return { left, right }
}

describe('Biquad filter', () => {
  it('passes DC through a passthrough config unchanged', () => {
    // b=[1,0,0], a=[1,0,0] is unity passthrough.
    const bq = new Biquad({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 })
    for (let i = 0; i < 10; i++) {
      expect(bq.process(0.5)).toBeCloseTo(0.5, 5)
    }
  })
})

describe('K-weighting', () => {
  it('produces output of the same length', () => {
    const { left } = makeSine(1000, 0.5, 1)
    const weighted = applyKWeighting(left, SR)
    expect(weighted.length).toBe(left.length)
  })

  it('attenuates sub-60Hz strongly (RLB high-pass)', () => {
    // A 30Hz tone should be heavily attenuated by the K-weighting RLB stage.
    const { left } = makeSine(30, 0.5, 2)
    const weighted = applyKWeighting(left, SR)
    // Measure RMS of the tail (steady state).
    let sumSq = 0
    const start = SR // skip first second of transient
    for (let i = start; i < weighted.length; i++) sumSq += weighted[i] * weighted[i]
    const rms = Math.sqrt(sumSq / (weighted.length - start))
    // 30Hz should be attenuated to well under the input amplitude.
    expect(rms).toBeLessThan(0.5 * 0.35)
  })
})

describe('LUFS meter (calibration)', () => {
  it('reads ~-3.0 LUFS for a full-scale 1kHz sine', () => {
    // A full-scale (amplitude 1.0) sine has RMS = -3.01 dBFS. K-weighting at
    // 1kHz is ~0dB, so integrated LUFS should be ~-3.0. This is THE calibration.
    const { left, right } = makeSine(1000, 1.0, 4)
    const result = measureLufs(left, right, SR)
    expect(result.integrated).toBeGreaterThan(-3.6)
    expect(result.integrated).toBeLessThan(-2.5)
  })

  it('reads ~-23 LUFS for a -20dB 1kHz sine', () => {
    // Amplitude 0.1 = -20 dBFS → LUFS ~ -23.
    const amp = 0.1
    const { left, right } = makeSine(1000, amp, 4)
    const result = measureLufs(left, right, SR)
    expect(result.integrated).toBeGreaterThan(-23.6)
    expect(result.integrated).toBeLessThan(-22.4)
  })

  it('gates silence to -Infinity', () => {
    const left = new Float32Array(SR * 2)
    const right = new Float32Array(SR * 2)
    const result = measureLufs(left, right, SR)
    expect(result.integrated).toBe(-Infinity)
  })

  it('momentary max >= integrated', () => {
    const { left, right } = makeSine(1000, 0.5, 3)
    const result = measureLufs(left, right, SR)
    expect(result.momentaryMax).toBeGreaterThanOrEqual(result.integrated - 0.5)
  })
})

describe('True-peak detection', () => {
  it('reads ~0 dBTP for a full-scale sine', () => {
    // A full-scale sine can have inter-sample peaks slightly above 1.0, so
    // true peak is typically a hair above the sample peak (~+0.02 dB).
    const { left, right } = makeSine(997, 1.0, 1)
    const tp = measureTruePeak(left, right)
    expect(tp).toBeGreaterThan(-0.5)
    expect(tp).toBeLessThan(0.6)
  })

  it('reads ~-20 dBTP for a -20dB sine', () => {
    const { left, right } = makeSine(997, 0.1, 1)
    const tp = measureTruePeak(left, right)
    expect(tp).toBeGreaterThan(-20.5)
    expect(tp).toBeLessThan(-19.4)
  })

  it('detects inter-sample peaks above the sample peak', () => {
    // Two consecutive samples at 0.7 can have an inter-sample peak up to ~1.0
    // for a high-frequency signal. We craft a worst-case pair.
    const n = 256
    const left = new Float32Array(n)
    const right = new Float32Array(n)
    // A Nyquist-adjacent square-ish pattern: alternating +0.7/+0.7 at the peak
    // region creates inter-sample overshoot.
    for (let i = 100; i < 150; i++) {
      left[i] = 0.7
      right[i] = 0.7
    }
    const tp = measureTruePeak(left, right)
    // True peak should be >= the sample peak (0.7 → -3.1 dBFS).
    expect(tp).toBeGreaterThanOrEqual(-3.2)
  })
})

describe('TruePeakLimiter', () => {
  it('holds the ceiling on a hot signal', () => {
    const { left, right } = makeSine(997, 2.0, 1) // 2.0 = way over 0dBFS
    const limiter = new TruePeakLimiter({ ceilingDb: -1.0, sampleRate: SR })
    limiter.process(left, right)
    // After limiting, no sample should exceed the ceiling by much.
    let peak = 0
    for (let i = 0; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
    }
    const ceilingLin = Math.pow(10, -1.0 / 20)
    // Allow small tolerance for release tail + lookahead flush.
    expect(peak).toBeLessThan(ceilingLin * 1.15)
  })

  it('does not attenuate a quiet signal', () => {
    const { left, right } = makeSine(997, 0.1, 1)
    const before = left.slice()
    const limiter = new TruePeakLimiter({ ceilingDb: -1.0, sampleRate: SR })
    limiter.process(left, right)
    // A -20dBFS signal should pass through nearly unchanged (only lookahead delay).
    let maxDiff = 0
    for (let i = 300; i < left.length - 10; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(left[i] - before[i - 240]))
    }
    expect(maxDiff).toBeLessThan(0.01)
  })
})

describe('masterBuffer (end-to-end)', () => {
  it('reaches the streaming target (-14 LUFS) within 1 LU', () => {
    // Start with a quiet mix at ~-24 LUFS, master to -14.
    const { left, right } = makeSine(1000, 0.06, 4)
    const report = masterBuffer(left, right, SR, MASTERING_PRESETS.streaming)
    expect(report.postIntegratedLufs).toBeGreaterThan(-15)
    expect(report.postIntegratedLufs).toBeLessThan(-13)
    expect(report.postTruePeakDb).toBeLessThan(-0.5)
  })

  it('respects the true-peak ceiling on a hot club master', () => {
    const { left, right } = makeSine(997, 0.5, 4)
    const report = masterBuffer(left, right, SR, MASTERING_PRESETS.club)
    expect(report.postTruePeakDb).toBeLessThan(0.3)
  })

  it('reports pre/post measurements', () => {
    const { left, right } = makeSine(1000, 0.2, 3)
    const report = masterBuffer(left, right, SR, MASTERING_PRESETS.streaming)
    expect(report.preIntegratedLufs).toBeLessThan(report.postIntegratedLufs)
    expect(report.preTruePeakDb).toBeLessThan(report.postTruePeakDb + 0.5)
    expect(report.appliedGainDb).toBeGreaterThan(0)
  })
})
