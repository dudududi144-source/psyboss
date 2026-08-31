/**
 * PSYBOSS → Web MIDI adapter.
 *
 * Bridges the Web MIDI API to PSYBUS, enabling:
 *   - MIDI input (controllers, keyboards, drum pads) → PSYBUS envelopes
 *   - PSYBUS envelopes → MIDI output (24-ppq clock, note messages)
 *
 * This is Scope 3's critical piece: making PSYBOSS a real performance
 * instrument that responds to physical controllers.
 *
 * MIDI Clock: 24 pulses per quarter note (24 ppq). At 144 BPM, that's
 * 144 * 24 / 60 = 57.6 pulses/second = ~17.36ms between pulses.
 *
 * MIDI Mapping:
 *   - Note On/Off (channel 1-16) → PSYBUS 'note'/'note.off' envelopes
 *   - CC (Control Change) → PSYBUS 'param.set' envelopes
 *   - Pitch Bend → PSYBUS 'param.set' (special param 'pitchBend')
 *   - Start/Stop/Continue → PSYBUS 'transport.start'/'transport.stop'
 *   - Clock (0xF8) → transport sync (24 ppq)
 *
 * The adapter is deterministic given the same seed — replay-identical.
 */

import { DeviceAdapter, type DeviceAdapterOptions } from './device-adapter'
import type { BusEnvelope, ParamId } from '@/psybus/types'
import { deviceId, paramId, trackId } from '@/psybus/types'

// Web MIDI API types (browser-native)
interface MIDIMessageEvent {
  data: Uint8Array
}

interface MIDIInput {
  id: string
  name: string
  manufacturer: string
  onmidimessage: ((e: MIDIMessageEvent) => void) | null
}

interface MIDIOutput {
  id: string
  name: string
  manufacturer: string
  send(data: Uint8Array | number[], timestamp?: number): void
}

interface MIDIAccess {
  inputs: Map<string, MIDIInput>
  outputs: Map<string, MIDIOutput>
  onstatechange: (() => void) | null
}

// Web MIDI types are in lib.dom.d.ts — no need to redeclare Navigator.
// We use a type-safe accessor for browsers that support it.
function getRequestMIDIAccess(): ((options?: { sysex?: boolean }) => Promise<MIDIAccess>) | null {
  if (typeof navigator === 'undefined') return null
  const nav = navigator as Navigator & {
    requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MIDIAccess>
  }
  return typeof nav.requestMIDIAccess === 'function'
    ? nav.requestMIDIAccess.bind(nav)
    : null
}

/** MIDI status bytes. */
const MIDI_STATUS = {
  NOTE_OFF: 0x80,
  NOTE_ON: 0x90,
  POLY_PRESSURE: 0xa0,
  CC: 0xb0,
  PROGRAM_CHANGE: 0xc0,
  CHANNEL_PRESSURE: 0xd0,
  PITCH_BEND: 0xe0,
  SYSTEM: 0xf0,
} as const

/** MIDI system real-time messages. */
const MIDI_REALTIME = {
  CLOCK: 0xf8,
  START: 0xfa,
  CONTINUE: 0xfb,
  STOP: 0xfc,
  ACTIVE_SENSING: 0xfe,
  RESET: 0xff,
} as const

/** CC mappings for PSYBOSS params. */
const CC_TO_PARAM: Record<number, ParamId> = {
  1: paramId('modulation'),   // CC 1 = Modulation wheel
  7: paramId('volume'),       // CC 7 = Channel volume
  10: paramId('pan'),         // CC 10 = Pan
  11: paramId('expression'),  // CC 11 = Expression
  74: paramId('filterCutoff'), // CC 74 = Filter cutoff (common)
  71: paramId('filterResonance'), // CC 71 = Filter resonance (common)
  73: paramId('attack'),      // CC 73 = Attack (common)
  72: paramId('release'),     // CC 72 = Release (common)
}

