/**
 * PSYBOSS Song Structure — turns loop playback into a full psytrance TRACK.
 *
 * Real psytrance is a JOURNEY: a minimal intro builds, drops at full energy,
 * breaks down, then drops again. This module defines that arc as data, and the
 * audio engine applies it live (muting/unmuting tracks per section) so the
 * performance evolves automatically instead of looping statically.
 *
 * Track indices (see dsp.ts TRACK_NAMES):
 *   0 KICK · 1 BASS · 2 LEAD · 3 ARP · 4 HAT · 5 CLAP · 6 PAD · 7 FX · 8 STAB · 9 PLUCK
 */

export interface SongSection {
  name: string
  bars: number
  /** Track indices audible in this section. */
  activeTracks: number[]
}

// The classic psytrance arc, 8-bar sections. Total loop = 56 bars.
export const SONG_STRUCTURE: SongSection[] = [
  { name: 'INTRO',     bars: 8, activeTracks: [0, 1] },
  { name: 'BUILD',     bars: 8, activeTracks: [0, 1, 2, 3, 4, 7] },
  { name: 'DROP',      bars: 8, activeTracks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  { name: 'BREAKDOWN', bars: 8, activeTracks: [1, 6, 7, 9] },
  { name: 'BUILD 2',   bars: 8, activeTracks: [0, 1, 2, 3, 4, 7] },
  { name: 'DROP 2',    bars: 8, activeTracks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
  { name: 'OUTRO',     bars: 8, activeTracks: [0, 1] },
]

/** Total bars in one full pass of the structure. */
export const SONG_TOTAL_BARS = SONG_STRUCTURE.reduce((a, s) => a + s.bars, 0)

/**
 * Given an absolute bar number, return the section it falls in plus the set of
 * active track indices. The structure loops every SONG_TOTAL_BARS bars.
 */
export function sectionAtBar(bar: number): {
  section: SongSection
  activeTracks: Set<number>
  sectionIndex: number
  barInSection: number
} {
  const loopBar = ((bar % SONG_TOTAL_BARS) + SONG_TOTAL_BARS) % SONG_TOTAL_BARS
  let acc = 0
  for (let i = 0; i < SONG_STRUCTURE.length; i++) {
    const sec = SONG_STRUCTURE[i]
    if (loopBar < acc + sec.bars) {
      return {
        section: sec,
        activeTracks: new Set(sec.activeTracks),
        sectionIndex: i,
        barInSection: loopBar - acc,
      }
    }
    acc += sec.bars
  }
  const first = SONG_STRUCTURE[0]
  return { section: first, activeTracks: new Set(first.activeTracks), sectionIndex: 0, barInSection: 0 }
}
