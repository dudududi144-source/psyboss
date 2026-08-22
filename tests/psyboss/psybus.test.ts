/**
 * PSYBUS protocol + provenance gate tests.
 *
 * Verifies: provenance enforcement, dst routing, try/catch isolation, fingerprint format.
 * Answer to ROAST-1 §4 (PSYBUS was dead code; publish had no try/catch; dst was decorative).
 *
 * Run: bun test tests/psyboss/psybus.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { makeBus, ProvenanceError } from '@/psybus/host'
import {
  deviceId, trackId, sceneId, type BusEnvelope, type SampleRef,
} from '@/psybus/types'

const SEED = 12345
const UI = deviceId('ui')
const ENG = deviceId('eng')
const FX = deviceId('fx')

function makeTrig(dst: typeof UI | 'broadcast', sampleRef: SampleRef): BusEnvelope {
  return {
    rev: 1, seed: SEED, src: UI, dst, ts: 0,
    payload: {
      kind: 'trig', track: trackId('track-0'), scene: sceneId('scene-0'), sampleRef,
    },
  }
}

function goodDspRef(id = '0:0', seed = SEED): SampleRef {
  return {
    id: `dsp:${id}`,
    provenance: { license: 'psboss-dsp', source: 'PSYBOSS DSP v1', verifiedAt: seed, fingerprint: `dsp:${id}:${seed}` },
  }
}

function goodShaRef(id = 'sample-1'): SampleRef {
  return {
    id,
    provenance: {
      license: 'CC0', source: 'https://freesound.org/x', verifiedAt: 1700000000000,
      fingerprint: 'a'.repeat(64),
    },
  }
}

describe('provenance gate', () => {
  test('accepts a valid psboss-dsp fingerprint (dsp:<id>:<seed>)', () => {
    const bus = makeBus(SEED)
    expect(() => bus.publish(makeTrig('broadcast', goodDspRef()))).not.toThrow()
  })

  test('accepts a valid sha-256 fingerprint for CC0', () => {
    const bus = makeBus(SEED)
    expect(() => bus.publish(makeTrig('broadcast', goodShaRef()))).not.toThrow()
  })

  test('rejects missing provenance', () => {
    const bus = makeBus(SEED)
    const ref: SampleRef = { id: 'x', provenance: undefined as unknown as SampleRef['provenance'] }
    expect(() => bus.publish(makeTrig('broadcast', ref))).toThrow(ProvenanceError)
  })

  test('rejects incomplete provenance (no license)', () => {
    const bus = makeBus(SEED)
    const ref = { id: 'x', provenance: { source: 's', verifiedAt: 1, fingerprint: 'f' } }
    expect(() => bus.publish(makeTrig('broadcast', ref as SampleRef))).toThrow(ProvenanceError)
  })

  test('rejects psboss-dsp with malformed fingerprint (no seed part)', () => {
    const bus = makeBus(SEED)
    const ref: SampleRef = {
      id: 'x',
      provenance: { license: 'psboss-dsp', source: 'PSYBOSS', verifiedAt: 1, fingerprint: 'dsp:0:0:extra' },
    }
    expect(() => bus.publish(makeTrig('broadcast', ref))).toThrow(ProvenanceError)
  })

  test('rejects psboss-dsp with non-numeric seed', () => {
    const bus = makeBus(SEED)
    const ref: SampleRef = {
      id: 'x',
      provenance: { license: 'psboss-dsp', source: 'PSYBOSS', verifiedAt: 1, fingerprint: 'dsp:0:abc' },
    }
    expect(() => bus.publish(makeTrig('broadcast', ref))).toThrow(ProvenanceError)
  })

  test('rejects non-psboss-dsp license with non-sha256 fingerprint', () => {
    const bus = makeBus(SEED)
    const ref: SampleRef = {
      id: 'x',
      provenance: { license: 'CC0', source: 's', verifiedAt: 1, fingerprint: 'short' },
    }
    expect(() => bus.publish(makeTrig('broadcast', ref))).toThrow(ProvenanceError)
  })

  test('rejects sha-256 with uppercase hex (must be lowercase)', () => {
    const bus = makeBus(SEED)
    const ref: SampleRef = {
      id: 'x',
      provenance: { license: 'CC-BY', source: 's', verifiedAt: 1, fingerprint: 'A'.repeat(64) },
    }
    expect(() => bus.publish(makeTrig('broadcast', ref))).toThrow(ProvenanceError)
  })
})

describe('dst routing (ROAST-1 §4 fix)', () => {
  test('unicast delivers ONLY to the target device', () => {
    const bus = makeBus(SEED)
    let engGot = 0, fxGot = 0
    bus.register(ENG, { audio: true, midiIn: false, midiOut: false, maxVoices: 1, params: [] })
    bus.register(FX, { audio: true, midiIn: false, midiOut: false, maxVoices: 1, params: [] })
    bus.subscribe(ENG, () => true, () => { engGot++ })
    bus.subscribe(FX, () => true, () => { fxGot++ })
    bus.publish(makeTrig(ENG, goodDspRef()))
    expect(engGot).toBe(1)
    expect(fxGot).toBe(0)
  })

  test('broadcast delivers to ALL subscribers', () => {
    const bus = makeBus(SEED)
    let engGot = 0, fxGot = 0
    bus.register(ENG, { audio: true, midiIn: false, midiOut: false, maxVoices: 1, params: [] })
    bus.register(FX, { audio: true, midiIn: false, midiOut: false, maxVoices: 1, params: [] })
    bus.subscribe(ENG, () => true, () => { engGot++ })
    bus.subscribe(FX, () => true, () => { fxGot++ })
    bus.publish(makeTrig('broadcast', goodDspRef()))
    expect(engGot).toBe(1)
    expect(fxGot).toBe(1)
  })
})

describe('subscriber isolation (ROAST-1 §4 fix: try/catch)', () => {
  test('a throwing subscriber does NOT prevent delivery to others', () => {
    const bus = makeBus(SEED)
    let goodGot = 0
    bus.register(ENG, { audio: true, midiIn: false, midiOut: false, maxVoices: 1, params: [] })
    bus.register(FX, { audio: true, midiIn: false, midiOut: false, maxVoices: 1, params: [] })
    // First subscriber throws
    bus.subscribe(ENG, () => true, () => { throw new Error('boom') })
    // Second subscriber must still receive the envelope
    bus.subscribe(FX, () => true, () => { goodGot++ })
    // Suppress console.error for the test
    const orig = console.error
    console.error = () => {}
    try {
      expect(() => bus.publish(makeTrig('broadcast', goodDspRef()))).not.toThrow()
    } finally {
      console.error = orig
    }
    expect(goodGot).toBe(1)
  })
})

describe('filter receives full envelope (ROAST-1 §4 fix)', () => {
  test('filter can match on src/dst/rev/seed, not just payload', () => {
    const bus = makeBus(SEED)
    let got = 0
    bus.register(ENG, { audio: true, midiIn: false, midiOut: false, maxVoices: 1, params: [] })
    bus.subscribe(
      ENG,
      (e) => e.src === UI && e.seed === SEED && e.rev > 0,
      () => { got++ },
    )
    bus.publish(makeTrig(ENG, goodDspRef()))
    expect(got).toBe(1)
  })
})

describe('revision counter', () => {
  test('nextRev is monotonic', () => {
    const bus = makeBus(SEED)
    const a = bus.nextRev()
    const b = bus.nextRev()
    const c = bus.nextRev()
    expect(b).toBe(a + 1)
    expect(c).toBe(b + 1)
  })

  test('seed() returns the constructor seed', () => {
    expect(makeBus(42).seed()).toBe(42)
    expect(makeBus(99).seed()).toBe(99)
  })
})
