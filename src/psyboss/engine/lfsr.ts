/**
 * PSYBOSS LFSR — Linear Feedback Shift Register for deterministic conditional trigs.
 *
 * Why LFSR (not mulberry32): conditional trigs need a BINARY stream (hit/miss),
 * and LFSRs produce maximal-length binary sequences with good statistical
 * properties. A 16-bit Galois LFSR has period 65535 — enough for any reasonable
 * pattern. Seeded → deterministic → replay-identical.
 *
 * Tap positions: 16, 14, 13, 11 (maximal-length for 16-bit, per Xilinx app note).
 */

export class LFSR16 {
  private state: number
  constructor(seed: number) {
    // LFSR state can't be 0 (0 is a fixed point), so OR with 1.
    this.state = (seed >>> 0) | 1
  }

  /** Advance one step, return the output bit (0 or 1). */
  next(): 0 | 1 {
    const lsb = this.state & 1
    this.state = this.state >>> 1
    if (lsb) {
      // Taps at bits 15, 13, 12, 10 (0-indexed) = polynomial 0xB400
      this.state = this.state ^ 0xb400
    }
    return lsb as 0 | 1
  }

  /** Probability gate: returns true with the given probability (0..1). */
  chance(probability: number): boolean {
    if (probability <= 0) return false
    if (probability >= 1) return true
    // Sample 16 bits to get a value in [0, 65535], compare to threshold.
    let val = 0
    for (let i = 0; i < 16; i++) {
      val = (val << 1) | this.next()
    }
    return val / 65535 < probability
  }

  /** Fill-style: returns true if this step is a "fill" (every Nth occurrence). */
  fill(everyN: number, counter: number): boolean {
    if (everyN <= 0) return false
    return counter % everyN === 0
  }
}

/**
 * Conditional trig evaluation. Deterministic given (seed, step, condition).
 *
 * Conditions:
 *   - 'always' (probability 1.0)
 *   - probability 0..1 (LFSR chance gate)
 *   - 'fill' (true on every Nth bar, set via fillEveryBars)
 *   - 'not-fill' (true when fill is false)
 */
export type TrigCondition =
  | { kind: 'always' }
  | { kind: 'probability'; p: number }
  | { kind: 'fill'; everyBars: number }
  | { kind: 'not-fill'; everyBars: number }

export function evaluateCondition(
  lfsr: LFSR16,
  condition: TrigCondition,
  barNumber: number,
): boolean {
  switch (condition.kind) {
    case 'always':
      return true
    case 'probability':
      return lfsr.chance(condition.p)
    case 'fill':
      return lfsr.fill(condition.everyBars, barNumber)
    case 'not-fill':
      return !lfsr.fill(condition.everyBars, barNumber)
  }
}
