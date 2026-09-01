/**
 * PSYBOSS Arrangement — test suite (Scope 4).
 *
 * Tests the linear timeline data model: clip placement, ordering, overlap
 * detection, and total-length calculation. These are pure data-model tests
 * (no audio), so they run fast and deterministic.
 */

import { describe, it, expect } from 'bun:test'
import {
  createArrangement,
  addClip,
  removeClip,
  moveClip,
  appendClip,
  arrangementLengthBars,
  findOverlaps,
  type ArrangementClip,
} from '@/psyboss/engine/arrangement'
import { createPattern, type Pattern } from '@/psyboss/engine/sequencer'

function makePattern(seed: number): Pattern {
  return createPattern(seed, 4)
}

function makeClip(startBar: number, lengthBars: number, pattern?: Pattern): ArrangementClip {
  return {
    id: `clip-${startBar}`,
    pattern: pattern ?? makePattern(0x1234),
    startBar,
    lengthBars,
  }
}

describe('Arrangement data model', () => {
  it('creates an empty arrangement', () => {
    const arr = createArrangement('Test Track', 144, 0x9e3779b9)
    expect(arr.clips).toEqual([])
    expect(arr.bpm).toBe(144)
    expect(arrangementLengthBars(arr)).toBe(0)
  })

  it('adds clips and computes total length', () => {
    let arr = createArrangement('Test', 144, 0x1)
    arr = addClip(arr, makeClip(0, 8))
    arr = addClip(arr, makeClip(8, 8))
    arr = addClip(arr, makeClip(16, 16))
    expect(arr.clips.length).toBe(3)
    expect(arrangementLengthBars(arr)).toBe(32)
  })

  it('keeps clips sorted by startBar regardless of insertion order', () => {
    let arr = createArrangement('Test', 144, 0x1)
    arr = addClip(arr, makeClip(16, 4))
    arr = addClip(arr, makeClip(0, 4))
    arr = addClip(arr, makeClip(8, 4))
    expect(arr.clips[0].startBar).toBe(0)
    expect(arr.clips[1].startBar).toBe(8)
    expect(arr.clips[2].startBar).toBe(16)
  })

  it('removes a clip by id', () => {
    let arr = createArrangement('Test', 144, 0x1)
    arr = addClip(arr, makeClip(0, 8))
    arr = addClip(arr, makeClip(8, 8))
    expect(arr.clips.length).toBe(2)
    arr = removeClip(arr, 'clip-0')
    expect(arr.clips.length).toBe(1)
    expect(arr.clips[0].startBar).toBe(8)
  })

  it('moves a clip to a new position', () => {
    let arr = createArrangement('Test', 144, 0x1)
    arr = addClip(arr, makeClip(0, 8))
    arr = moveClip(arr, 'clip-0', 32)
    expect(arr.clips[0].startBar).toBe(32)
  })

  it('never moves a clip to a negative position', () => {
    let arr = createArrangement('Test', 144, 0x1)
    arr = addClip(arr, makeClip(8, 8))
    arr = moveClip(arr, 'clip-8', -5)
    expect(arr.clips[0].startBar).toBe(0)
  })
})

describe('Arrangement overlap detection', () => {
  it('detects no overlaps for sequential clips', () => {
    let arr = createArrangement('Test', 144, 0x1)
    arr = addClip(arr, makeClip(0, 8))
    arr = addClip(arr, makeClip(8, 8))
    arr = addClip(arr, makeClip(16, 8))
    expect(findOverlaps(arr)).toEqual([])
  })

  it('detects overlapping clips', () => {
    let arr = createArrangement('Test', 144, 0x1)
    arr = addClip(arr, makeClip(0, 12)) // 0..12
    arr = addClip(arr, makeClip(8, 8)) // 8..16 -> overlaps with first
    const overlaps = findOverlaps(arr)
    expect(overlaps.length).toBe(1)
    expect(overlaps[0]).toEqual(['clip-0', 'clip-8'])
  })

  it('handles adjacent-but-not-overlapping clips', () => {
    let arr = createArrangement('Test', 144, 0x1)
    arr = addClip(arr, makeClip(0, 8)) // 0..8
    arr = addClip(arr, makeClip(8, 8)) // 8..16 (starts exactly where first ends)
    expect(findOverlaps(arr)).toEqual([])
  })
})

describe('appendClip helper', () => {
  it('appends a clip at the end of the timeline', () => {
    let arr = createArrangement('Test', 144, 0x1)
    const r1 = appendClip(arr, makePattern(1), 8, 'Intro')
    arr = r1.arrangement
    expect(r1.clip.startBar).toBe(0)
    const r2 = appendClip(arr, makePattern(2), 16, 'Drop')
    expect(r2.clip.startBar).toBe(8)
    expect(arrangementLengthBars(r2.arrangement)).toBe(24)
  })
})
