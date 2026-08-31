/**
 * PSYBOSS → PsySynthPro adapter.
 *
 * Wraps PsySynthPro (the browser DSP synthesizer) as a PSYBUS device.
 * PsySynthPro is a 16-voice polyphonic subtractive synth with:
 *   - PolyBLEP + wavetable oscillators
 *   - ZDF SVF filter (lowpass/highpass/bandpass)
 *   - Analog-style envelopes (ADSR)
 *   - FM synthesis (6 operators, 3 algorithms)
 *   - Arpeggiator + step sequencer
 *   - FX rack (delay, reverb, distortion, chorus, bitcrush)
 *
 * The adapter maps PSYBUS envelopes to PsySynthPro API calls:
 *   - transport → setBpm + play/stop (via internal sequencer)
 *   - trig → noteOnAt (scene number maps to MIDI note)
 *   - note/note.off → noteOnAt/noteOffAt
 *   - param.set → set(key, value)
 *   - sidechain.duck → (future: filter modulation)
 *
 * Telemetry published back to the bus:
 *   - voice.count (active voices, stolen voices)
 *   - latency (measured from AudioContext)
 *   - error (on any handler exception)
 */

import { DeviceAdapter, type DeviceAdapterOptions } from './device-adapter'
import type { ParamId, TrackId, SceneId } from '@/psybus/types'
import { deviceId, paramId } from '@/psybus/types'

// PsySynthPro is a global (window.PsySynth) loaded via script tag.
// We declare the minimal interface we need.
declare global {
  interface Window {
    PsySynth?: {
      SynthEngine: new () => PsySynthProEngine
    }
  }
}

interface PsySynthProEngine {
  boot(): Promise<void>
  noteOn(note: number, vel: number): void
  noteOff(note: number): void
  noteOnAt(note: number, vel: number, when: number): void
  noteOffAt(note: number, when: number): void
  noteBend(note: number, semis: number): void
  set(key: string, value: number): void
  setAll(obj: Record<string, number>): void
  panic(): void
  latencyMs(): number
  onVoices?: (count: number) => void
}

/** Map PSYBUS scene IDs to MIDI notes (C2 = 36, one octave per scene). */
const SCENE_TO_NOTE: Record<string, number> = {
  'scene-0': 36, // C2
  'scene-1': 48, // C3
  'scene-2': 60, // C4
  'scene-3': 72, // C5
}

/** PsySynthPro parameters that can be controlled via PSYBUS. */
const PSYSYNTHPRO_PARAMS: ParamId[] = [
  paramId('master'),
  paramId('delay'),
  paramId('reverb'),
  paramId('cutoff'),
  paramId('res'),
  paramId('attack'),
  paramId('decay'),
  paramId('sustain'),
  paramId('release'),
  paramId('fmDepth'),
  paramId('fmRatio'),
  paramId('lfoRate'),
  paramId('lfoDepth'),
  paramId('unison'),
  paramId('detune'),
]

export class PsySynthProAdapter extends DeviceAdapter {
  private engine: PsySynthProEngine | null = null
  private ready = false
  private currentBpm = 144
  private activeNotes = new Set<number>()

  constructor(seed: number) {
    super({
      deviceId: deviceId('psysynthpro'),
      seed,
      capabilities: {
        audio: true,
        midiIn: true,
        midiOut: true,
        maxVoices: 16,
        params: PSYSYNTHPRO_PARAMS,
      },
    })
  }

  /** Initialize the PsySynthPro engine and register with PSYBUS. */
  async init(): Promise<void> {
    if (this.ready) return

    // Wait for PsySynthPro global to be available.
    if (typeof window === 'undefined' || !window.PsySynth) {
      throw new Error('PsySynthPro not loaded. Include psysynth-worklet.js and synth-engine.js first.')
    }

    this.engine = new window.PsySynth.SynthEngine()

    // Wire up voice telemetry callback.
    this.engine.onVoices = (count: number) => {
      this.reportVoiceCount(count, 0)
    }

    await this.engine.boot()
    this.ready = true

    // Report latency after boot.
    this.reportLatency(this.engine.latencyMs())

    // Register with PSYBUS.
    this.register()
  }

