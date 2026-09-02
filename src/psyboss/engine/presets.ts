/**
 * PSYBOSS Presets — ready-made psytrance grooves so the device speaks the genre
 * out of the box. A device named PSYBOSS must not start empty: these presets lay
 * down the signature patterns of the main psytrance sub-genres.
 *
 * Track map (8 tracks, see dsp.ts TRACK_NAMES):
 *   0 KICK · 1 BASS · 2 LEAD · 3 ARP · 4 HAT · 5 CLAP · 6 PAD · 7 FX
 *
 * The rolling psy bass (the genre's heartbeat) is the "KBBB" pattern: KICK on the
 * beat, BASS on the offbeat 16ths. The bass sound's 4 scenes map to root / root /
 * fifth / octave, so varying the scene across steps produces a real bassline.
 *
 * All presets are deterministic (fixed seed) → byte-identical on every load.
 */

import type { Pattern, Step } from './sequencer'
import { STEPS_PER_BAR } from './sequencer'

// Track indices (must match dsp.ts TRACK_NAMES order).
export const T = {
  KICK: 0,
  BASS: 1,
  LEAD: 2,
  ARP: 3,
  HAT: 4,
  CLAP: 5,
  PAD: 6,
  FX: 7,
  STAB: 8,
  PLUCK: 9,
} as const

const NUM_TRACKS = 10

export interface PsyPreset {
  id: string
  name: string
  desc: string
  bpm: number
  seed: number
  build: () => Pattern
}

/** Empty step (inactive). */
function off(): Step {
  return { active: false, scene: 0, condition: { kind: 'always' }, locks: [] }
}

/** Active step with a given scene (bass scene = note). */
function on(scene = 0): Step {
  return { active: true, scene, condition: { kind: 'always' }, locks: [] }
}

/** Build an empty 8-track, 16-step pattern shell. */
function shell(seed: number, id: string): Pattern {
  const tracks: Step[][] = []
  for (let t = 0; t < NUM_TRACKS; t++) {
    const steps: Step[] = []
    for (let s = 0; s < STEPS_PER_BAR; s++) steps.push(off())
    tracks.push(steps)
  }
  return { id, seed, tracks }
}

/** Set a step active on a track. */
function set(p: Pattern, track: number, step: number, scene = 0): void {
  p.tracks[track][step % STEPS_PER_BAR] = on(scene)
}

// ─── FULL-ON PSY ────────────────────────────────────────────────────────────
// The classic driving full-on groove: four-on-floor kick, KBBB rolling bass,
// offbeat hats, clap on 2 & 4, and a squelchy lead hint. ~142 BPM.
function buildFullOn(): Pattern {
  const p = shell(0xf0010a, 'fullon')
  // Kick: four on the floor.
  for (const s of [0, 4, 8, 12]) set(p, T.KICK, s)
  // Rolling bass (KBBB): bass on every offbeat 16th, bassline A-A-E-A per beat.
  // scene 0=root, 2=fifth, 3=octave → creates movement in the roll.
  const bassLine = [0, 0, 2] // the 3 offbeat 16ths after each kick
  for (let beat = 0; beat < 4; beat++) {
    const base = beat * 4
    set(p, T.BASS, base + 1, bassLine[0])
    set(p, T.BASS, base + 2, bassLine[1])
    set(p, T.BASS, base + 3, bassLine[2])
  }
  // Offbeat hats.
  for (const s of [2, 6, 10, 14]) set(p, T.HAT, s)
  // Clap on 2 & 4.
  set(p, T.CLAP, 4)
  set(p, T.CLAP, 12)
  // Lead: hypnotic minor-scale melody (scenes 0-7 = full natural-minor scale).
  set(p, T.LEAD, 0, 0)   // root
  set(p, T.LEAD, 6, 4)   // fifth
  set(p, T.LEAD, 8, 2)   // minor 3rd
  set(p, T.LEAD, 10, 4)  // fifth
  set(p, T.LEAD, 14, 7)  // octave
  // Arp: ascending minor arpeggio root→3rd→5th→octave.
  set(p, T.ARP, 12, 0)
  set(p, T.ARP, 13, 2)
  set(p, T.ARP, 14, 4)
  set(p, T.ARP, 15, 7)
  // Pluck: syncopated melodic hook over the roll.
  set(p, T.PLUCK, 3, 4)   // fifth
  set(p, T.PLUCK, 7, 2)   // minor 3rd
  set(p, T.PLUCK, 11, 7)  // octave
  return p
}