export interface MidiAdapterOptions {
  seed: number
  inputName?: string  // Filter by input name (substring match)
  outputName?: string // Filter by output name (substring match)
  enableClock?: boolean // Send/receive MIDI clock
}

export class MidiAdapter extends DeviceAdapter {
  private midiAccess: MIDIAccess | null = null
  private activeInputs: MIDIInput[] = []
  private activeOutputs: MIDIOutput[] = []
  private ready = false
  private clockCounter = 0
  private lastClockTime = 0
  private estimatedBpm = 144
  private clockEnabled: boolean
  private inputFilter?: string
  private outputFilter?: string

  constructor(options: MidiAdapterOptions) {
    super({
      deviceId: deviceId('midi-bridge'),
      seed: options.seed,
      capabilities: {
        audio: false,
        midiIn: true,
        midiOut: true,
        maxVoices: 0,
        params: Object.values(CC_TO_PARAM),
      },
    })
    this.clockEnabled = options.enableClock ?? true
    this.inputFilter = options.inputName
    this.outputFilter = options.outputName
  }

  /** Initialize Web MIDI access and register with PSYBUS. */
  async init(): Promise<void> {
    if (this.ready) return

    const requestAccess = getRequestMIDIAccess()
    if (!requestAccess) {
      throw new Error('Web MIDI API not supported in this browser. Use Chrome/Edge/Opera.')
    }

    try {
      this.midiAccess = await requestAccess({ sysex: false })
    } catch (err) {
      throw new Error(`Web MIDI access denied: ${err}`)
    }

    // Set up device change handler.
    this.midiAccess.onstatechange = () => {
      this.refreshDevices()
    }

    // Initial device scan.
    this.refreshDevices()

    this.ready = true

    // Register with PSYBUS.
    this.register()
  }

  /** Dispose the adapter and clean up. */
  dispose(): void {
    // Disconnect all MIDI input handlers.
    for (const input of this.activeInputs) {
      input.onmidimessage = null
    }
    this.activeInputs = []
    this.activeOutputs = []
    this.midiAccess = null
    this.unregister()
    this.ready = false
  }

  /** Get list of available MIDI input names. */
  getAvailableInputs(): Array<{ id: string; name: string; manufacturer: string }> {
    if (!this.midiAccess) return []
    return Array.from(this.midiAccess.inputs.values()).map((input) => ({
      id: input.id,
      name: input.name,
      manufacturer: input.manufacturer,
    }))
  }

  /** Get list of available MIDI output names. */
  getAvailableOutputs(): Array<{ id: string; name: string; manufacturer: string }> {
    if (!this.midiAccess) return []
    return Array.from(this.midiAccess.outputs.values()).map((output) => ({
      id: output.id,
      name: output.name,
      manufacturer: output.manufacturer,
    }))
  }

  // ── Abstract method implementations ────────────────────────────────────

  protected onTransport(
    bpm: number,
    beat: number,
    bar: number,
    playing: boolean,
    audioTime: number,
  ): void {
    // Update estimated BPM for clock output.
    this.estimatedBpm = bpm

    // Send MIDI clock if enabled and playing.
    if (this.clockEnabled && playing) {
      this.sendClock()
    }
  }

  protected onTransportStart(): void {
    // Send MIDI Start message.
    this.sendRealtime(MIDI_REALTIME.START)
  }

  protected onTransportStop(): void {
    // Send MIDI Stop message.
    this.sendRealtime(MIDI_REALTIME.STOP)
  }

  protected onTransportSeek(beat: number): void {
    // MIDI doesn't support seeking — we just reset the clock counter.
    this.clockCounter = 0
  }

  protected onParamSet(param: ParamId, value: number): void {
    // Send MIDI CC for the corresponding param.
    const cc = this.paramToCc(param)
    if (cc !== null) {
      this.sendCc(0, cc, Math.round(value * 127))
    }
  }

