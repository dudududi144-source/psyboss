/**
 * PSYBOSS -> psysynth adapter.
 *
 * Wraps psysynth (the canonical subtractive-synth realization device) as a PSYBUS device.
 * psysynth is a PsyDevice-conformant subtractive synthesizer with:
 *   - PolyBLEP oscillators (saw, square, triangle, sine)
 *   - ZDF SVF filter (lowpass/highpass/bandpass)
 *   - Modulation matrix (LFOs, envelopes)
 *   - Voice pool with role budgets (bass, lead, arp, pad, stab, pluck, keys)
 *   - Patch library with style-based selection
 *   - Deterministic variance (seeded humanization)
 *   - MIDI note routing
 *
 * The adapter maps PSYBUS envelopes to psysynth's PsyDevice contract:
 *   - transport -> onTransport (snapshot)
 *   - trig -> onEvent (note event with scene-mapped note)
 *   - note/note.off -> onEvent (note event)
 *   - param.set -> CC override (via midiMap)
 *   - context -> onContext (key/scale/energy/style)
 *
 * Telemetry published back to the bus:
 *   - voice.count (from counters)
 *   - latency (from reportLatencyMs)
 *   - error (on any handler exception)
 */

import { DeviceAdapter, type DeviceAdapterOptions } from './device-adapter'
import type { ParamId, TrackId, SceneId } from '@/psybus/types'
import { deviceId, paramId } from '@/psybus/types'

// psysynth types (from psy-foundation-shim/protocol)
interface NoteEvent {
  type: 'note'
  note: number
  velocity: number
  channel: number
  when?: number
  durBeats?: number
}

interface EnergyEvent {
  type: 'energy'
  energy: number
}

interface DropEvent {
  type: 'drop'
  intensity: number
}

type MusicalEvent = NoteEvent | EnergyEvent | DropEvent | { type: 'section' } | { type: 'pattern' } | { type: 'beat' }

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
  style: string
  section: string
}

interface SynthRole {
  // bass, lead, arp, pad, stab, pluck, keys
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
  onEvent(event: MusicalEvent): void
  onTransport(transport: MusicalTransport): void
  onContext(context: MusicalContext): void
  onStart(): void
  onStop(): void
}

interface SynthDeviceOptions {
  deviceId?: string
  audioContext: BaseAudioContext
  outputNode: AudioNode
  delaySendNode?: AudioNode | null
  reverbSendNode?: AudioNode | null
  maxVoices?: number
  seed?: number
  roleBudgets?: Partial<Record<string, number>>
}

interface SynthDeviceConstructor {
  new (opts: SynthDeviceOptions): PsyDevice
}

// psysynth is expected to be available as a module import or global.
declare global {
  interface Window {
    PsySynth?: {
      SynthDevice: SynthDeviceConstructor
    }
  }
}

/** Map PSYBUS scene IDs to MIDI notes for synth triggers. */
const SCENE_TO_SYNTH_NOTE: Record<string, number> = {
  'scene-0': 36, // C2 - bass
  'scene-1': 48, // C3 - low lead
  'scene-2': 60, // C4 - mid lead
  'scene-3': 72, // C5 - high lead
}

/** psysynth parameters that can be controlled via PSYBUS. */
const PSYSYNTH_PARAMS: ParamId[] = [
  paramId('cutoff'),
  paramId('resonance'),
  paramId('attack'),
  paramId('decay'),
  paramId('sustain'),
  paramId('release'),
  paramId('lfoRate'),
  paramId('lfoDepth'),
  paramId('volume'),
]

export class PsySynthAdapter extends DeviceAdapter {
  private device: PsyDevice | null = null
  private ready = false
  private currentBpm = 144
  private ctx: BaseAudioContext | null = null
  private outputNode: AudioNode | null = null

  constructor(seed: number) {
    super({
      deviceId: deviceId('psysynth'),
      seed,
      capabilities: {
        audio: true,
        midiIn: true,
        midiOut: false,
        maxVoices: 16,
        params: PSYSYNTH_PARAMS,
      },
    })
  }

  /** Initialize the psysynth device and register with PSYBUS. */
  async init(ctx: BaseAudioContext, outputNode: AudioNode): Promise<void> {
    if (this.ready) return

    this.ctx = ctx
    this.outputNode = outputNode

    // Wait for psysynth to be available.
    if (typeof window === 'undefined' || !window.PsySynth) {
      throw new Error('psysynth not loaded. Include psysynth bundle first.')
    }

    this.device = new window.PsySynth.SynthDevice({
      deviceId: 'psysynth-psboss',
      audioContext: ctx,
      outputNode,
      maxVoices: 16,
      seed: this.seed,
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
    // psysynth doesn't support seeking - it's a realtime synth.
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
    // psysynth uses CC overrides via midiMap.
    // For now, we send a CC event through the note router.
    // (Future: implement direct param.set on the device)
    console.warn(`[PsySynthAdapter] param.set not fully implemented: ${param} = ${value}`)
  }

  protected onChoke(group: string): void {
    if (!this.ready || !this.device) return
    // Choke = panic all voices.
    this.device.onStop()
    this.device.onStart()
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

    // Subscribe to context changes (key, scale, energy, style).
    this.subscribe(
      (e) => e.payload.kind === 'context',
      (e) => {
        if (e.payload.kind === 'context') {
          try {
            this.device?.onContext({
              key: e.payload.key,
              scale: e.payload.scale,
              energy: e.payload.energy,
              style: 'psytrance', // Default style
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
    const note = SCENE_TO_SYNTH_NOTE[scene as string] ?? 60
    const velocity = 0.8 // Default velocity (normalized 0-1)

    // psysynth expects velocity in 0-1 range.
    this.device.onEvent({
      type: 'note',
      note,
      velocity,
      channel: 0,
    })
  }

  private handleNoteOn(note: number, velocity: number, channel: number): void {
    if (!this.ready || !this.device) return
    // psysynth expects velocity in 0-1 range.
    const vel = velocity <= 1 ? velocity : velocity / 127
    this.device.onEvent({
      type: 'note',
      note,
      velocity: vel,
      channel,
    })
  }
}

/** Factory function for creating a psysynth adapter. */
export function createPsySynthAdapter(seed: number): PsySynthAdapter {
  return new PsySynthAdapter(seed)
}