// ─── PROGRESSIVE PSY ────────────────────────────────────────────────────────
// Laid-back progressive: kick + offbeat bass (the "and"), spacious hats, a
// melodic lead. ~132 BPM.
function buildProgressive(): Pattern {
  const p = shell(0xf0020b, 'progressive')
  for (const s of [0, 4, 8, 12]) set(p, T.KICK, s)
  // Offbeat bass on the "and" of each beat.
  for (const s of [2, 6, 10, 14]) set(p, T.BASS, s, 0)
  // Hats: light, on some offbeats.
  for (const s of [2, 10]) set(p, T.HAT, s)
  // Clap on 2 & 4 (softer presence).
  set(p, T.CLAP, 4)
  set(p, T.CLAP, 12)
  // Melodic lead: a simple motif.
  set(p, T.LEAD, 0, 0)
  set(p, T.LEAD, 3, 1)
  set(p, T.LEAD, 6, 2)
  set(p, T.LEAD, 11, 1)
  // Pad swells at the start of the bar.
  set(p, T.PAD, 0, 0)
  return p
}

// ─── DARK PSY ───────────────────────────────────────────────────────────────
// Darker, denser: driving kick, thicker rolling bass with fifth/octave movement,
// more percussive activity, FX tension. ~148 BPM.
function buildDark(): Pattern {
  const p = shell(0xf0030c, 'dark')
  for (const s of [0, 4, 8, 12]) set(p, T.KICK, s)
  // Dense rolling bass with more note movement (root-fifth-octave-fifth).
  const bassLine = [0, 2, 3]
  for (let beat = 0; beat < 4; beat++) {
    const base = beat * 4
    set(p, T.BASS, base + 1, bassLine[0])
    set(p, T.BASS, base + 2, bassLine[1])
    set(p, T.BASS, base + 3, bassLine[2])
  }
  // Extra sub-bass accent on the "and".
  for (const s of [2, 6, 10, 14]) set(p, T.BASS, s, 0)
  // Hats: busier.
  for (const s of [2, 3, 6, 7, 10, 11, 14, 15]) set(p, T.HAT, s)
  // Clap + snare layer.
  set(p, T.CLAP, 4)
  set(p, T.CLAP, 12)
  // Arp: dark descending run.
  set(p, T.ARP, 8, 3)
  set(p, T.ARP, 9, 2)
  set(p, T.ARP, 10, 1)
  set(p, T.ARP, 11, 0)
  // FX riser at the end of the bar.
  set(p, T.FX, 14, 0)
  // Stab: dark chord accents on the offbeats.
  set(p, T.STAB, 2, 0)
  set(p, T.STAB, 10, 1)
  return p
}

// ─── HI-TECH ────────────────────────────────────────────────────────────────
// Fast, frantic hi-tech: very dense bass rolls, rapid arps, constant motion.
// ~160 BPM.
function buildHiTech(): Pattern {
  const p = shell(0xf0040d, 'hitech')
  for (const s of [0, 4, 8, 12]) set(p, T.KICK, s)
  // Relentless rolling bass, alternating root/octave for drive.
  for (let beat = 0; beat < 4; beat++) {
    const base = beat * 4
    set(p, T.BASS, base + 1, beat % 2 === 0 ? 0 : 3)
    set(p, T.BASS, base + 2, 0)
    set(p, T.BASS, base + 3, beat % 2 === 0 ? 2 : 0)
  }
  // Hats on every offbeat.
  for (const s of [2, 6, 10, 14]) set(p, T.HAT, s)
  // Rapid arp: continuous 16th arp across the bar.
  for (let s = 0; s < STEPS_PER_BAR; s += 2) set(p, T.ARP, s, s % 4)
  // Clap backbeat.
  set(p, T.CLAP, 4)
  set(p, T.CLAP, 12)
  return p
}

export const PSY_PRESETS: PsyPreset[] = [
  {
    id: 'fullon',
    name: 'Full-On Psy',
    desc: 'Driving KBBB rolling bass · 142 BPM',
    bpm: 142,
    seed: 0xf0010a,
    build: buildFullOn,
  },
  {
    id: 'progressive',
    name: 'Progressive Psy',
    desc: 'Offbeat bass, spacious, melodic · 132 BPM',
    bpm: 132,
    seed: 0xf0020b,
    build: buildProgressive,
  },
  {
    id: 'dark',
    name: 'Dark Psy',
    desc: 'Dense rolls, darker movement · 148 BPM',
    bpm: 148,
    seed: 0xf0030c,
    build: buildDark,
  },
  {
    id: 'hitech',
    name: 'Hi-Tech',
    desc: 'Fast, frantic, relentless · 160 BPM',
    bpm: 160,
    seed: 0xf0040d,
    build: buildHiTech,
  },
]
