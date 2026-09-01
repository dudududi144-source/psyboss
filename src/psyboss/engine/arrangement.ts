/**
 * PSYBOSS Arrangement — Scope 4 (linear timeline).
 *
 * An Arrangement is a linear timeline of Clips. Each Clip places a Pattern at a
 * position on the timeline (startBar) for a duration (lengthBars). Rendering an
 * arrangement walks the clips in order, renders each into raw stereo audio, and
 * concatenates them into one full-length track — which can then be mastered.
 *
 * Design notes:
 *   - Clips are NON-OVERLAPPING on a single arrangement lane for v1 (the session
 *     matrix is the sound source; the arrangement sequences PATTERNS over time).
 *   - Overlapping / multi-lane arrangement is a future scope (would need a mixer
 *     per lane). For a psytrance track, sequential pattern arrangement is the
 *     dominant use case (intro → build → drop → outro).
 *   - Each clip can carry its own bpm/seed override, or inherit the arrangement's
 *     defaults. This lets a track modulate tempo across sections.
 *   - Deterministic: same arrangement + seeds → byte-identical WAV.
 */

import type { Pattern } from './sequencer'

export interface ArrangementClip {
  id: string
  /** The pattern to render for this clip. */
  pattern: Pattern
  /** Start position on the timeline (in bars). */
  startBar: number
  /** Duration of the clip (in bars). */
  lengthBars: number
  /** Optional per-clip bpm override (inherits arrangement bpm if unset). */
  bpm?: number
  /** Optional per-clip seed override (inherits arrangement seed if unset). */
  seed?: number
  /** Human label (e.g. "Intro", "Build", "Drop", "Outro"). */
  label?: string
}

export interface Arrangement {
  id: string
  name: string
  /** Default bpm for clips that don't override. */
  bpm: number
  /** Default seed for clips that don't override. */
  seed: number
  clips: ArrangementClip[]
}

export function createArrangement(name: string, bpm: number, seed: number): Arrangement {
  return {
    id: `arr-${seed.toString(16)}-${Date.now().toString(36)}`,
    name,
    bpm,
    seed,
    clips: [],
  }
}

/** Total length of the arrangement in bars (max clip end). */
export function arrangementLengthBars(arr: Arrangement): number {
  let max = 0
  for (const clip of arr.clips) {
    const end = clip.startBar + clip.lengthBars
    if (end > max) max = end
  }
  return max
}

/** Add a clip, keeping the clips sorted by startBar. Returns a new Arrangement. */
export function addClip(arr: Arrangement, clip: ArrangementClip): Arrangement {
  const clips = [...arr.clips, clip].sort((a, b) => a.startBar - b.startBar)
  return { ...arr, clips }
}

/** Remove a clip by id. Returns a new Arrangement. */
export function removeClip(arr: Arrangement, clipId: string): Arrangement {
  return { ...arr, clips: arr.clips.filter((c) => c.id !== clipId) }
}

/** Move a clip to a new startBar. Returns a new Arrangement. */
export function moveClip(arr: Arrangement, clipId: string, newStartBar: number): Arrangement {
  const clips = arr.clips
    .map((c) => (c.id === clipId ? { ...c, startBar: Math.max(0, newStartBar) } : c))
    .sort((a, b) => a.startBar - b.startBar)
  return { ...arr, clips }
}

/** Check for overlapping clips (v1 constraint). Returns pairs of overlapping ids. */
export function findOverlaps(arr: Arrangement): Array<[string, string]> {
  const overlaps: Array<[string, string]> = []
  const sorted = [...arr.clips].sort((a, b) => a.startBar - b.startBar)
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]
      const b = sorted[j]
      if (b.startBar < a.startBar + a.lengthBars) {
        overlaps.push([a.id, b.id])
      }
    }
  }
  return overlaps
}

/** Create a labeled clip at the end of the current timeline (a common workflow). */
export function appendClip(
  arr: Arrangement,
  pattern: Pattern,
  lengthBars: number,
  label?: string,
): { arrangement: Arrangement; clip: ArrangementClip } {
  const startBar = arrangementLengthBars(arr)
  const clip: ArrangementClip = {
    id: `clip-${startBar}-${arr.clips.length}`,
    pattern,
    startBar,
    lengthBars,
    label,
  }
  return { arrangement: addClip(arr, clip), clip }
}
