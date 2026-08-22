# PSYBUS — The Protocol That Makes the PSY Family Play Together

> The family's `PsyDevice` contract is one-way push (host → device). Devices can't talk to
> each other. No sidechain coordination, no choke groups, no clock negotiation. PSYBUS is the
> bidirectional, typed protocol PSYBOSS introduces to fix that — without breaking the existing
> contract (it extends it).

## Design principles

1. **One clock.** The host owns the transport. Devices consume it; they never run their own.
2. **Bidirectional.** Devices `publish` events; the host routes them to subscribers. A kick can
   tell a bass to duck. A drum can tell a sampler to choke.
3. **Typed end-to-end.** Every message is a discriminated union. No `any`. No stringly-typed.
4. **Deterministic.** Every event carries a `rev` (revision) and `seed`. Replay is byte-identical.
5. **Transport-agnostic.** The same protocol runs in-process (today), over a Worker `postMessage`
   (Scope 2), and over WebRTC data channels (Scope 3). The types don't change.
6. **Provenance or nothing.** Sample events carry a `Provenance` record. The host refuses to
   route events whose samples lack license metadata.

## The message envelope

```ts
interface BusEnvelope<T extends BusPayload = BusPayload> {
  rev: number                 // monotonic transport revision (ticks since start)
  seed: number                // deterministic seed for this performance
  src: DeviceId               // publisher
  dst: DeviceId | 'broadcast' // target or all
  ts: number                  // audio-context time (seconds) the event is valid at
  payload: T
}
```

## The payload discriminated union

```ts
type BusPayload =
  // — Transport (host → devices, sample-accurate) —
  | { kind: 'transport'; bpm: number; beat: number; bar: number; phase: number; playing: boolean }
  | { kind: 'transport.seek'; beat: number }
  | { kind: 'transport.start' }
  | { kind: 'transport.stop' }

  // — Musical context (host → devices, the "what key are we in" channel) —
  | { kind: 'context'; key: MusicalKey; scale: Scale; energy: number; section: Section }

  // — Note / trigger events (host OR device → devices) —
  | { kind: 'note'; track: TrackId; note: number; vel: number; durBeats: number; channel: number }
  | { kind: 'note.off'; track: TrackId; note: number }
  | { kind: 'trig'; track: TrackId; scene: SceneId; sampleRef?: SampleRef }

  // — Device-to-device control (the NEW capability) —
  | { kind: 'sidechain.duck'; target: TrackId; depth: number; releaseMs: number }
  | { kind: 'choke'; group: ChokeGroupId; except?: DeviceId }
  | { kind: 'param.lock'; track: TrackId; step: number; param: ParamId; value: number }
  | { kind: 'param.set'; track: TrackId; param: ParamId; value: number }

  // — Telemetry / health (device → host) —
  | { kind: 'latency'; device: DeviceId; reportLatencyMs: number }
  | { kind: 'voice.count'; device: DeviceId; active: number; stolen: number }
  | { kind: 'error'; device: DeviceId; code: string; message: string }
```

## The branded types

```ts
type DeviceId = string & { __brand: 'DeviceId' }
type TrackId  = string & { __brand: 'TrackId' }
type SceneId  = string & { __brand: 'SceneId' }
type ParamId  = string & { __brand: 'ParamId' }
type ChokeGroupId = string & { __brand: 'ChokeGroupId' }

interface SampleRef {
  id: string
  provenance: Provenance     // REQUIRED — host refuses to route without it
}

interface Provenance {
  license: 'CC0' | 'CC-BY' | 'CC-BY-SA' | 'CC-BY-NC' | 'commercial-licensed' | 'psboss-dsp'
  source: string            // URL or "PSYBOSS DSP generator v1"
  author?: string
  verifiedAt: number        // epoch ms
  fingerprint: string       // sha-256 of sample bytes (for integrity)
}
```

## The host interface

```ts
interface PsyBus {
  subscribe(device: DeviceId, filter: (p: BusPayload) => boolean, handler: (e: BusEnvelope) => void): Unsubscribe
  publish(envelope: BusEnvelope): void
  register(device: DeviceId, capabilities: DeviceCapabilities): void
  unregister(device: DeviceId): void
  route(envelope: BusEnvelope): void          // delivers to subscribers
  assertProvenance(ref: SampleRef): void      // throws if missing/invalid
}
```

## Backwards compatibility with `PsyDevice`

The existing `PsyDevice` contract (`onTransport`, `onContext`, `onEvent`, `onStart`, `onStop`)
maps cleanly onto PSYBUS payloads:

- `onTransport(t)` ← `{ kind: 'transport', ... }`
- `onContext(c)` ← `{ kind: 'context', ... }`
- `onEvent(e)` ← `{ kind: 'note' | 'trig' | ... }`

A thin adapter (`PsyDeviceAdapter`) wraps any existing `PsyDevice` so it can live on PSYBUS
without code changes. New devices (like PSYBOSS's own sampler tracks) implement PSYBUS directly
and gain `publish` — the capability the old contract lacks.

## Transport tiers (same types, different wire)

| tier | scope | transport | latency |
|------|-------|-----------|---------|
| 0 | in-process (Scope 1) | direct function calls | ~0 |
| 1 | Worker boundary (Scope 2) | `postMessage` (structured clone) | <1ms |
| 2 | cross-tab (Scope 3) | `BroadcastChannel` | ~2ms |
| 3 | cross-peer (Scope 3) | WebRTC data channel | 20–80ms + jitter buffer |

The envelope and payload types are identical across all tiers. Only the wire differs.

## What PSYBUS unlocks

- **Sidechain without a cable**: PSYBOSS's kick track publishes `sidechain.duck` → bass track
  subscribes → instant psytrance pumping, no manual routing.
- **Choke groups**: a hi-hat device publishes `choke` → open-hat device stops ringing. Hardware
  behavior, finally in the browser.
- **Parameter locks as events**: per-step parameter changes are just `param.lock` envelopes on
  the bus — recordable, deterministic, replayable.
- **Telemetry**: the host UI shows real per-device latency and voice counts — no more "16 voices"
  claims that are actually 6.
- **Collaboration**: in Scope 3, the same envelopes flow over WebRTC. Two performers, one bus.
