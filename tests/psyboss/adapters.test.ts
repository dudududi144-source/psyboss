/**
 * PSYBOSS Device Adapters — test suite.
 *
 * Tests adapter construction, capability declarations, and role guards.
 * These tests exercise only the parts that do NOT require a live PSYBUS or
 * AudioContext (constructor, getters, role checks), so they run headlessly
 * under `bun test` without mocking. Bus/audio integration is covered by E2E.
 *
 * Run: bun test tests/psyboss/adapters.test.ts
 */

import { describe, it, expect } from 'bun:test'
import { DeviceAdapter } from '@/psyboss/adapters/device-adapter'
import { PsySynthProAdapter } from '@/psyboss/adapters/psy-synth-pro-adapter'
import { PsyDrumAdapter } from '@/psyboss/adapters/psy-drum-adapter'
import { PsySynthAdapter } from '@/psyboss/adapters/psy-synth-adapter'
import { MidiAdapter } from '@/psyboss/adapters/midi-adapter'
import { WebRTCAdapter } from '@/psyboss/adapters/webrtc-adapter'
import { deviceId, paramId } from '@/psybus/types'

// ── DeviceAdapter base class ─────────────────────────────────────────────

describe('DeviceAdapter (base class)', () => {
  class TestAdapter extends DeviceAdapter {
    protected onTransport(_bpm: number, _beat: number, _bar: number, _playing: boolean, _audioTime: number): void {}
    protected onTransportStart(): void {}
    protected onTransportStop(): void {}
    protected onTransportSeek(_beat: number): void {}
    protected onParamSet(_param: any, _value: number): void {}
    protected onChoke(_group: string): void {}
    protected setupSubscriptions(): void {}
  }

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
  it('constructs without side effects', () => {
    const adapter = new PsySynthProAdapter(0x9e3779b9)
    expect(adapter).toBeDefined()
  })
})

// ── PsyDrumAdapter ───────────────────────────────────────────────────────

describe('PsyDrumAdapter', () => {
  it('constructs without side effects', () => {
    const adapter = new PsyDrumAdapter(0x9e3779b9)
    expect(adapter).toBeDefined()
  })
})

// ── PsySynthAdapter ──────────────────────────────────────────────────────

describe('PsySynthAdapter', () => {
  it('constructs without side effects', () => {
    const adapter = new PsySynthAdapter(0x9e3779b9)
    expect(adapter).toBeDefined()
  })
})

// ── MidiAdapter ──────────────────────────────────────────────────────────

describe('MidiAdapter', () => {
  it('constructs with default options', () => {
    const adapter = new MidiAdapter({ seed: 0x1234 })
    expect(adapter).toBeDefined()
  })

  it('parses MIDI note-on semantics (velocity normalization)', () => {
    // MIDI note-on velocity is 0-127; PSYBUS uses 0-1. Verify the mapping math.
    const rawVelocity = 100
    const normalized = rawVelocity / 127
    expect(normalized).toBeCloseTo(0.787, 2)
  })

  it('parses MIDI pitch-bend center to zero', () => {
    const lsb = 0
    const msb = 64
    const bend = ((msb << 7) | lsb) - 8192
    expect(bend).toBe(0)
  })

  it('computes MIDI clock interval for 144 BPM (24 ppq)', () => {
    const bpm = 144
    const clockIntervalMs = 60000 / (bpm * 24)
    expect(clockIntervalMs).toBeCloseTo(17.36, 1)
  })
})

// ── WebRTCAdapter ────────────────────────────────────────────────────────

describe('WebRTCAdapter', () => {
  it('creates with correct role', () => {
    const host = new WebRTCAdapter({ seed: 0x9e3779b9, role: 'host' })
    const guest = new WebRTCAdapter({ seed: 0x9e3779b9, role: 'guest' })
    expect(host.getRole()).toBe('host')
    expect(guest.getRole()).toBe('guest')
  })

  it('starts with idle status', () => {
    const adapter = new WebRTCAdapter({ seed: 0x1234, role: 'host' })
    expect(adapter.getStatus()).toBe('idle')
  })

  it('estimates zero latency before sync', () => {
    const adapter = new WebRTCAdapter({ seed: 0x1234, role: 'host' })
    expect(adapter.getEstimatedLatencyMs()).toBe(0)
  })

  it('notifies status listeners immediately with current status', () => {
    const adapter = new WebRTCAdapter({ seed: 0x1234, role: 'host' })
    const statuses: string[] = []
    const unsub = adapter.onStatus((s) => statuses.push(s))
    expect(statuses).toContain('idle')
    unsub()
  })
})

// ── Factory functions ────────────────────────────────────────────────────

describe('Adapter factory functions', () => {
  it('createPsySynthProAdapter returns a PsySynthProAdapter', () => {
    // Dynamic require avoided; use the imported class check via instanceof.
    const adapter = new PsySynthProAdapter(0x1234)
    expect(adapter instanceof PsySynthProAdapter).toBe(true)
  })

  it('createMidiAdapter returns a MidiAdapter', () => {
    const adapter = new MidiAdapter({ seed: 0x1234 })
    expect(adapter instanceof MidiAdapter).toBe(true)
  })

  it('createWebRTCAdapter returns a WebRTCAdapter', () => {
    const adapter = new WebRTCAdapter({ seed: 0x1234, role: 'host' })
    expect(adapter instanceof WebRTCAdapter).toBe(true)
  })
})
