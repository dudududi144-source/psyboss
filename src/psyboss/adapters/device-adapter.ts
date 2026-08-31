/**
 * PSYBOSS Device Adapter — base interface for all PSYBUS device adapters.
 *
 * A DeviceAdapter wraps an external audio device (PsySynthPro, psydrum, psysynth,
 * or a Web MIDI device) and exposes it as a first-class PSYBUS participant.
 *
 * The adapter's responsibilities:
 *   1. Register the device with PSYBUS (capabilities, params).
 *   2. Subscribe to relevant bus envelopes (transport, trig, param.set, choke).
 *   3. Translate bus envelopes into device-specific commands.
 *   4. Publish telemetry (voice.count, latency, error) back to the bus.
 *
 * All adapters are deterministic given the same seed — replay-identical.
 */

import type {
  BusEnvelope,
  BusFilter,
  DeviceCapabilities,
  DeviceId,
  ParamId,
  SampleRef,
  TrackId,
} from '@/psybus/types'
import { getBus } from '@/psybus/host'

export interface AdapterTelemetry {
  latencyMs: number
  activeVoices: number
  stolenVoices: number
  lastError: string | null
}

export interface DeviceAdapterOptions {
  deviceId: DeviceId
  seed: number
  capabilities: DeviceCapabilities
}

/**
 * Base class for all device adapters. Subclasses implement the abstract
 * methods to translate PSYBUS envelopes into device-specific commands.
 */
export abstract class DeviceAdapter {
  protected readonly id: DeviceId
  protected readonly seed: number
  protected readonly capabilities: DeviceCapabilities
  protected registered = false
  protected subscriptions: Array<() => void> = []
  protected telemetry: AdapterTelemetry = {
    latencyMs: 0,
    activeVoices: 0,
    stolenVoices: 0,
    lastError: null,
  }

  constructor(options: DeviceAdapterOptions) {
    this.id = options.deviceId
    this.seed = options.seed
    this.capabilities = options.capabilities
  }

  /** Register this device with PSYBUS and subscribe to envelopes. */
  register(): void {
    if (this.registered) return
    const bus = getBus(this.seed)
    bus.register(this.id, this.capabilities)
    this.registered = true

    // Subscribe to transport (BPM, play/stop, bar/beat).
    this.subscribe(
      (e) => e.payload.kind === 'transport',
      (e) => {
        if (e.payload.kind === 'transport') {
          try {
            this.onTransport(e.payload.bpm, e.payload.beat, e.payload.bar, e.payload.playing, e.payload.audioTime)
          } catch (err) {
            this.reportError('transport-handler', String(err))
          }
        }
      },
    )

    // Subscribe to transport control (start/stop/seek).
    this.subscribe(
      (e) => e.payload.kind === 'transport.start',
      () => {
        try {
          this.onTransportStart()
        } catch (err) {
          this.reportError('transport-start-handler', String(err))
        }
      },
    )
    this.subscribe(
      (e) => e.payload.kind === 'transport.stop',
      () => {
        try {
          this.onTransportStop()
        } catch (err) {
          this.reportError('transport-stop-handler', String(err))
        }
      },
    )
    this.subscribe(
      (e) => e.payload.kind === 'transport.seek',
      (e) => {
        if (e.payload.kind === 'transport.seek') {
          try {
            this.onTransportSeek(e.payload.beat)
          } catch (err) {
            this.reportError('transport-seek-handler', String(err))
          }
        }
      },
    )

    // Subscribe to parameter changes.
    this.subscribe(
      (e) => e.payload.kind === 'param.set',
      (e) => {
        if (e.payload.kind === 'param.set') {
          try {
            this.onParamSet(e.payload.param, e.payload.value)
          } catch (err) {
            this.reportError('param-set-handler', String(err))
          }
        }
      },
    )

    // Subscribe to choke groups.
    this.subscribe(
      (e) => e.payload.kind === 'choke',
      (e) => {
        if (e.payload.kind === 'choke') {
          try {
            this.onChoke(e.payload.group)
          } catch (err) {
            this.reportError('choke-handler', String(err))
          }
        }
      },
    )

    // Subclass-specific subscriptions.
    this.setupSubscriptions()
  }

  /** Unregister this device and clean up all subscriptions. */
  unregister(): void {
    if (!this.registered) return
    for (const unsub of this.subscriptions) {
      unsub()
    }
    this.subscriptions = []
    getBus(this.seed).unregister(this.id)
    this.registered = false
  }

  /** Get current telemetry snapshot. */
  getTelemetry(): AdapterTelemetry {
    return { ...this.telemetry }
  }

  // ── Abstract methods (subclasses implement) ─────────────────────────────

  /** Called when transport state changes. */
  protected abstract onTransport(
    bpm: number,
    beat: number,
    bar: number,
    playing: boolean,
    audioTime: number,
  ): void

  /** Called when transport starts. */
  protected abstract onTransportStart(): void

  /** Called when transport stops. */
  protected abstract onTransportStop(): void

  /** Called when transport seeks to a new beat. */
  protected abstract onTransportSeek(beat: number): void

  /** Called when a parameter is set. */
  protected abstract onParamSet(param: ParamId, value: number): void

  /** Called when a choke group fires. */
  protected abstract onChoke(group: string): void

  /** Subclass-specific bus subscriptions (trig, note, sidechain, etc.). */
  protected abstract setupSubscriptions(): void

  // ── Protected helpers ──────────────────────────────────────────────────

  protected subscribe(filter: BusFilter, handler: (e: BusEnvelope) => void): void {
    const bus = getBus(this.seed)
    const unsub = bus.subscribe(this.id, filter, handler)
    this.subscriptions.push(unsub)
  }

  protected publish(envelope: BusEnvelope): void {
    const bus = getBus(this.seed)
    bus.publish(envelope)
  }

  protected nextRev(): number {
    return getBus(this.seed).nextRev()
  }

  protected reportError(code: string, message: string): void {
    this.telemetry.lastError = `${code}: ${message}`
    this.publish({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: 'broadcast',
      ts: Date.now(),
      payload: {
        kind: 'error',
        device: this.id,
        code,
        message,
      },
    })
  }

  protected reportLatency(ms: number): void {
    this.telemetry.latencyMs = ms
    this.publish({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: 'broadcast',
      ts: Date.now(),
      payload: {
        kind: 'latency',
        device: this.id,
        reportLatencyMs: ms,
      },
    })
  }

  protected reportVoiceCount(active: number, stolen: number): void {
    this.telemetry.activeVoices = active
    this.telemetry.stolenVoices = stolen
    this.publish({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: 'broadcast',
      ts: Date.now(),
      payload: {
        kind: 'voice.count',
        device: this.id,
        active,
        stolen,
      },
    })
  }
}
