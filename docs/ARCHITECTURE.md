# PSYBOSS — Technical Architecture

> The architecture PSYBOSS delivers. Grounded in the evidence in `ROAST.md` and the protocol
> in `PSYBUS.md`. Every layer below has a concrete implementation target in this repo.

## The thesis

The PSY family built 13 devices that can't play together, on schedulers from 2015, with no
sampler flagship. PSYBOSS is the **sampler flagship + the conductor** — built on the one
discipline the family lacks: a single sample-accurate clock driving everything, a single typed
bus connecting everything, and a single provenance gate protecting everything.

```
                    ┌─────────────────────────────────────────────┐
                    │              UI (React / shadcn)             │
                    │  transport bar · scene matrix · meters ·     │
                    │  track strip · sample browser · scope        │
                    └───────────────┬─────────────────────────────┘
                                    │  (React state ↔ host)
                    ┌───────────────▼─────────────────────────────┐
                    │              PSYBUS (host)                   │
                    │  subscribe · publish · register · route ·    │
                    │  assertProvenance · deterministic seed       │
                    └───────────────┬─────────────────────────────┘
            ┌───────────────────────┼───────────────────────────┐
            ▼                       ▼                           ▼
   ┌────────────────┐    ┌────────────────────┐      ┌────────────────────┐
   │  MasterClock    │    │  Sampler Tracks    │      │  Sibling Devices   │
   │  (AudioWorklet) │    │  (8× stereo)       │      │  (PsySynthPro,     │
   │  BPM · PLL ·    │    │  flex/static ·     │      │   psydrum, …)      │
   │  bar-quantize   │    │  param locks ·     │      │  via PSYBUS adapter│
   │  metering       │    │  conditional trigs │      │                    │
   └────────┬────────┘    └─────────┬──────────┘      └─────────┬──────────┘
            │                       │                           │
            └───────────────────────┼───────────────────────────┘
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │         Web Audio render graph               │
                    │  track → gain → filter → send → master →     │
                    │  limiter → meter → destination               │
                    └─────────────────────────────────────────────┘
```

## Layers

### L0 — Web Audio render graph (the only thing that makes sound)

Every voice routes through a fixed, typed graph. No ad-hoc node creation on the main thread.

```
track[0..7] → GainNode(gain) → BiquadFilterNode(filter) →
  → GainNode(send) ──→ DelayNode(throw) ──→ master
  →                                          ↓
master → DynamicsCompressorNode(limiter) → AnalyserNode(meter) → destination
```

The master `AnalyserNode` feeds the meter UI. The limiter is a real brickwall (threshold -1 dBTP,
5ms lookahead). This is the "master bus" — Gap 5 from ROAST §2, closed at the bus level.

### L1 — MasterClock (AudioWorklet, the one clock)

The family's #1 defect is `setInterval(25)` in the audio path (ROAST §2.1). PSYBOSS kills it.

`PsyBossClockProcessor extends AudioWorkletProcessor` runs **on the audio thread**. Every 128
samples (one quantum) it:
1. Advances the musical clock by `128 / sampleRate` seconds.
2. Computes `beat`, `bar`, `phase` from `bpm`.
3. Posts transport state to the main thread on bar boundaries (not every quantum — that would
   flood the message queue).
4. Drives the meter: accumulates `sumOfSquares` per quantum, posts RMS/peak every ~50ms.
5. Handles bar-quantized launch: when the UI arms a scene, the clock fires the trig at the next
   `phase === 0` boundary — sample-accurate, not `setTimeout`-accurate.

This is a real AudioWorklet scheduler. The main thread never touches timing. (Ported discipline
from `psy5/worklets/psy4-dsp.js`, `psystar/src/engine/lookahead-scheduler.ts`.)

### L2 — PSYBUS (the one bus)