  protected onChoke(group: string): void {
    // Send All Notes Off (CC 123) on all channels.
    for (let channel = 0; channel < 16; channel++) {
      this.sendCc(channel, 123, 0) // All Notes Off
    }
  }

  protected setupSubscriptions(): void {
    // The MIDI adapter is primarily an INPUT source — it publishes to the bus
    // rather than subscribing. But we subscribe to transport for clock output.
    this.subscribe(
      (e) => e.payload.kind === 'transport',
      (e) => {
        if (e.payload.kind === 'transport' && e.payload.playing) {
          // Clock output is handled in onTransport.
        }
      },
    )
  }

  // ── Private: MIDI input handling ───────────────────────────────────────

  private refreshDevices(): void {
    if (!this.midiAccess) return

    // Disconnect old inputs.
    for (const input of this.activeInputs) {
      input.onmidimessage = null
    }
    this.activeInputs = []
    this.activeOutputs = []

    // Connect matching inputs.
    for (const input of this.midiAccess.inputs.values()) {
      if (this.inputFilter && !input.name.toLowerCase().includes(this.inputFilter.toLowerCase())) {
        continue
      }
      input.onmidimessage = (e) => this.handleMidiMessage(e)
      this.activeInputs.push(input)
    }

    // Connect matching outputs.
    for (const output of this.midiAccess.outputs.values()) {
      if (this.outputFilter && !output.name.toLowerCase().includes(this.outputFilter.toLowerCase())) {
        continue
      }
      this.activeOutputs.push(output)
    }
  }

  private handleMidiMessage(event: MIDIMessageEvent): void {
    const data = event.data
    if (data.length < 1) return

    const status = data[0]
    const statusType = status & 0xf0
    const channel = status & 0x0f

    try {
      switch (statusType) {
        case MIDI_STATUS.NOTE_ON: {
          const note = data[1]
          const velocity = data[2]
          if (velocity === 0) {
            // Note On with velocity 0 = Note Off.
            this.publishNoteOff(note, channel)
          } else {
            this.publishNoteOn(note, velocity, channel)
          }
          break
        }
        case MIDI_STATUS.NOTE_OFF: {
          const note = data[1]
          this.publishNoteOff(note, channel)
          break
        }
        case MIDI_STATUS.CC: {
          const cc = data[1]
          const value = data[2]
          this.handleCc(channel, cc, value)
          break
        }
        case MIDI_STATUS.PITCH_BEND: {
          const lsb = data[1]
          const msb = data[2]
          const bend = ((msb << 7) | lsb) - 8192 // -8192 to +8191
          this.publishPitchBend(bend, channel)
          break
        }
        case MIDI_STATUS.SYSTEM: {
          this.handleSystemMessage(status)
          break
        }
      }
    } catch (err) {
      this.reportError('midi-handler', String(err))
    }
  }

  private handleCc(channel: number, cc: number, value: number): void {
    // Special CCs.
    if (cc === 123) {
      // All Notes Off.
      this.publishChoke('all')
      return
    }

    // Map CC to PSYBUS param.
    const param = CC_TO_PARAM[cc]
    if (param) {
      const normalizedValue = value / 127
      this.publish({
        rev: this.nextRev(),
        seed: this.seed,
        src: this.id,
        dst: 'broadcast',
        ts: Date.now(),
        payload: {
          kind: 'param.set',
          track: trackId(`midi-ch-${channel}`),
          param,
          value: normalizedValue,
        },
      })
    }
  }

  private handleSystemMessage(status: number): void {
    switch (status) {
      case MIDI_REALTIME.CLOCK: {
        if (this.clockEnabled) {
          this.handleClock()
        }
        break
      }
      case MIDI_REALTIME.START: {
        this.publish({
          rev: this.nextRev(),
          seed: this.seed,
          src: this.id,
          dst: 'broadcast',
          ts: Date.now(),
          payload: { kind: 'transport.start' },
        })
        break
      }
      case MIDI_REALTIME.CONTINUE: {
        this.publish({
          rev: this.nextRev(),
          seed: this.seed,
          src: this.id,
          dst: 'broadcast',
          ts: Date.now(),
          payload: { kind: 'transport.start' },
        })
        break
      }
      case MIDI_REALTIME.STOP: {
        this.publish({
          rev: this.nextRev(),
          seed: this.seed,
          src: this.id,
          dst: 'broadcast',
          ts: Date.now(),
          payload: { kind: 'transport.stop' },
        })
        break
      }
    }
  }

