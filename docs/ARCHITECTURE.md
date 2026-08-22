# PSYBOSS — Technical Architecture

> The architecture PSYBOSS delivers. Grounded in the evidence in `ROAST.md` and the protocol
> in `PSYBUS.md`. Every claim below is verified by code + tests; claims that were false in
> Scope 1 are marked and fixed in Scope 2 (see ROAST-1 self-roast in `worklog.md`).

## The thesis

The PSY family built 13 devices that can't play together, on schedulers from 2015, with no
sampler flagship. PSYBOSS is the **sampler flagship + the conductor** — built on the one
discipline the family lacks: a single sample-accurate clock driving everything, a single typed
bus connecting everything, and a single provenance gate protecting everything.

```
                    ┌─────────────────────────────────────────────┐
                    │              UI (React / shadcn)             │
                    │  transport bar · scene matrix · meters ·     │
                    │  track row selector · sticky footer          │
                    └───────────────┬─────────────────────────────┘
                                    │  trig(track, scene)  [user gesture]
                    ┌───────────────▼─────────────────────────────┐
                    │              PSYBUS (host)                   │
                    │  publish(trig) → assertProvenance → route    │
                    │  by dst → deliver to engine subscriber       │
                    └───────────────┬─────────────────────────────┘
                                    │  armTrig(track, scene)
                    ┌───────────────▼─────────────────────────────┐
                    │           AudioEngine                        │
                    │  holds armed trigs until next bar boundary   │
                    │  schedules BufferSource at audioTime+sec/bar │
                    │  voice pool: hard cap 64, oldest-steal,      │
                    │  disconnect-on-ended                         │
                    └───────────────┬─────────────────────────────┘
                                    │  start(when)
                    ┌───────────────▼─────────────────────────────┐
                    │         Web Audio render graph               │
                    │  BufferSource → trackGain → masterGain →     │
                    │  limiter → clockWorklet (passthrough+meter)  │
                    │  → destination                               │
                    └─────────────────────────────────────────────┘
```

## Layers

### L0 — Web Audio render graph (the only thing that makes sound)

```
BufferSource[trig] → trackGains[0..3] → masterGain → DynamicsCompressorNode(limiter)
  → AudioWorkletNode(clock: passthrough + meter) → destination
```

The master worklet meters RMS + peak (with 1s hold, 6dB/s decay) and posts dBFS to the UI
every ~50ms. The limiter is `DynamicsCompressorNode` (threshold -1 dBFS, ratio 20:1, 3ms attack).
**Honest caveat (ROAST-1 §1):** this is sample-peak metering, not true-peak (4× oversampled).
A real mastering limiter would measure inter-sample peaks. Scope 4 will add a true-peak worklet.

### L1 — MasterClock (AudioWorklet, the one clock)

The family's #1 defect is `setInterval(25)` in the audio path (ROAST.md §2.1). PSYBOSS kills it.

`PsyBossClockProcessor extends AudioWorkletProcessor` runs **on the audio thread**. Every 128
samples (one quantum) it:
1. Advances the musical clock by `128 / sampleRate` seconds.
2. Computes `beat`, `bar`, `phase` from `bpm`.
3. Posts transport state to the main thread on bar boundaries (not every quantum — that would
   flood the message queue). Also posts immediately on `play`, `stop`, `setBpm` (ROAST-1 §3 fix:
   was stale for up to 1 bar).
4. Meters: accumulates `sumOfSquares` + peak, posts RMS/peak every ~50ms with peak-hold.

**Honest caveat (ROAST-1 §4):** the worklet is a clock + meter, NOT a synthesizer. All sound is
pre-rendered procedural DSP (see L3) loaded into AudioBuffers at init. Real-time per-sample
worklet synthesis is a Scope 3 goal (port `psy5/worklets/psy4-dsp.js`).

### L2 — PSYBUS (the one bus)

See `docs/PSYBUS.md`. Tier 0 (in-process) in Scope 2. The host:
- Holds the registry of devices + their capabilities.
- Routes envelopes by `dst` (unicast) or `broadcast` (ROAST-1 §4 fix: was decorative).
- `publish` try/catches each subscriber (ROAST-1 §4 fix: was one-throw-kills-all).
- Enforces provenance on every `trig` (sampleRef is now REQUIRED by the type system, not optional).
- Stamps every envelope with `rev` (monotonic) and `seed` (the performance seed) for replay.

**The trig path is now wired through the bus** (ROAST-1 §1 fix: was dead code in Scope 1):
```
UI.requestTrig(track, scene)
  → bus.publish({ kind:'trig', sampleRef: dspProvenance(soundId, seed) })
  → host.assertProvenance(sampleRef)   // gate RUNS here
  → host routes to engine subscriber
  → engine.armTrig(track, scene)
  → (next bar boundary) engine.scheduleVoice at audioTime + secPerBar
```
If the gate throws, the trig is rejected — no sound, by design. Verified by `tests/psyboss/psybus.test.ts`.

### L3 — Procedural DSP (the sound source, Scope 1 → 2)

PSYBOSS ships 4 tracks (KICK/SNARE/HAT/BASS) × 4 scenes = 16 procedural sounds. Each is rendered
sample-by-sample at init into an `AudioBuffer`. **No OscillatorNode, no samples, no licensing.**

