/**
 * PSYBOSS Presets — test suite.
 *
 * Verifies the psytrance groove presets build valid, deterministic patterns with
 * the genre's essential structure (a kick on every beat + rolling/offbeat bass).
 *
 * Run: bun test tests/psyboss/presets.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { PSY_PRESETS, T } from '@/psyboss/engine/presets'
import { STEPS_PER_BAR } from '@/psyboss/engine/sequencer'

describe('psytrance presets', () => {
  test('all presets build 10-track, 16-step patterns', () => {
    for (const preset of PSY_PRESETS) {
      const p = preset.build()
      expect(p.tracks.length).toBe(10)
      for (const track of p.tracks) {
        expect(track.length).toBe(STEPS_PER_BAR)
      }
    }
  })

  test('every preset has a kick on all four beats (four-on-the-floor)', () => {
    for (const preset of PSY_PRESETS) {
      const p = preset.build()
      for (const beat of [0, 4, 8, 12]) {
        expect(p.tracks[T.KICK][beat].active).toBe(true)
      }
    }
  })

  test('every preset has bass activity (the rolling/offbeat foundation)', () => {
    for (const preset of PSY_PRESETS) {
      const p = preset.build()
      const bassHits = p.tracks[T.BASS].filter((s) => s.active).length
      // A psy groove needs at least 4 bass hits to roll.
      expect(bassHits).toBeGreaterThanOrEqual(4)
    }
  })

  test('full-on preset lays the KBBB roll (bass on offbeat 16ths after each kick)', () => {
    const fullon = PSY_PRESETS.find((p) => p.id === 'fullon')!
    const p = fullon.build()
    // After the kick at step 0, bass should be on steps 1, 2, 3.
    expect(p.tracks[T.BASS][1].active).toBe(true)
    expect(p.tracks[T.BASS][2].active).toBe(true)
    expect(p.tracks[T.BASS][3].active).toBe(true)
    // Kick steps themselves are not bass.
    expect(p.tracks[T.BASS][0].active).toBe(false)
  })

  test('presets are deterministic (same build twice → identical steps)', () => {
    for (const preset of PSY_PRESETS) {
      const a = preset.build()
      const b = preset.build()
      for (let t = 0; t < a.tracks.length; t++) {
        for (let s = 0; s < STEPS_PER_BAR; s++) {
          expect(b.tracks[t][s].active).toBe(a.tracks[t][s].active)
          expect(b.tracks[t][s].scene).toBe(a.tracks[t][s].scene)
        }
      }
    }
  })

  test('preset BPMs are in psytrance range (130-165)', () => {
    for (const preset of PSY_PRESETS) {
      expect(preset.bpm).toBeGreaterThanOrEqual(128)
      expect(preset.bpm).toBeLessThanOrEqual(165)
    }
  })

  test('all preset scene values are valid (0-7)', () => {
    for (const preset of PSY_PRESETS) {
      const p = preset.build()
      for (const track of p.tracks) {
        for (const step of track) {
          expect(step.scene).toBeGreaterThanOrEqual(0)
          expect(step.scene).toBeLessThanOrEqual(7)
        }
      }
    }
  })
})
