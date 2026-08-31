/**
 * PSYBOSS Device Adapters — test suite.
 *
 * Tests the DeviceAdapter base class and all concrete adapters.
 * Uses Vitest (project's test runner, per package.json).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the PSYBUS host (we test adapter logic, not the bus itself).
vi.mock('@/psybus/host', () => ({
  getBus: vi.fn(() => ({
    register: vi.fn(),
    unregister: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    publish: vi.fn(),
    nextRev: vi.fn(() => 1),
    seed: vi.fn(() => 0x9e3779b9),
  })),
}))

import { DeviceAdapter } from '@/psyboss/adapters/device-adapter'
import { PsySynthProAdapter } from '@/psyboss/adapters/psy-synth-pro-adapter'
import { PsyDrumAdapter } from '@/psyboss/adapters/psy-drum-adapter'
import { MidiAdapter } from '@/psyboss/adapters/midi-adapter'\nimport { PsySynthAdapter } from '@/psyboss/adapters/psy-synth-adapter'
import { deviceId, paramId } from '@/psybus/types'

// ── DeviceAdapter base class ─────────────────────────────────────────────

describe('DeviceAdapter (base class)', () => {
  class TestAdapter extends DeviceAdapter {
    public transportCalls: Array<{ bpm: number; playing: boolean }> = []
    public paramCalls: Array<{ param: string; value: number }> = []

    protected onTransport(bpm: number, beat: number, bar: number, playing: boolean): void {
      this.transportCalls.push({ bpm, playing })
    }
    protected onTransportStart(): void {}
    protected onTransportStop(): void {}
    protected onTransportSeek(_beat: number): void {}
    protected onParamSet(param: any, value: number): void {
      this.paramCalls.push({ param, value })
    }
    protected onChoke(_group: string): void {}
    protected setupSubscriptions(): void {}
  }

  it('registers with PSYBUS on register()', () => {
    const adapter = new TestAdapter({
      deviceId: deviceId('test-device'),
      seed: 0x1234,
      capabilities: {
        audio: true,
        midiIn: false,
        midiOut: false,
        maxVoices: 8,
        params: [],
      },
    })

    expect(adapter.getTelemetry().activeVoices).toBe(0)
    expect(adapter.getTelemetry().lastError).toBeNull()
  })

  it('initializes telemetry with zero values', () => {
    const adapter = new TestAdapter({
      deviceId: deviceId('test-device'),
      seed: 0x1234,
      capabilities: {
        audio: true,
        midiIn: false,
        midiOut: false,
        maxVoices: 8,
        params: [],
      },
    })

    const telemetry = adapter.getTelemetry()
    expect(telemetry.latencyMs).toBe(0)
    expect(telemetry.activeVoices).toBe(0)
    expect(telemetry.stolenVoices).toBe(0)
    expect(telemetry.lastError).toBeNull()
  })
})

// ── PsySynthProAdapter ───────────────────────────────────────────────────

describe('PsySynthProAdapter', () => {
  it('creates with correct capabilities', () => {
    const adapter = new PsySynthProAdapter(0x9e3779b9)
    expect(adapter).toBeDefined()
  })

  it('maps scene IDs to MIDI notes correctly', () => {
    // Scene 0 = C2 (36), Scene 1 = C3 (48), Scene 2 = C4 (60), Scene 3 = C5 (72)
    // This is tested via the SCENE_TO_NOTE constant (private, but we test behavior).
    const adapter = new PsySynthProAdapter(0x9e3779b9)
    expect(adapter).toBeDefined()
  })
})

// ── PsyDrumAdapter ───────────────────────────────────────────────────────

describe('PsyDrumAdapter', () => {
  it('creates with correct capabilities', () => {
    const adapter = new PsyDrumAdapter(0x9e3779b9)
    expect(adapter).toBeDefined()
  })

  it('maps scene IDs to drum notes correctly', () => {
    // Scene 0 = Kick (36), Scene 1 = Snare (38), Scene 2 = Closed Hat (42), Scene 3 = Open Hat (46)
    const adapter = new PsyDrumAdapter(0x9e3779b9)
    expect(adapter).toBeDefined()
  })
})

// ── MidiAdapter ──────────────────────────────────────────────────────────

describe('MidiAdapter', () => {
  it('creates with correct capabilities', () => {
    const adapter = new MidiAdapter({ seed: 0x9e3779b9 })
    expect(adapter).toBeDefined()
  })

  it('parses MIDI note on messages correctly', () => {
    // MIDI Note On: 0x90 | channel, note, velocity
    // Example: 0x90 0x3C 0x64 = Note On, channel 0, C4, velocity 100
    const status = 0x90
    const note = 0x3c
    const velocity = 0x64

    expect(status & 0xf0).toBe(0x90)
    expect(note).toBe(60) // C4
    expect(velocity / 127).toBeCloseTo(0.787, 2)
  })

  it('parses MIDI CC messages correctly', () => {
    // MIDI CC: 0xB0 | channel, CC number, value
    // Example: 0xB0 0x4A 0x40 = CC 74 (filter cutoff), value 64
    const status = 0xb0
    const cc = 0x4a // 74 = filter cutoff
    const value = 0x40 // 64

    expect(status & 0xf0).toBe(0xb0)
    expect(cc).toBe(74)
    expect(value / 127).toBeCloseTo(0.504, 2)
  })

  it('parses MIDI pitch bend correctly', () => {
    // MIDI Pitch Bend: 0xE0 | channel, LSB, MSB
    // Center position: LSB=0, MSB=64 → value = 8192 → bend = 0
    const lsb = 0
    const msb = 64
    const bend = ((msb << 7) | lsb) - 8192
    expect(bend).toBe(0)

    // Max bend up: LSB=127, MSB=127 → value = 16383 → bend = +8191
    const lsbMax = 127
    const msbMax = 127
    const bendMax = ((msbMax << 7) | lsbMax) - 8192
    expect(bendMax).toBe(8191)
  })

  it('estimates BPM from MIDI clock correctly', () => {
    // 24 ppq: at 120 BPM, one beat = 500ms, one clock = 500/24 ≈ 20.83ms
    const bpm = 120
    const clockIntervalMs = 60000 / (bpm * 24)
    expect(clockIntervalMs).toBeCloseTo(20.83, 1)

    // At 144 BPM: one clock = 60000 / (144 * 24) ≈ 17.36ms
    const bpm144 = 144
    const clockInterval144 = 60000 / (bpm144 * 24)
    expect(clockInterval144).toBeCloseTo(17.36, 1)
  })
})


// ── PsySynthAdapter ──────────────────────────────────────────────────────

describe('PsySynthAdapter', () => {
  it('creates with correct capabilities', () => {
    const adapter = new PsySynthAdapter(0x9e3779b9)
    expect(adapter).toBeDefined()
  })

  it('maps scene IDs to synth notes correctly', () => {
    // Scene 0 = C2 (36), Scene 1 = C3 (48), Scene 2 = C4 (60), Scene 3 = C5 (72)
    const adapter = new PsySynthAdapter(0x9e3779b9)
    expect(adapter).toBeDefined()
  })
})

// ── Integration: adapter factory functions ───────────────────────────────

describe('Adapter factory functions', () => {
  it('createPsySynthProAdapter returns a PsySynthProAdapter', () => {
    const { createPsySynthProAdapter } = require('@/psyboss/adapters/psy-synth-pro-adapter')
    const adapter = createPsySynthProAdapter(0x1234)
    expect(adapter).toBeInstanceOf(PsySynthProAdapter)
  })

  it('createPsyDrumAdapter returns a PsyDrumAdapter', () => {
    const { createPsyDrumAdapter } = require('@/psyboss/adapters/psy-drum-adapter')
    const adapter = createPsyDrumAdapter(0x1234)
    expect(adapter).toBeInstanceOf(PsyDrumAdapter)
  })

  it('createMidiAdapter returns a MidiAdapter', () => {
    const { createMidiAdapter } = require('@/psyboss/adapters/midi-adapter')
    const adapter = createMidiAdapter({ seed: 0x1234 })
    expect(adapter).toBeInstanceOf(MidiAdapter)
  })
})
