/**
 * PSYBUS tier-0 host — in-process pub/sub with provenance enforcement + dst routing.
 *
 * Scope 2 fixes (ROAST-1 §4):
 *   - `publish` try/catches each subscriber handler (was: one throw killed the whole bus).
 *   - `publish` enforces `dst` routing (was: all subscribers saw all envelopes → "unicast" was a lie).
 *   - `assertProvenance` validates the `dsp:<id>:<seed>` format for psboss-dsp fingerprints
 *     (was: any string passed).
 *   - `subscribe` records the device id so unicast dst can match it.
 *   - `BusFilter` receives the full envelope (was: payload only → couldn't filter by src/dst).
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

const PSYBOSS_DSP_FINGERPRINT_RE = /^dsp:[a-z0-9:-]+:[0-9]+$/i

export class InProcessPsyBus implements PsyBus {
  private rev = 0
  private readonly _seed: number
  private devices = new Map<DeviceId, DeviceCapabilities>()
  private subscribers: Array<{ device: DeviceId; filter: BusFilter; handler: BusHandler }> = []

  constructor(seed?: number) {
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
    this.subscribers = this.subscribers.filter((s) => s.device !== device)
  }

  subscribe(device: DeviceId, filter: BusFilter, handler: BusHandler): Unsubscribe {
    const entry = { device, filter, handler }
    this.subscribers.push(entry)
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== entry)
    }
  }

  publish(envelope: BusEnvelope): void {
    // Provenance gate on every trig (sampleRef is now required by the type system).
    if (envelope.payload.kind === 'trig') {
      this.assertProvenance(envelope.payload.sampleRef)
    }

    // Route. dst='broadcast' → all subscribers. Otherwise → only the matching device.
    const isBroadcast = envelope.dst === 'broadcast' as const
    for (const sub of this.subscribers) {
      if (!isBroadcast && sub.device !== envelope.dst) continue
      try {
        if (sub.filter(envelope)) sub.handler(envelope)
      } catch (e) {
        // B1 contract: a throwing subscriber must not kill the bus.
        // (ROAST-1 §4 fix; was: throw aborted the loop and remaining subscribers were skipped.)
        if (typeof console !== 'undefined' && console.error) {
          console.error('[PSYBUS] subscriber', sub.device, 'threw on envelope rev', envelope.rev, e)
        }
      }
    }
  }

  assertProvenance(ref: SampleRef): void {
    if (!ref.provenance) {
      throw new ProvenanceError(`SampleRef ${ref.id} has no provenance record`)
    }
    const pr = ref.provenance
    if (!pr.license || !pr.source || !pr.fingerprint || pr.verifiedAt === undefined) {
      throw new ProvenanceError(
        `SampleRef ${ref.id} provenance incomplete (need license, source, fingerprint, verifiedAt)`,
      )
    }
    if (pr.license === 'psboss-dsp') {
      // Validate the dsp:<id>:<seed> format (ROAST-1 §4 fix).
      if (!PSYBOSS_DSP_FINGERPRINT_RE.test(pr.fingerprint)) {
        throw new ProvenanceError(
          `psboss-dsp fingerprint must match dsp:<id>:<seed> (got "${pr.fingerprint}")`,
        )
      }
      return
    }
    // All other licenses require a real sha-256 (64 lowercase hex chars).
    // ROAST-5 #E honesty: the gate validates FORMAT only (64-char hex), not
    // integrity. It does NOT re-hash the sample bytes to verify they match.
    // Integrity is enforced at SampleLibrary.add() time (SHA-256 computed from
    // the file bytes). A malicious actor who swaps the file after loading would
    // bypass this. Acceptable for Scope 4; revisit if PSYBOSS ships commercially.
    if (!/^[a-f0-9]{64}$/.test(pr.fingerprint)) {
      throw new ProvenanceError(
        `SampleRef ${ref.id} fingerprint must be a 64-char lowercase sha-256 (got len ${pr.fingerprint.length})`,
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

let _host: InProcessPsyBus | null = null

export function getBus(seed?: number): InProcessPsyBus {
  if (typeof window === 'undefined') {
    throw new Error('PSYBUS host can only be used in the browser (it owns audio-thread timing)')
  }
  if (!_host) {
    _host = new InProcessPsyBus(seed)
  }
  return _host
}

/** Test helper: create an isolated host with a known seed (no global singleton). */
export function makeBus(seed: number): InProcessPsyBus {
  return new InProcessPsyBus(seed)
}
