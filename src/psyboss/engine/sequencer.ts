/**
 * PSYBOSS step sequencer model — the pattern layer.
 *
 * A Pattern is a grid of Steps per Track. Each Step can be:
 *   - empty (no trig)
 *   - a trig (fires the track's current scene)
 *   - a trig with a parameter lock (overrides the track's param for this step)
 *   - a trig with a condition (probability/fill/not-fill)
 *
 * This is the Elektron model: per-step parameter locks + conditional trigs.
 * Patterns are deterministic functions of (seed, patternId) — replay-identical.
 *
 * The sequencer publishes `trig` envelopes on PSYBUS at each step's audio-time.
 */

import { LFSR16, evaluateCondition, type TrigCondition } from './lfsr'
import { subSeed } from './rng'
import type { SampleRef } from '@/psybus/types'

export const STEPS_PER_BAR = 16 // 16th notes in 4/4

export interface ParameterLock {
  param: string // e.g. 'gain', 'filter', 'scene'
  value: number
}

export interface Step {
  active: boolean // does this step fire?
  scene: number // which scene variant to trigger (0-3)
  condition: TrigCondition // when does this step fire?
  locks: ParameterLock[] // per-step parameter overrides
  sampleRef?: SampleRef // optional: use a loaded sample instead of procedural DSP
}

export interface Pattern {
  id: string
  seed: number
  tracks: Step[][] // [trackIndex][stepIndex] → Step
}

/** Create an empty pattern (all steps inactive, condition 'always'). */
export function createPattern(seed: number, numTracks: number, numSteps = STEPS_PER_BAR): Pattern {
  const tracks: Step[][] = []
  for (let t = 0; t < numTracks; t++) {
    const steps: Step[] = []
    for (let s = 0; s < numSteps; s++) {
      steps.push({
        active: false,
        scene: 0,
        condition: { kind: 'always' },
        locks: [],
      })
    }
    tracks.push(steps)
  }
  return { id: `pattern-${seed}`, seed, tracks }
}

/** Toggle a step's active state. Returns a new Pattern (immutable). */
export function toggleStep(pattern: Pattern, track: number, step: number): Pattern {
  const tracks = pattern.tracks.map((t, ti) => {
    if (ti !== track) return t
    return t.map((s, si) => (si === step ? { ...s, active: !s.active } : s))
  })
  return { ...pattern, tracks }
}

/** Set a step's scene. Returns a new Pattern. */
export function setStepScene(pattern: Pattern, track: number, step: number, scene: number): Pattern {
  const tracks = pattern.tracks.map((t, ti) => {
    if (ti !== track) return t
    return t.map((s, si) => (si === step ? { ...s, scene } : s))
  })
  return { ...pattern, tracks }
}

/** Set a step's condition. Returns a new Pattern. */
export function setStepCondition(
  pattern: Pattern,
  track: number,
  step: number,
  condition: TrigCondition,
): Pattern {
  const tracks = pattern.tracks.map((t, ti) => {
    if (ti !== track) return t
    return t.map((s, si) => (si === step ? { ...s, condition } : s))
  })
  return { ...pattern, tracks }
}

/** Add a parameter lock to a step. Returns a new Pattern. */
export function addParameterLock(
  pattern: Pattern,
  track: number,
  step: number,
  lock: ParameterLock,
): Pattern {
  const tracks = pattern.tracks.map((t, ti) => {
    if (ti !== track) return t
    return t.map((s, si) => {
      if (si !== step) return s
      // Replace existing lock for the same param, or add new.
      const others = s.locks.filter((l) => l.param !== lock.param)
      return { ...s, locks: [...others, lock] }
    })
  })
  return { ...pattern, tracks }
}

/** Set a step's sampleRef (assign a loaded sample). null = use procedural DSP. */
export function setStepSample(
  pattern: Pattern,
  track: number,
  step: number,
  sampleRef: SampleRef | null,
): Pattern {
  const tracks = pattern.tracks.map((t, ti) => {
    if (ti !== track) return t
    return t.map((s, si) => (si === step ? { ...s, sampleRef: sampleRef ?? undefined } : s))
  })
  return { ...pattern, tracks }
}

export interface ScheduledStep {
  track: number
  step: number
  scene: number
  audioTime: number
  locks: ParameterLock[]
  sampleRef?: SampleRef
}

/**
 * Collect all steps that should fire in the given time window.
 *
 * @param pattern     the pattern to scan
 * @param fromStep    the step index to start from (inclusive)
 * @param toStep      the step index to end at (exclusive)
 * @param barNumber   the current bar number (for fill conditions)
 * @param stepSeconds seconds per 16th-note step
 * @param barStartTime audio-context time of the bar's first step
 * @param seed        the performance seed (for LFSR determinism)
 * @returns array of scheduled steps that passed their condition
 */
export function collectScheduledSteps(
  pattern: Pattern,
  fromStep: number,
  toStep: number,
  barNumber: number,
  stepSeconds: number,
  barStartTime: number,
  seed: number,
): ScheduledStep[] {
  const out: ScheduledStep[] = []
  for (let t = 0; t < pattern.tracks.length; t++) {
    const trackSteps = pattern.tracks[t]
    // Each track gets its own LFSR stream (independent conditions).
    const lfsr = new LFSR16(subSeed(seed, `track-${t}`))
    // Fast-forward the LFSR to the current bar (so conditions are stable per-bar).
    for (let b = 0; b < barNumber; b++) {
      for (let s = 0; s < trackSteps.length; s++) {
        const step = trackSteps[s]
        if (step.active) evaluateCondition(lfsr, step.condition, b)
      }
    }
    for (let s = fromStep; s < toStep && s < trackSteps.length; s++) {
      const step = trackSteps[s]
      if (!step.active) continue
      if (!evaluateCondition(lfsr, step.condition, barNumber)) continue
      out.push({
        track: t,
        step: s,
        scene: step.scene,
        audioTime: barStartTime + s * stepSeconds,
        locks: step.locks,
        sampleRef: step.sampleRef, // ROAST-4 #2: carry sampleRef to scheduleVoice
      })
    }
  }
  return out
}
