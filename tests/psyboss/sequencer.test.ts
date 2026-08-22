/**
 * PSYBOSS sequencer + parameter locks tests.
 *
 * Run: bun test tests/psyboss/sequencer.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  createPattern,
  toggleStep,
  setStepScene,
  setStepCondition,
  addParameterLock,
  collectScheduledSteps,
  STEPS_PER_BAR,
  type ParameterLock,
} from '@/psyboss/engine/sequencer'
import type { TrigCondition } from '@/psyboss/engine/lfsr'

const SEED = 0x9e3779b9
const NUM_TRACKS = 4

describe('pattern model', () => {
  test('createPattern produces an empty 4×16 grid', () => {
    const p = createPattern(SEED, NUM_TRACKS)
    expect(p.tracks.length).toBe(NUM_TRACKS)
    expect(p.tracks[0].length).toBe(STEPS_PER_BAR)
    expect(p.tracks[0][0].active).toBe(false)
    expect(p.tracks[0][0].condition).toEqual({ kind: 'always' })
    expect(p.tracks[0][0].locks).toEqual([])
  })

  test('toggleStep flips active and is immutable', () => {
    const p = createPattern(SEED, NUM_TRACKS)
    const p2 = toggleStep(p, 0, 0)
    expect(p.tracks[0][0].active).toBe(false) // original unchanged
    expect(p2.tracks[0][0].active).toBe(true)
    const p3 = toggleStep(p2, 0, 0)
    expect(p3.tracks[0][0].active).toBe(false)
  })

  test('setStepScene changes the scene variant', () => {
    const p = createPattern(SEED, NUM_TRACKS)
    const p2 = setStepScene(p, 1, 2, 3)
    expect(p2.tracks[1][2].scene).toBe(3)
    expect(p.tracks[1][2].scene).toBe(0) // immutable
  })

  test('setStepCondition sets a probability condition', () => {
    const p = createPattern(SEED, NUM_TRACKS)
    const cond: TrigCondition = { kind: 'probability', p: 0.5 }
    const p2 = setStepCondition(p, 2, 4, cond)
    expect(p2.tracks[2][4].condition).toEqual(cond)
  })

  test('addParameterLock adds a new lock', () => {
    const p = createPattern(SEED, NUM_TRACKS)
    const lock: ParameterLock = { param: 'gain', value: 0.5 }
    const p2 = addParameterLock(p, 0, 0, lock)
    expect(p2.tracks[0][0].locks).toEqual([lock])
  })

  test('addParameterLock replaces existing lock for the same param', () => {
    const p = createPattern(SEED, NUM_TRACKS)
    const p2 = addParameterLock(p, 0, 0, { param: 'gain', value: 0.5 })
    const p3 = addParameterLock(p2, 0, 0, { param: 'gain', value: 0.8 })
    expect(p3.tracks[0][0].locks).toEqual([{ param: 'gain', value: 0.8 }])
    expect(p3.tracks[0][0].locks.length).toBe(1)
  })

  test('addParameterLock keeps different params separate', () => {
    const p = createPattern(SEED, NUM_TRACKS)
    const p2 = addParameterLock(p, 0, 0, { param: 'gain', value: 0.5 })
    const p3 = addParameterLock(p2, 0, 0, { param: 'filter', value: 0.3 })
    expect(p3.tracks[0][0].locks.length).toBe(2)
  })
})

describe('collectScheduledSteps', () => {
  test('empty pattern → no scheduled steps', () => {
    const p = createPattern(SEED, NUM_TRACKS)
    const scheduled = collectScheduledSteps(p, 0, STEPS_PER_BAR, 0, 0.1, 0, SEED)
    expect(scheduled.length).toBe(0)
  })

  test('active step → scheduled at correct audio time', () => {
    const p = createPattern(SEED, NUM_TRACKS)
    const p2 = toggleStep(p, 0, 4) // track 0, step 4
    const scheduled = collectScheduledSteps(p2, 0, STEPS_PER_BAR, 0, 0.1, 1.0, SEED)
    expect(scheduled.length).toBe(1)
    expect(scheduled[0].track).toBe(0)
    expect(scheduled[0].step).toBe(4)
    expect(scheduled[0].audioTime).toBe(1.0 + 4 * 0.1) // barStartTime + step * stepSeconds
  })

  test('multiple active steps → all scheduled', () => {
    let p = createPattern(SEED, NUM_TRACKS)
    p = toggleStep(p, 0, 0)
    p = toggleStep(p, 0, 4)
    p = toggleStep(p, 0, 8)
    p = toggleStep(p, 0, 12) // four-on-the-floor kick
    p = toggleStep(p, 2, 2)
    p = toggleStep(p, 2, 6)
    p = toggleStep(p, 2, 10)
    p = toggleStep(p, 2, 14) // off-beat hats
    const scheduled = collectScheduledSteps(p, 0, STEPS_PER_BAR, 0, 0.1, 0, SEED)
    expect(scheduled.length).toBe(8)
  })

  test('probability condition is deterministic given the same seed', () => {
    let p = createPattern(SEED, NUM_TRACKS)
    p = toggleStep(p, 0, 0)
    p = setStepCondition(p, 0, 0, { kind: 'probability', p: 0.5 })
    const s1 = collectScheduledSteps(p, 0, STEPS_PER_BAR, 0, 0.1, 0, SEED)
    const s2 = collectScheduledSteps(p, 0, STEPS_PER_BAR, 0, 0.1, 0, SEED)
    // Same seed → same LFSR state → same decision.
    expect(s1.length).toBe(s2.length)
  })

  test('fill condition: fires on bar 0 and 4, not on bar 1-3', () => {
    let p = createPattern(SEED, NUM_TRACKS)
    p = toggleStep(p, 0, 0)
    p = setStepCondition(p, 0, 0, { kind: 'fill', everyBars: 4 })
    // Bar 0: fill → fires
    expect(collectScheduledSteps(p, 0, 1, 0, 0.1, 0, SEED).length).toBe(1)
    // Bar 1-3: not fill → no fire
    expect(collectScheduledSteps(p, 0, 1, 1, 0.1, 0, SEED).length).toBe(0)
    expect(collectScheduledSteps(p, 0, 1, 2, 0.1, 0, SEED).length).toBe(0)
    expect(collectScheduledSteps(p, 0, 1, 3, 0.1, 0, SEED).length).toBe(0)
    // Bar 4: fill → fires
    expect(collectScheduledSteps(p, 0, 1, 4, 0.1, 0, SEED).length).toBe(1)
  })

  test('parameter locks are carried through to the scheduled step', () => {
    let p = createPattern(SEED, NUM_TRACKS)
    p = toggleStep(p, 0, 0)
    p = addParameterLock(p, 0, 0, { param: 'gain', value: 0.3 })
    const scheduled = collectScheduledSteps(p, 0, STEPS_PER_BAR, 0, 0.1, 0, SEED)
    expect(scheduled[0].locks).toEqual([{ param: 'gain', value: 0.3 }])
  })
})
