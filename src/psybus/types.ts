/**
 * PSYBUS — the typed bidirectional protocol for the PSY family.
 * See docs/PSYBUS.md for the full spec.
 *
 * Scope 2 fixes (ROAST-1 §4):
 *   - `sampleRef` is now REQUIRED on `trig` (was optional → gate was vacuous for procedural).
 *   - `BusFilter` receives the full envelope (not just payload) so devices can filter by
 *     src/dst/ts/rev/seed.
 *   - `psboss-dsp` fingerprints must match `dsp:<id>:<seed>` (validated by host).
 */

// ── Branded nominal types ────────────────────────────────────────────────────
export type DeviceId = string & { __brand: 'DeviceId' }
export type TrackId = string & { __brand: 'TrackId' }
export type SceneId = string & { __brand: 'SceneId' }
export type ParamId = string & { __brand: 'ParamId' }
export type ChokeGroupId = string & { __brand: 'ChokeGroupId' }

export const deviceId = (s: string) => s as DeviceId
export const trackId = (s: string) => s as TrackId
export const sceneId = (s: string) => s as SceneId
export const paramId = (s: string) => s as ParamId
export const chokeGroupId = (s: string) => s as ChokeGroupId

// ── Musical primitives ───────────────────────────────────────────────────────
export type MusicalKey =
  | 'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B'
export type Scale = 'minor' | 'minorPentatonic' | 'phrygian' | 'harmonicMinor' | 'dorian'
export type Section = 'intro' | 'build' | 'drop' | 'breakdown' | 'outro'

export interface MusicalContext {
  key: MusicalKey
  scale: Scale
  energy: number
  section: Section
}

// ── Provenance (the non-negotiable gate) ─────────────────────────────────────
export type License =
  | 'CC0'
  | 'CC-BY'
  | 'CC-BY-SA'
  | 'CC-BY-NC'
  | 'commercial-licensed'
  | 'psboss-dsp'

export interface Provenance {
  license: License
  source: string
  author?: string
  verifiedAt: number
  fingerprint: string // sha-256 (64 hex chars) OR 'dsp:<id>:<seed>' for psboss-dsp
}

export interface SampleRef {
  id: string
  provenance: Provenance // REQUIRED
}

export interface DeviceCapabilities {
  audio: boolean
  midiIn: boolean
  midiOut: boolean
  maxVoices: number
  params: ParamId[]
}

// ── The payload discriminated union ──────────────────────────────────────────
export type BusPayload =
  | { kind: 'transport'; bpm: number; beat: number; bar: number; phase: number; playing: boolean; audioTime: number }
  | { kind: 'transport.seek'; beat: number }
  | { kind: 'transport.start' }
  | { kind: 'transport.stop' }
  | { kind: 'context'; key: MusicalKey; scale: Scale; energy: number; section: Section }
  | { kind: 'note'; track: TrackId; note: number; vel: number; durBeats: number; channel: number }
  | { kind: 'note.off'; track: TrackId; note: number }
  // trig REQUIRES sampleRef (ROAST-1 §4 fix: procedural sounds carry psboss-dsp provenance)
  | { kind: 'trig'; track: TrackId; scene: SceneId; sampleRef: SampleRef }
  | { kind: 'sidechain.duck'; target: TrackId; depth: number; releaseMs: number }
  | { kind: 'choke'; group: ChokeGroupId; except?: DeviceId }
  | { kind: 'param.lock'; track: TrackId; step: number; param: ParamId; value: number }
  | { kind: 'param.set'; track: TrackId; param: ParamId; value: number }
  | { kind: 'latency'; device: DeviceId; reportLatencyMs: number }
  | { kind: 'voice.count'; device: DeviceId; active: number; stolen: number }
  | { kind: 'error'; device: DeviceId; code: string; message: string }

export interface BusEnvelope<T extends BusPayload = BusPayload> {
  rev: number
  seed: number
  src: DeviceId
  dst: DeviceId | 'broadcast'
  ts: number
  payload: T
}

export type Unsubscribe = () => void
export type BusFilter = (e: BusEnvelope) => boolean
export type BusHandler = (e: BusEnvelope) => void

export interface PsyBus {
  subscribe(device: DeviceId, filter: BusFilter, handler: BusHandler): Unsubscribe
  publish(envelope: BusEnvelope): void
  register(device: DeviceId, capabilities: DeviceCapabilities): void
  unregister(device: DeviceId): void
  assertProvenance(ref: SampleRef): void
  nextRev(): number
  seed(): number
}
