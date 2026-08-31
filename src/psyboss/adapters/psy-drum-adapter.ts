/**
 * PSYBOSS → psydrum adapter.
 *
 * Wraps psydrum (the PsyDevice-conformant drum machine) as a PSYBUS device.
 * psydrum is a full-featured drum device with:
 *   - Voice pool with per-drum budget caps
 *   - Choke groups (hi-hat open/close, etc.)
 *   - Deterministic variance (seeded humanization)
 *   - Multiple drum roles (kick, snare, hat, crash, ride, tom, clap)
 *   - Sample-based + synthesized drum sounds
 *   - MIDI note routing
 *
 * The adapter maps PSYBUS envelopes to psydrum's PsyDevice contract:
 *   - transport → onTransport (snapshot)
 *   - trig → onEvent (NoteEvent with scene-mapped note)
 *   - note/note.off → onEvent (NoteEvent)
 *   - param.set → config updates (via setParam if available)
 *   - choke → choke role trigger
 *   - sidechain.duck → (future: volume modulation)
 *
 * Telemetry published back to the bus:
 *   - voice.count (from DrumCounters)
 *   - latency (from reportLatencyMs)
 *   - error (on any handler exception)
 */

import { DeviceAdapter, type DeviceAdapterOptions } from './device-adapter'
import type { ParamId, TrackId, SceneId } from '@/psybus/types'
import { deviceId, paramId } from '@/psybus/types'

// psydrum types (from psy-foundation-shim/protocol)
interface NoteEvent {
  type: 'note-on' | 'note-off'
  note: number
  velocity: number
  channel: number
  when?: number
}

interface MusicalTransport {
  bpm: number
  beat: number
  bar: number
  phase: number
  playing: boolean
}

interface MusicalContext {
  key: string
  scale: string
  energy: number
  section: string
}

interface DrumRole {
  // kick, snare, hatClosed, hatOpen, crash, ride, tom, clap
}

interface PsyDevice {
  id: string
  capabilities(): {
    audio: boolean
    midi: boolean
    inputs: number
    outputs: number
    voices: number
    latencyMs: number
    roles: string[]
  }
  reportLatencyMs(): number
  onEvent(event: NoteEvent): void
  onTransport(transport: MusicalTransport): void
  onContext(context: MusicalContext): void
  onStart(): void
  onStop(): void
}

interface DrumDeviceOptions {
  id?: string
  ctx: BaseAudioContext
  outputNode: AudioNode
  config?: Record<string, unknown>
  kitPatches?: Record<string, unknown>
  optsSeed?: number
  noteMap?: Record<number, string>
  useBank?: boolean
}

interface DrumDeviceConstructor {
  new (opts: DrumDeviceOptions): PsyDevice
}

// psydrum is expected to be available as a module import or global.
// In production, this would be: import { DrumDevice } from '@psydududi144/psydrum'
declare global {
  interface Window {
    PsyDrum?: {
      DrumDevice: DrumDeviceConstructor
    }
  }
}

/** Map PSYBUS scene IDs to MIDI notes for drum triggers. */
const SCENE_TO_DRUM_NOTE: Record<string, number> = {
  'scene-0': 36, // Kick (C1)
  'scene-1': 38, // Snare (D1)
  'scene-2': 42, // Closed Hat (F#1)
  'scene-3': 46, // Open Hat (A#1)
}

/** psydrum parameters that can be controlled via PSYBUS. */
const PSYDRUM_PARAMS: ParamId[] = [
  paramId('voices'),
  paramId('masterGain'),
  paramId('delaySend'),
  paramId('reverbSend'),
]

export class PsyDrumAdapter extends DeviceAdapter {
  private device: PsyDevice | null = null
  private ready = false
  private currentBpm = 144
  private ctx: BaseAudioContext | null = null
  private outputNode: AudioNode | null = null

  constructor(seed: number) {
    super({
      deviceId: deviceId('psydrum'),
      seed,
      capabilities: {
        audio: true,
        midiIn: true,
        midiOut: false,
        maxVoices: 16,
        params: PSYDRUM_PARAMS,
      },
    })
  }

  /** Initialize the psydrum device and register with PSYBUS. */
  async init(ctx: BaseAudioContext, outputNode: AudioNode): Promise<void> {
    if (this.ready) return

    this.ctx = ctx
    this.outputNode = outputNode

    // Wait for psydrum to be available.
    if (typeof window === 'undefined' || !window.PsyDrum) {
      throw new Error('psydrum not loaded. Include psydrum bundle first.')
    }

    this.device = new window.PsyDrum.DrumDevice({
      id: 'psydrum-psboss',
      ctx,
      outputNode,
      optsSeed: this.seed,
    })

    this.ready = true

    // Report latency after init.
    this.reportLatency(this.device.reportLatencyMs())

    // Register with PSYBUS.
    this.register()
  }

