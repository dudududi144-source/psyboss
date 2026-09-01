/**
 * PSYBOSS Reference analysis — test suite (Scope 4 A/B).
 *
 * The decoding path (analyzeReference) needs a browser AudioContext and is
 * covered by E2E. Here we test the pure comparison math, which is the part
 * that encodes the mastering judgment.
 */

import { describe, it, expect } from 'bun:test'
import { compareLoudness, type ReferenceAnalysis } from '@/psyboss/engine/reference'

function makeRef(integratedLufs: number): ReferenceAnalysis {
  return {
    name: 'reference.wav',
    durationSec: 180,
    sampleRate: 44100,
    lufs: {
      integrated: integratedLufs,
      ungated: integratedLufs,
      momentaryMax: integratedLufs + 2,
      blockCount: 1000,
    },
    truePeakDb: -1.0,
  }
}

describe('compareLoudness', () => {
  it('reports matched when within +-1 LU', () => {
    const ref = makeRef(-14)
    const result = compareLoudness(-13.5, ref)
    expect(result.deltaLu).toBeCloseTo(0.5, 1)
    expect(result.verdict).toContain('Loudness-matched')
  })

  it('reports louder master with negative gain-to-match', () => {
    const ref = makeRef(-14)
    const result = compareLoudness(-11, ref) // 3 LU louder
    expect(result.deltaLu).toBeCloseTo(3, 1)
    expect(result.gainToMatchDb).toBeCloseTo(-3, 1)
    expect(result.verdict).toContain('LOUDER')
  })

  it('reports quieter master with positive gain-to-match', () => {
    const ref = makeRef(-8)
    const result = compareLoudness(-11, ref) // 3 LU quieter
    expect(result.deltaLu).toBeCloseTo(-3, 1)
    expect(result.gainToMatchDb).toBeCloseTo(3, 1)
    expect(result.verdict).toContain('QUIETER')
  })

  it('exactly matched at identical loudness', () => {
    const ref = makeRef(-14)
    const result = compareLoudness(-14, ref)
    // toBeCloseTo (not toBe) — -(0) yields -0, and Object.is(-0, 0) is false.
    expect(result.deltaLu).toBeCloseTo(0, 10)
    expect(result.gainToMatchDb).toBeCloseTo(0, 10)
    expect(result.verdict).toContain('Loudness-matched')
  })
})
