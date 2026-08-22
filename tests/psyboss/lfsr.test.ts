/**
 * PSYBOSS LFSR + conditional trigs tests — determinism + distribution.
 *
 * Run: bun test tests/psyboss/lfsr.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { LFSR16, evaluateCondition, type TrigCondition } from '@/psyboss/engine/lfsr'

describe('LFSR16', () => {
  test('is deterministic (same seed → same sequence)', () => {
    const a = new LFSR16(42)
    const b = new LFSR16(42)
    for (let i = 0; i < 1000; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  test('different seeds → different sequences', () => {
    const a = new LFSR16(1)
    const b = new LFSR16(2)
    let diffs = 0
    for (let i = 0; i < 1000; i++) {
      if (a.next() !== b.next()) diffs++
    }
    expect(diffs).toBeGreaterThan(400) // ~50% should differ
  })

  test('state never becomes 0 (fixed point)', () => {
    const lfsr = new LFSR16(1)
    for (let i = 0; i < 100000; i++) {
      lfsr.next()
      // Can't inspect state directly (private), but if it hit 0 it would
      // produce all-zeros forever. Verify output isn't all-zero over a window.
    }
    let ones = 0
    for (let i = 0; i < 1000; i++) {
      if (lfsr.next() === 1) ones++
    }
    expect(ones).toBeGreaterThan(400) // ~50% ones, not 0
  })

  test('chance(0.5) produces ~50% hits over many samples', () => {
    const lfsr = new LFSR16(123)
    let hits = 0
    const N = 10000
    for (let i = 0; i < N; i++) {
      if (lfsr.chance(0.5)) hits++
    }
    const ratio = hits / N
    expect(ratio).toBeGreaterThan(0.47)
    expect(ratio).toBeLessThan(0.53)
  })

  test('chance(1.0) always hits, chance(0) never hits', () => {
    const lfsr = new LFSR16(999)
    let hits = 0
    for (let i = 0; i < 100; i++) if (lfsr.chance(1.0)) hits++
    expect(hits).toBe(100)
    hits = 0
    for (let i = 0; i < 100; i++) if (lfsr.chance(0)) hits++
    expect(hits).toBe(0)
  })

  test('chance(0.25) produces ~25% hits', () => {
    const lfsr = new LFSR16(777)
    let hits = 0
    const N = 10000
    for (let i = 0; i < N; i++) if (lfsr.chance(0.25)) hits++
    const ratio = hits / N
    expect(ratio).toBeGreaterThan(0.22)
    expect(ratio).toBeLessThan(0.28)
  })
})

describe('evaluateCondition', () => {
  test('always → true', () => {
    const lfsr = new LFSR16(1)
    expect(evaluateCondition(lfsr, { kind: 'always' }, 0)).toBe(true)
    expect(evaluateCondition(lfsr, { kind: 'always' }, 100)).toBe(true)
  })

  test('probability → deterministic given same LFSR state', () => {
    const lfsr1 = new LFSR16(42)
    const lfsr2 = new LFSR16(42)
    const cond: TrigCondition = { kind: 'probability', p: 0.5 }
    for (let i = 0; i < 100; i++) {
      expect(evaluateCondition(lfsr1, cond, 0)).toBe(evaluateCondition(lfsr2, cond, 0))
    }
  })

  test('fill(everyBars=4) → true on bar 0, 4, 8, ...; false otherwise', () => {
    const lfsr = new LFSR16(1)
    const cond: TrigCondition = { kind: 'fill', everyBars: 4 }
    expect(evaluateCondition(lfsr, cond, 0)).toBe(true)
    expect(evaluateCondition(lfsr, cond, 1)).toBe(false)
    expect(evaluateCondition(lfsr, cond, 2)).toBe(false)
    expect(evaluateCondition(lfsr, cond, 3)).toBe(false)
    expect(evaluateCondition(lfsr, cond, 4)).toBe(true)
    expect(evaluateCondition(lfsr, cond, 8)).toBe(true)
    expect(evaluateCondition(lfsr, cond, 5)).toBe(false)
  })

  test('not-fill(everyBars=4) → inverse of fill', () => {
    const lfsr = new LFSR16(1)
    const cond: TrigCondition = { kind: 'not-fill', everyBars: 4 }
    expect(evaluateCondition(lfsr, cond, 0)).toBe(false)
    expect(evaluateCondition(lfsr, cond, 1)).toBe(true)
    expect(evaluateCondition(lfsr, cond, 4)).toBe(false)
    expect(evaluateCondition(lfsr, cond, 5)).toBe(true)
  })
})