See `docs/PSYBUS.md`. Tier 0 (in-process) in Scope 1. The host is a singleton that:
- Holds the registry of devices + their capabilities.
- Routes envelopes by `dst` (unicast) or `broadcast`.
- Enforces provenance on any `trig`/`note` carrying a `SampleRef`.
- Stamps every envelope with `rev` (monotonic) and `seed` (the performance seed) for replay.

### L3 — Sampler tracks (the device)

PSYBOSS ships 8 stereo sampler tracks. Each track is a PSYBUS device that:
- Subscribes to `transport`, `trig`, `note`, `param.set`, `param.lock`, `sidechain.duck`, `choke`.
- On `trig` for its track → schedules a voice at the envelope's `ts` (sample-accurate).
- Maintains a voice pool (oldest-steal, ported discipline from `psysynth`'s `SynthVoicePool`).
- Publishes `voice.count` telemetry.

**Scope 1 simplification**: tracks generate sound procedurally (a psytrance kick / snare / hat /
bass) in the worklet — no samples, no licensing, proves the DSP is real. Scope 2 adds sample
loading through the provenance gate.

### L4 — UI (React + shadcn)

- **Transport bar**: BPM (138–148 default 144), play/stop, bar/beat readout, master meter.
- **Scene matrix**: 4 tracks × 4 scenes (Scope 1) → 8×16 (Scope 2). Click a cell to arm/fire.
- **Track strips**: gain, filter cutoff, send, mute/solo, parameter-lock indicator.
- **Status footer** (sticky): engine state, latency, active voices, provenance policy.

Mobile-first, responsive, dark theme, keyboard-shortcut driven. The footer sticks per the
project UI rules.

### L5 — Persistence (Turso libSQL, Scope 2+)

Projects, tracks, scenes, sample refs, parameter locks, render jobs — all persisted to Turso
via Prisma. Scope 1 is in-memory only (the vertical slice doesn't need persistence yet).

## Data flow — "click a scene cell → hear a sound"

1. User clicks cell `(track=2, scene=1)` in the React UI.
2. UI calls `host.requestTrig(track, scene)`.
3. Host builds a `trig` envelope, stamps `rev`/`seed`, publishes on PSYBUS at `ts = nextBarTime`.
4. `MasterClock` worklet, at the next bar boundary, posts the armed trig to the main thread.
5. Track-2 device receives the envelope, schedules a voice at `envelope.ts` (sample-accurate).
6. Voice renders into the track's `GainNode` → filter → send → master → limiter → meter → out.
7. Meter worklet posts RMS/peak; UI updates the meter bar.
8. Track-2 publishes `voice.count` telemetry; UI updates the active-voice readout.

No `setInterval`. No `setTimeout` for timing. No main-thread DSP. Sample-accurate end to end.

## Determinism & replay identity

Every performance is a function of `(seed, projectState, inputEvents[])`. Given the same seed
and inputs, the output is byte-identical (ported discipline from `psy/foundation/foundation.mjs`
`resolveSong` + `serializeTimeline` with 10-generation replay identity). This is what makes
offline render (Scope 2) produce a file identical to the live take — the family's replay claim,
finally honored.

## What PSYBOSS explicitly does NOT do (scope discipline)

- **Not a synth.** PsySynthPro is the synth. PSYBOSS sends it MIDI over PSYBUS (Scope 2).
- **Not a drum machine.** psydrum is. PSYBOSS triggers it over PSYBUS (Scope 2).
- **Not a radio follower.** psy4 is the research lab. PSYBOSS consumes a transport, it doesn't derive one (Scope 3 may consume psy5's PLL as an input source).
- **Not a DAW.** No arrangement timeline in Scope 1. Arrangement view is Scope 4.
- **No commercial samples.** CC0 + procedural only. Provenance gate is non-negotiable.

Build less. Connect better. Measure everything. One source of truth. One musical clock. — the
principle the family wrote in `PSY6_ARCHITECTURE.md:4` and never followed. PSYBOSS follows it.