Scope 2 DSP improvements (ROAST-1 §2 fixes):
- **mulberry32 PRNG** threaded through all renderers (was `Math.random` → broke determinism).
- **PolyBLEP saw** in the bass (was naive saw → aliased to the 436th harmonic).
- **DC blocker** on every renderer (prevents DC offset accumulation).
- **Denormal guard** on envelopes (prevents CPU spikes in long tails).
- **Ramped clicks** — kick/snare/hat ramp the first 10-20 samples (was a click at sample 0).
- **Real stereo decorrelation** — snare/hat use two independent seeded noise streams (was fake 0.9×).
- **Soft saturation (tanh)** + hard clamp guard — guarantees |sample| ≤ 1.0.
- **Bass variant 3 fixed** — was a dead branch that overrode octave+fifth to octave only.

Every sound carries `provenance: { license: 'psboss-dsp', fingerprint: 'dsp:<id>:<seed>' }`.
The host validates this format. Verified by `tests/psyboss/dsp.test.ts` (determinism + bounds + spectral).

### L4 — UI (React + shadcn)

- **Transport bar**: BPM (120–160, default 144), play/stop, bar:beat readout, master meter (RMS+peak).
- **Scene matrix**: 4 tracks × 4 scenes. Click a cell to arm/fire. Keyboard: `1-4` scenes, `Q-R` track, `Space` play.
- **Track row selector**: highlights the current keyboard-focused row.
- **Status footer** (sticky): transport state, phase, beat, engine info.

Scope 2 UI fixes (ROAST-1 §6):
- **Split meter store** — meter updates (20/sec) no longer re-render the scene matrix.
- **Keyboard shortcuts** — was zero in Scope 1.
- **Mobile meter** — was hidden on phones in Scope 1.
- **Limiter tick at -1 dBFS** — was misleading -6dB tick.

### L5 — Persistence (Turso libSQL, Scope 3+)

Not yet wired. Scope 3 will add Prisma schema (`Project`, `Track`, `Scene`, `SampleRef`,
`ParameterLock`, `RenderJob`) and Turso libSQL with real migrations.

## Data flow — "click a scene cell → hear a sound" (Scope 2, verified)

1. User clicks cell `(track=2, scene=1)` in the React UI.
2. UI calls `engine.requestTrig(track, scene)`.
3. Engine builds a `trig` envelope with `sampleRef: dspProvenance('2:1', seed)` and calls `bus.publish`.
4. **Host runs `assertProvenance`** — validates the `dsp:2:1:<seed>` fingerprint format. If invalid, throws → no sound.
5. Host routes the envelope (unicast to `psyboss-engine`) to the engine's subscriber.
6. Engine calls `armTrig(2, 1)` — pushes to the armed list.
7. Worklet, at the next bar boundary, posts `transport` with `audioTime = currentTime`.
8. Engine's `onmessage` handler calls `flushArmedTrigs` → schedules `BufferSource.start(audioTime + secPerBar)`.
9. Voice plays into `trackGains[2]` → `masterGain` → `limiter` → `clockNode` (meter) → `destination`.
10. Worklet meters the output, posts RMS/peak → `useMeter` store → meter bar updates.
11. Voice's `onended` fires → removed from active set + disconnected (no leak).

**Honest timing caveat (ROAST-1 §3):** the voice fires at the NEXT bar boundary after the click,
not the one the click happened in. This is bar-quantized (correct) but adds up to 1 bar of latency
for a click just after a boundary. A 100ms Worker lookahead scheduler (port `psy-sampler`'s
`realization-scheduler.ts`) would let us schedule ahead and land exactly on the target bar. Scope 3.

## Determinism & replay identity (Scope 2, verified)

Every performance is a function of `(seed, projectState, inputEvents[])`. The seed (`0x9e3779b9`
default) is threaded through:
- `mulberry32(seed)` → per-sound `subSeed(seed, soundId)` → independent noise streams.
- `dspProvenance(soundId, seed)` → fingerprint `dsp:<soundId>:<seed>`, `verifiedAt: seed`.

Same seed → byte-identical `Float32Array`s across runs. Verified by `tests/psyboss/dsp.test.ts`
("same seed → byte-identical buffers across runs"). Different seed → different audio (verified).
No `Math.random` or `Date.now` in `dsp.ts` (verified by test that greps the source).

## Voice management (Scope 2, verified)

- `activeVoices: Set<AudioBufferSourceNode>` — tracks live voices.
- Hard cap 64. Under pressure, the oldest voice is stolen (`stop()` → `onended` cleans up).
- Every voice has `onended = () => { delete from set; disconnect() }` — no node accumulation.

## What PSYBOSS explicitly does NOT do (scope discipline)

- **Not a synth.** PsySynthPro is the synth. PSYBOSS sends it MIDI over PSYBUS (Scope 3).
- **Not a drum machine.** psydrum is. PSYBOSS triggers it over PSYBUS (Scope 3).
- **Not a radio follower.** psy4 is the research lab. PSYBOSS consumes a transport, it doesn't derive one.
- **Not a DAW.** No arrangement timeline. Arrangement view is Scope 4.
- **No commercial samples.** CC0 + procedural only. Provenance gate is non-negotiable.
- **No real-time worklet synthesis (yet).** Sound is pre-rendered AudioBuffers. Scope 3 goal.

Build less. Connect better. Measure everything. One source of truth. One musical clock. — the
principle the family wrote in `PSY6_ARCHITECTURE.md:4` and never followed. PSYBOSS follows it,
and now the docs match the code (ROAST-1 §8 fix: 18 doc-vs-code lies corrected).