  /** Dispose the adapter and clean up. */
  dispose(): void {
    if (this.engine) {
      this.engine.panic()
      this.engine = null
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
    if (!this.ready || !this.engine) return
    this.currentBpm = bpm
    // PsySynthPro's internal sequencer syncs to BPM.
    // We set the BPM via the 'tempo' param (if supported).
    this.engine.set('tempo', bpm)
  }

  protected onTransportStart(): void {
    if (!this.ready || !this.engine) return
    // PsySynthPro doesn't have a global play/stop — it responds to noteOn.
    // We don't need to do anything here; notes will be triggered via trig.
  }

  protected onTransportStop(): void {
    if (!this.ready || !this.engine) return
    // Stop all active notes.
    this.engine.panic()
    this.activeNotes.clear()
  }

  protected onTransportSeek(beat: number): void {
    // PsySynthPro doesn't support seeking — it's a realtime synth.
    // We just panic to clear any hanging notes.
    if (this.engine) {
      this.engine.panic()
      this.activeNotes.clear()
    }
  }

  protected onParamSet(param: ParamId, value: number): void {
    if (!this.ready || !this.engine) return
    // PsySynthPro params are 0-100 scale. PSYBUS params are 0-1.
    // We need to scale: value * 100.
    const scaledValue = Math.round(value * 100)
    this.engine.set(param as string, scaledValue)
  }

  protected onChoke(group: string): void {
    if (!this.ready || !this.engine) return
    // Choke = kill all notes in this choke group.
    // For now, we panic all notes (PsySynthPro doesn't support groups).
    this.engine.panic()
    this.activeNotes.clear()
  }

  protected setupSubscriptions(): void {
    // Subscribe to trig envelopes (scene matrix clicks).
    this.subscribe(
      (e) => e.payload.kind === 'trig',
      (e) => {
        if (e.payload.kind === 'trig') {
          try {
            this.handleTrig(e.payload.track, e.payload.scene, e.payload.sampleRef)
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
            this.handleNoteOn(e.payload.note, e.payload.vel, e.payload.durBeats)
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
  }

  // ── Private handlers ───────────────────────────────────────────────────

  private handleTrig(track: TrackId, scene: SceneId, sampleRef: { id: string }): void {
    if (!this.ready || !this.engine) return

    // Map scene to MIDI note.
    const note = SCENE_TO_NOTE[scene as string] ?? 60
    const velocity = 0.8 // Default velocity

    // PsySynthPro uses noteOnAt for sample-accurate scheduling.
    // We use the current AudioContext time (approximation — the worklet
    // handles the actual timing).
    const when = this.getAudioTime()
    this.engine.noteOnAt(note, velocity, when)
    this.activeNotes.add(note)

    // Schedule noteOff after 1 beat (PsySynthPro is a synth, not a sampler).
    const beatDuration = 60 / this.currentBpm
    this.engine.noteOffAt(note, when + beatDuration)
  }

  private handleNoteOn(note: number, velocity: number, durBeats: number): void {
    if (!this.ready || !this.engine) return
    const when = this.getAudioTime()
    this.engine.noteOnAt(note, velocity, when)
    this.activeNotes.add(note)

    // Schedule noteOff based on duration.
    if (durBeats > 0) {
      const durSec = durBeats * (60 / this.currentBpm)
      this.engine.noteOffAt(note, when + durSec)
    }
  }

  private handleNoteOff(note: number): void {
    if (!this.ready || !this.engine) return
    const when = this.getAudioTime()
    this.engine.noteOffAt(note, when)
    this.activeNotes.delete(note)
  }

  private getAudioTime(): number {
    // PsySynthPro's engine has an internal AudioContext.
    // We approximate the current time. In a real implementation,
    // we'd sync this with the PSYBOSS transport clock.
    return (this.engine as any)?.ctx?.currentTime ?? 0
  }
}

/** Factory function for creating a PsySynthPro adapter. */
export function createPsySynthProAdapter(seed: number): PsySynthProAdapter {
  return new PsySynthProAdapter(seed)
}