  private handleClock(): void {
    // MIDI clock: 24 pulses per quarter note.
    this.clockCounter++

    const now = performance.now()
    if (this.lastClockTime > 0) {
      const deltaMs = now - this.lastClockTime
      // 24 ppq → one beat = 24 clocks.
      const beatMs = deltaMs * 24
      const bpm = 60000 / beatMs
      // Smooth the BPM estimate.
      this.estimatedBpm = this.estimatedBpm * 0.9 + bpm * 0.1
    }
    this.lastClockTime = now

    // Every 24 clocks = one beat.
    if (this.clockCounter % 24 === 0) {
      // Publish transport update.
      this.publish({
        rev: this.nextRev(),
        seed: this.seed,
        src: this.id,
        dst: 'broadcast',
        ts: Date.now(),
        payload: {
          kind: 'transport',
          bpm: Math.round(this.estimatedBpm),
          beat: Math.floor(this.clockCounter / 24),
          bar: Math.floor(this.clockCounter / 96), // 4 beats per bar
          phase: 0,
          playing: true,
          audioTime: 0,
        },
      })
    }
  }

  // ── Private: PSYBUS publishing ─────────────────────────────────────────

  private publishNoteOn(note: number, velocity: number, channel: number): void {
    this.publish({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: 'broadcast',
      ts: Date.now(),
      payload: {
        kind: 'note',
        track: trackId(`midi-ch-${channel}`),
        note,
        vel: velocity / 127,
        durBeats: 0, // Unknown duration — note-off will follow.
        channel,
      },
    })
  }

  private publishNoteOff(note: number, channel: number): void {
    this.publish({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: 'broadcast',
      ts: Date.now(),
      payload: {
        kind: 'note.off',
        track: trackId(`midi-ch-${channel}`),
        note,
      },
    })
  }

  private publishPitchBend(bend: number, channel: number): void {
    this.publish({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: 'broadcast',
      ts: Date.now(),
      payload: {
        kind: 'param.set',
        track: trackId(`midi-ch-${channel}`),
        param: paramId('pitchBend'),
        value: (bend + 8192) / 16383, // Normalize to 0-1.
      },
    })
  }

  private publishChoke(group: string): void {
    this.publish({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: 'broadcast',
      ts: Date.now(),
      payload: {
        kind: 'choke',
        group: group as any, // ChokeGroupId branded type
      },
    })
  }

  // ── Private: MIDI output ───────────────────────────────────────────────

  private sendClock(): void {
    this.sendRealtime(MIDI_REALTIME.CLOCK)
  }

  private sendRealtime(status: number): void {
    for (const output of this.activeOutputs) {
      try {
        output.send([status])
      } catch {
        // Ignore output errors.
      }
    }
  }

  private sendCc(channel: number, cc: number, value: number): void {
    const status = MIDI_STATUS.CC | (channel & 0x0f)
    for (const output of this.activeOutputs) {
      try {
        output.send([status, cc & 0x7f, value & 0x7f])
      } catch {
        // Ignore output errors.
      }
    }
  }

  private paramToCc(param: ParamId): number | null {
    for (const [cc, p] of Object.entries(CC_TO_PARAM)) {
      if (p === param) return Number(cc)
    }
    return null
  }
}

/** Factory function for creating a MIDI adapter. */
export function createMidiAdapter(options: MidiAdapterOptions): MidiAdapter {
  return new MidiAdapter(options)
}
