/**
 * PSYBOSS seeded PRNG + DSP utilities — the determinism foundation.
 *
 * Every PSYBOSS sound is a pure function of (seed, soundId). Same seed → byte-identical
 * audio across runs. This closes the "replay identity" defect roasted in ROAST-1 §7
 * (Math.random + Date.now broke determinism in Scope 1).
 *
 * mulberry32 is the same PRNG the family's `psy/foundation/foundation.mjs` uses
 * (audited in worklog.md AUDIT-A). Ported verbatim for parity.
 */

/** mulberry32 — fast, deterministic, good statistical quality for audio use. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Derive a per-sound sub-seed from a root seed + soundId, so each sound in the bank
 * gets an independent PRNG stream (no cross-contamination between kick/snare/hat/bass).
 */
export function subSeed(rootSeed: number, soundId: string): number {
  // FNV-1a hash of soundId mixed into rootSeed
  let h = rootSeed ^ 0x811c9dc5
  for (let i = 0; i < soundId.length; i++) {
    h = Math.imul(h ^ soundId.charCodeAt(i), 0x01000193) >>> 0
  }
  return h >>> 0
}

/** A PRNG-returning-noise-in-[-1,1] helper built on a mulberry32 stream. */
export function noiseStream(rng: () => number): () => number {
  return () => rng() * 2 - 1
}

/** DC blocker — one-pole highpass at ~20Hz, prevents DC offset accumulation. */
export class DcBlocker {
  private prevIn = 0
  private prevOut = 0
  // R = 1 - (2*pi*fc/fs); fc=20Hz at 48kHz → R ≈ 0.9974
  private r: number
  constructor(sampleRate: number, fc = 20) {
    this.r = 1 - (TAU * fc) / sampleRate
  }
  process(x: number): number {
    const y = x - this.prevIn + this.r * this.prevOut
    this.prevIn = x
    this.prevOut = y
    return y
  }
}

/** Denormal guard — flush subnormal floats to zero (avoids CPU spikes on x86). */
export function flushDenormal(x: number): number {
  return Math.abs(x) < 1e-20 ? 0 : x
}

export const TAU = Math.PI * 2
