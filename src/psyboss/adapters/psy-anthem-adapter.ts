/**
 * PSYBOSS adapter: hosts a psy-anthem composition engine on the PSYBUS.
 *
 * psy-anthem is NOT a dependency of psyboss. The host app injects an object
 * satisfying the structural interface below (duck-typed from psy-anthem's
 * PsyAnthemAdapter). Wiring in the host:
 *
 *   import { PsyAnthemAdapter, InMemoryPSYBUS } from 'psy-anthem/src/integration'
 *   const anthem = new PsyAnthemAdapter({ deviceId: 'anthem-001', seed, send: () => {} })
 *   const bridge = new PsyBossAnthemAdapter({ deviceId: deviceId('anthem-host'), seed, anthem })
 *   bridge.register()
 *
 * Responsibilities:
 *   1. Forward transport / param.set / choke / sidechain.duck envelopes to the
 *      anthem engine (the WHAT layer decides which notes happen).
 *   2. Republish the anthem engine's note / telemetry envelopes onto the bus,
 *      where synth + drum device adapters consume them.
 *   3. Publish adapter telemetry (registration + errors) like every other device.
 */

import type {
  BusEnvelope,
  DeviceCapabilities,
  DeviceId,
  ParamId,
  TrackId,
} from '@/psybus/types'
import { trackId } from '@/psybus/types'
import { DeviceAdapter } from './device-adapter'

/**
 * Structural interface matching psy-anthem's PsyAnthemAdapter public surface.
 * Kept structural so psyboss never imports the psy-anthem package.
 */
export interface AnthemCompositionSource {
  deviceId: string
  setSend(send: (msg: unknown) => void): void
  handleEnvelope(envelope: unknown): void
  loadScene(sceneId: string, config: unknown): void
  play(positionBeats?: number): void
  stop(): void
  seek(positionBeats: number): void
  reportTelemetry(): void
}

export interface PsyBossAnthemAdapterOptions {
  deviceId: DeviceId
  seed: number
  anthem: AnthemCompositionSource
  /** Track id stamped on forwarded envelopes. */
  track?: TrackId
}

export class PsyBossAnthemAdapter extends DeviceAdapter {
  private readonly anthem: AnthemCompositionSource
  private readonly anthemTrack: TrackId
  private lastPositionBeats = 0

  constructor(options: PsyBossAnthemAdapterOptions) {
    const capabilities: DeviceCapabilities = {
      audio: false, // the anthem engine emits note envelopes; devices make the sound
      midiIn: false,
      midiOut: true,
      maxVoices: 0,
      params: [],
    }
    super({ deviceId: options.deviceId, seed: options.seed, capabilities })
    this.anthem = options.anthem
    this.anthemTrack = options.track ?? trackId('anthem')

    // Anthem output -> PSYBOSS. Envelope kinds like 'scene.loaded',
    // 'composition.events' and 'device.telemetry' are not in the shared bus
    // union; they pass through routing untouched and are simply ignored by
    // filters that do not know them.
    this.anthem.setSend((msg) => {
      this.publish(msg as unknown as BusEnvelope)
    })
  }

  // ---- Public API (host control surface) -------------------------------

  /** Generate + load a composition into the hosted engine. */
  loadScene(sceneId: string, config: unknown): void {
    this.anthem.loadScene(sceneId, config)
  }

  /** Start emitting events from a position (beats). */
  playAnthem(positionBeats = 0): void {
    this.anthem.play(positionBeats)
  }

  /** Stop emission. */
  stopAnthem(): void {
    this.anthem.stop()
  }

  /** Seek the composition (beats). */
  seekAnthem(positionBeats: number): void {
    this.lastPositionBeats = Math.max(0, positionBeats)
    this.anthem.seek(this.lastPositionBeats)
  }

  /** Ask the engine for quality telemetry (events / quality / memorability). */
  requestTelemetry(): void {
    this.anthem.reportTelemetry()
  }

  // ---- Phase 12: morphing + live automation --------------------------

  /**
   * Start morphing the hosted composition into another scene.
   * Scene configs are psy-anthem AnthemConfig objects (unknown here: psyboss
   * never imports psy-anthem). The morph.start envelope reaches the engine,
   * which generates both scenes and blends emissions as morph.update arrives.
   */
  startMorph(
    fromScene: unknown,
    toScene: unknown,
    durationBars: number,
    curve: 'linear' | 'exponential' | 'bezier' = 'linear',
  ): void {
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'morph.start', fromScene, toScene, durationBars, curve },
    })
  }

  /** Drive the morph progress (0-1), typically from the transport clock. */
  updateMorph(progress: number): void {
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'morph.update', progress: Math.max(0, Math.min(1, progress)) },
    })
  }

  /**
   * Start a live parameter automation on the hosted engine.
   * param: 'velocity' | 'duration' | 'pitch'; values are automation space
   * (velocity/duration multipliers; pitch in [-1, 1] octaves).
   */
  startAutomation(
    param: string,
    startValue: number,
    endValue: number,
    durationBeats: number,
    curve: 'linear' | 'exponential' | 'bezier' = 'linear',
  ): void {
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'automation.start', param, startValue, endValue, durationBeats, curve },
    })
  }

  /** Stop a running automation. */
  stopAutomation(param: string): void {
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'automation.stop', param },
    })
  }

  // ---- Phase 13: real-time generative evolution --------------------

  /**
   * Enable real-time generative evolution on the hosted anthem engine.
   * The config shape is psy-anthem's RealtimeGenerationConfig (unknown here:
   * psyboss never imports psy-anthem).
   */
  enableRealtimeGeneration(config: unknown): void {
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'realtime.enable', config },
    })
  }

  /** Disable real-time evolution. */
  disableRealtimeGeneration(): void {
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'realtime.disable' },
    })
  }

  /** Force an immediate evolution regardless of the regeneration interval. */
  forceEvolution(): void {
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'realtime.evolve', force: true },
    })
  }

  // ---- DeviceAdapter abstract implementation: forward to the engine ----

  protected onTransport(
    bpm: number,
    beat: number,
    bar: number,
    playing: boolean,
    audioTime: number,
  ): void {
    this.lastPositionBeats = bar * 4 + beat
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'transport', bpm, beat, bar, phase: 0, playing, audioTime },
    })
  }

  protected onTransportStart(): void {
    this.anthem.play(this.lastPositionBeats)
  }

  protected onTransportStop(): void {
    this.anthem.stop()
  }

  protected onTransportSeek(beat: number): void {
    this.lastPositionBeats = Math.max(0, beat)
    this.anthem.seek(this.lastPositionBeats)
  }

  protected onParamSet(param: ParamId, value: number): void {
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'param.set', track: this.anthemTrack, param, value },
    })
  }

  protected onChoke(group: string): void {
    this.anthem.handleEnvelope({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: this.anthem.deviceId,
      ts: Date.now(),
      payload: { kind: 'choke', group },
    })
  }

  protected setupSubscriptions(): void {
    // Sidechain ducks reach the engine so emitted notes get ducked velocities.
    this.subscribe(
      (e) => e.payload.kind === 'sidechain.duck',
      (e) => {
        try {
          this.anthem.handleEnvelope(e)
        } catch (err) {
          this.reportError('anthem-sidechain', String(err))
        }
      },
    )
  }
}
