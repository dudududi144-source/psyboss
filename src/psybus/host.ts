/**
 * PSYBUS tier-0 host — in-process pub/sub with provenance enforcement.
 *
 * This is the conductor. It owns the monotonic revision counter, the performance
 * seed, the device registry, and the provenance gate. Every envelope that flows
 * between devices passes through here.
 *
 * Scope 2 will add a Worker-boundary transport (same types, postMessage wire).
 */

import type {
  BusEnvelope,
  BusFilter,
  BusHandler,
  DeviceCapabilities,
  DeviceId,
  PsyBus,
  SampleRef,
  Unsubscribe,
} from './types'

export class InProcessPsyBus implements PsyBus {
  private rev = 0
  private readonly _seed: number
  private devices = new Map<DeviceId, DeviceCapabilities>()
  private subscribers: Array<{ filter: BusFilter; handler: BusHandler }> = []

  constructor(seed?: number) {
    // mulberry32-friendly seed; default to a fixed seed for replay identity
    this._seed = seed ?? 0x9e3779b9
  }

  seed(): number {
    return this._seed
  }

  nextRev(): number {
    return ++this.rev
  }

  register(device: DeviceId, capabilities: DeviceCapabilities): void {
    this.devices.set(device, capabilities)
  }

  unregister(device: DeviceId): void {
    this.devices.delete(device)
  }

  subscribe(_device: DeviceId, filter: BusFilter, handler: BusHandler): Unsubscribe {
    const entry = { filter, handler }
    this.subscribers.push(entry)
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== entry)
    }
  }

  publish(envelope: BusEnvelope): void {
    // Provenance gate: refuse to route sample-bearing events without valid provenance.
    const p = envelope.payload
    if (p.kind === 'trig' && p.sampleRef) {
      this.assertProvenance(p.sampleRef)
    }
    // Route (tier 0: in-process synchronous delivery)
    for (const sub of this.subscribers) {
      if (sub.filter(envelope.payload)) {
        sub.handler(envelope)
      }
    }
  }

  assertProvenance(ref: SampleRef): void {
    if (!ref.provenance) {
      throw new ProvenanceError(`SampleRef ${ref.id} has no provenance record`)
    }
    const pr = ref.provenance
    if (!pr.license || !pr.source || !pr.fingerprint || !pr.verifiedAt) {
      throw new ProvenanceError(
        `SampleRef ${ref.id} provenance incomplete (need license, source, fingerprint, verifiedAt)`,
      )
    }
    // 'psboss-dsp' is the only license accepted without an external fingerprint check
    // (its fingerprint is 'dsp:<generator>:<seed>'). All others require a real sha-256.
    if (pr.license !== 'psboss-dsp' && pr.fingerprint.length !== 64) {
      throw new ProvenanceError(
        `SampleRef ${ref.id} fingerprint must be a 64-char sha-256 (got len ${pr.fingerprint.length})`,
      )
    }
  }
}

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProvenanceError'
  }
}

/**
 * The singleton host. PSYBOSS owns exactly one. Devices register against it.
 * Created lazily on first access (client-only — the bus must not run on the server).
 */
let _host: InProcessPsyBus | null = null

export function getBus(): InProcessPsyBus {
  if (typeof window === 'undefined') {
    throw new Error('PSYBUS host can only be used in the browser (it owns audio-thread timing)')
  }
  if (!_host) {
    _host = new InProcessPsyBus()
  }
  return _host
}
