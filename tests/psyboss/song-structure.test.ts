/**
 * PSYBOSS Song Structure — test suite.
 * Verifies the section arc resolves correctly across the looping timeline.
 *
 * Run: bun test tests/psyboss/song-structure.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { SONG_STRUCTURE, SONG_TOTAL_BARS, sectionAtBar } from '@/psyboss/engine/song-structure'

describe('song structure', () => {
  test('total bars is the sum of all sections', () => {
    const sum = SONG_STRUCTURE.reduce((a, s) => a + s.bars, 0)
    expect(SONG_TOTAL_BARS).toBe(sum)
  })

  test('bar 0 is the first section (INTRO)', () => {
    const { section, sectionIndex } = sectionAtBar(0)
    expect(sectionIndex).toBe(0)
    expect(section.name).toBe('INTRO')
  })

  test('section boundaries resolve to the next section', () => {
    // INTRO is 8 bars, so bar 8 is the start of BUILD (section index 1).
    const { sectionIndex } = sectionAtBar(8)
    expect(sectionIndex).toBe(1)
  })

  test('the structure loops after SONG_TOTAL_BARS', () => {
    const atStart = sectionAtBar(0)
    const atLoop = sectionAtBar(SONG_TOTAL_BARS)
    expect(atLoop.section.name).toBe(atStart.section.name)
    expect(atLoop.sectionIndex).toBe(atStart.sectionIndex)
  })

  test('negative bars wrap correctly (no crash)', () => {
    const { sectionIndex } = sectionAtBar(-1)
    expect(sectionIndex).toBeGreaterThanOrEqual(0)
    expect(sectionIndex).toBeLessThan(SONG_STRUCTURE.length)
  })

  test('DROP sections activate all 10 tracks', () => {
    // DROP starts at bar 16 (INTRO 8 + BUILD 8).
    const { section, activeTracks } = sectionAtBar(16)
    expect(section.name).toBe('DROP')
    expect(activeTracks.size).toBe(10)
  })

  test('INTRO keeps only kick+bass', () => {
    const { activeTracks } = sectionAtBar(0)
    expect(activeTracks.has(0)).toBe(true) // kick
    expect(activeTracks.has(1)).toBe(true) // bass
    expect(activeTracks.has(2)).toBe(false) // lead muted in intro
  })

  test('BREAKDOWN drops the kick', () => {
    // BREAKDOWN is the 4th section: INTRO(8)+BUILD(8)+DROP(8) = bar 24.
    const { section, activeTracks } = sectionAtBar(24)
    expect(section.name).toBe('BREAKDOWN')
    expect(activeTracks.has(0)).toBe(false) // kick muted in breakdown
    expect(activeTracks.has(6)).toBe(true)  // pad present
  })
})