  /** Dispose the adapter and clean up. */
  dispose(): void {
    if (this.device) {
      this.device.onStop()
      this.device = null
    }
    this.unregister()
    this.ready = false
  }

  // ── Abstract method implementations ────────────────────────────────────

  protected onTransport(
    bpm: number,
    beat: number,
    bar: number,
    playing: boolean,
    audioTime: number,
  ): void {
    if (!this.ready || !this.device) return
    this.currentBpm = bpm
    this.device.onTransport({
      bpm,
      beat,
      bar,
      phase: (beat % 4) / 4,
      playing,
    })
  }

  protected onTransportStart(): void {
    if (!this.ready || !this.device) return
    this.device.onStart()
  }

  protected onTransportStop(): void {
    if (!this.ready || !this.device) return
    this.device.onStop()
  }

  protected onTransportSeek(beat: number): void {
    // psydrum doesn't support seeking — it's a realtime drum device.
    // We just update the transport snapshot.
    if (this.device) {
      this.device.onTransport({
        bpm: this.currentBpm,
        beat,
        bar: Math.floor(beat / 4),
        phase: (beat % 4) / 4,
        playing: false,
      })
    }
  }

  protected onParamSet(param: ParamId, value: number): void {
    if (!this.ready || !this.device) return
    // psydrum doesn't have a generic setParam method.
    // Parameters are set via config at construction time.
    // For now, we log the param change (future: implement dynamic param updates).
    console.warn(`[PsyDrumAdapter] param.set not fully implemented: ${param} = ${value}`)
  }

  protected onChoke(group: string): void {
    if (!this.ready || !this.device) return
    // Choke = trigger a choke event on the specified group.
    // psydrum handles choke internally via the choke state machine.
    // We trigger a note-off on the choke group's role.
    // For now, we send a note-off on all notes (future: map group to role).
    for (let note = 36; note <= 84; note++) {
      this.device.onEvent({
        type: 'note-off',
        note,
        velocity: 0,
        channel: 9, // MIDI drum channel
      })
    }
  }

  protected setupSubscriptions(): void {
    // Subscribe to trig envelopes (scene matrix clicks).
    this.subscribe(
      (e) => e.payload.kind === 'trig',
      (e) => {
        if (e.payload.kind === 'trig') {
          try {
            this.handleTrig(e.payload.track, e.payload.scene)
          } catch (err) {
            this.reportError('trig-handler', String(err))
          }
        }
      },
    )

    // Subscribe to note envelopes (MIDI-style note on/off).
    this.subscribe(
      (e) => e.payload.kind === 'note',
      (e) => {
        if (e.payload.kind === 'note') {
          try {
            this.handleNoteOn(e.payload.note, e.payload.vel, e.payload.channel)
          } catch (err) {
            this.reportError('note-handler', String(err))
          }
        }
      },
    )

    this.subscribe(
      (e) => e.payload.kind === 'note.off',
      (e) => {
        if (e.payload.kind === 'note.off') {
          try {
            this.handleNoteOff(e.payload.note)
          } catch (err) {
            this.reportError('note-off-handler', String(err))
          }
        }
      },
    )

    // Subscribe to context changes (key, scale, energy, section).
    this.subscribe(
      (e) => e.payload.kind === 'context',
      (e) => {
        if (e.payload.kind === 'context') {
          try {
            this.device?.onContext({
              key: e.payload.key,
              scale: e.payload.scale,
              energy: e.payload.energy,
              section: e.payload.section,
            })
          } catch (err) {
            this.reportError('context-handler', String(err))
          }
        }
      },
    )
  }

  // ── Private handlers ───────────────────────────────────────────────────

  private handleTrig(track: TrackId, scene: SceneId): void {
    if (!this.ready || !this.device) return

    // Map scene to MIDI note.
    const note = SCENE_TO_DRUM_NOTE[scene as string] ?? 36
    const velocity = 0.8 // Default velocity (normalized 0-1)

    // psydrum expects velocity in 0-127 range (it normalizes internally).
    this.device.onEvent({
      type: 'note-on',
      note,
      velocity: velocity * 127,
      channel: 9, // MIDI drum channel
    })
  }

  private handleNoteOn(note: number, velocity: number, channel: number): void {
    if (!this.ready || !this.device) return
    // psydrum expects velocity in 0-127 range.
    const vel = velocity <= 1 ? velocity * 127 : velocity
    this.device.onEvent({
      type: 'note-on',
      note,
      velocity: vel,
      channel,
    })
  }

  private handleNoteOff(note: number): void {
    if (!this.ready || !this.device) return
    this.device.onEvent({
      type: 'note-off',
      note,
      velocity: 0,
      channel: 9,
    })
  }
}

/** Factory function for creating a psydrum adapter. */
export function createPsyDrumAdapter(seed: number): PsyDrumAdapter {
  return new PsyDrumAdapter(seed)
}
