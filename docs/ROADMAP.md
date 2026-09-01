# PSYBOSS — Roadmap

> Scoped delivery. Each scope is a complete, verifiable, shippable increment. No scope starts
> until the previous one is browser-verified (Agent Browser E2E + lint + dev log clean).

## Scope 1 — Foundation & Proving Slice ✅ (this repo, current)

**Goal**: prove the architecture works end-to-end with one real axis.

- ✅ Architecture docs (`ROAST`, `ARCHITECTURE`, `PSYBUS`, `ROADMAP`)
- ✅ `psyboss` repo, clean git history, no secrets, pushed to GitHub
- ✅ PSYBUS protocol types + in-process host (tier 0)
- ✅ `MasterClock` AudioWorklet — BPM, play/stop, bar-quantized launch, metering
- ✅ 4 sampler tracks × 4 scenes matrix (procedural psytrance sounds, no samples)
- ✅ DAW shell UI on `/` — transport bar, scene grid, master meter, sticky status footer
- ✅ Vertical slice verified: click cell → sound at next bar → meter moves
- ✅ Lint clean, dev log clean, Agent Browser E2E pass

**Exit criteria**: a user can press play, tap scene cells, hear sample-accurate psytrance
sounds through a metered master bus, with a real AudioWorklet clock — no `setInterval` in the
audio path. This is more than every flagship groovebox in the family ships with today.

## Scope 2 — The Real Sampler (sample loading + parameter locks)

**Goal**: make it an actual sampler, not a procedural demo.

- Sample loading through the provenance gate (`assertProvenance` enforced on every `SampleRef`)
- CC0 sample library shipped with the repo (Freesound CC0 curated set, fingerprints verified)
- Drag-drop import with mandatory license metadata form (closes `psy-sampler`'s `addFromBuffer` hole)
- Per-step parameter locks (Elektron-style): `param.lock` envelopes on the bus, recorded per step
- Conditional trigs: probability, fill, not-fill (LFSR-seeded, deterministic)
- 8 tracks × 16 scenes
- Track FX: filter (ZDF SVF, ported from `PsySynthPro`), drive (real tanh in worklet), send delay
- Offline WAV render (4/8-bar, master + stems) — byte-identical to live take
- Prisma schema: `Project`, `Track`, `Scene`, `Clip`, `SampleRef`, `ParameterLock`, `RenderJob`
- Turso libSQL backend (migrations, not `--accept-data-loss`)
- Test suite: DSP numerical tests (kick peak at 50Hz, sidechain depth), transport timing A–J streams

**Exit criteria**: a user can load their own CC0 samples, build a scene with parameter locks,
render a DJ-ready WAV, and the render matches the live take bit-for-bit.

## Scope 3 — The Conductor (MIDI clock + siblings + P2P)

**Goal**: make PSYBOSS the host the family plays through.

- 24-ppq MIDI clock in/out (port `psystar/src/engine/midi-clock.ts`)
- Web MIDI input mapping (controller → PSYBUS `param.set` / `trig`)
- `PsyDeviceAdapter` — wrap `PsySynthPro`, `psydrum`, `psysynth` as PSYBUS devices (they register, receive transport/trig, publish voice telemetry)
- Device-to-device: kick track publishes `sidechain.duck` → bass track/subscribes (real psytrance pumping)
- Choke groups (mute groups) across tracks/devices
- WebRTC P2P sync (port `psystar` `RTCPeerConnection`) — two performers, one bus, jitter-buffered transport
- Realtime collaboration: shared scene matrix, per-performer cursor, conflict-free param sets (last-writer-wins on `rev`)

**Exit criteria**: a user can host PsySynthPro + psydrum inside PSYBOSS, trigger them from the
scene matrix, have the kick sidechain the bass automatically, and jam with a second performer
over WebRTC — all sample-accurate.

## Scope 4 — Arrangement & Mastering ✅ COMPLETE

**Goal**: turn performances into finished, releasable tracks.

**Delivered**: ITU-R BS.1770 mastering chain (LUFS meter + true-peak limiter +
loudness normalization), arrangement timeline with clip sequencing, and full-length
mastered export. Exit criteria met: a user can arrange a full track, master it to
Beatport (-8 LUFS) or Spotify (-14 LUFS, -1 dBTP), and export a release-ready WAV.

- ✅ Arrangement view (linear timeline, clip sequencing with Intro/Build/Drop/Break/Outro labels)
- ✅ Song export (full length, not just 4-bar)
- ✅ Master bus: true-peak limiter + LUFS meter (-8 club / -14 streaming targets)
- ⏳ ID3/metadata tagging on export (future)
- ✅ A/B against reference track (loudness-matched, ITU-R BS.1770)

**Exit criteria**: a user can arrange a full track, master it to Beatport (-8 LUFS) or Spotify
(-14 LUFS, -1 dBTP), and export a release-ready file.

## Scope 5 — Intelligence (real, not fake)

**Goal**: the DO-NOTHING director, finally in production.

- Port `psy5/foundation/learning/learner.ts` (contextual bandit with abstention)
- "Should this scene trigger?" — the director can ABSTAIN (5 conditions) instead of always firing
- Grammar learning from live play (port `psy/foundation/grammar.mjs` with provenance)
- Never `Math.random` — always seeded, always deterministic, always replayable

**Exit criteria**: a user can let PSYBOSS drive a 30-minute generative set that's musically
coherent, deterministic from a seed, and the director demonstrably abstains when it should.

## Scope 6 — Platform

**Goal**: the marketplace and the community.

- Preset/sample marketplace (CC0 only, provenance-enforced)
- Artist profiles, shared projects, comment threads
- Embedded LLM assistant (backend, z-ai-web-dev-sdk) — "critique my mix", "suggest a variation"
- PWA (installable, offline) — port `psy3-clean/sw.js`
- Soak test harness (30–120 min, dropout detection) — the family has never had one

---

## What's next (after Scope 1)

**Scope 2** is the natural next step: turn the procedural demo into a real sampler with sample
loading, parameter locks, and offline render. That's where PSYBOSS becomes a product instead of
a proof. The user will send a message to continue; this `ROADMAP.md` is the contract.
