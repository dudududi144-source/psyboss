# ROAST — The PSY Family vs World Leaders

> Evidence-based. Every claim cites a file. Audits ran across all 14 `psy*` repos
> (cloned to `/tmp/psy-audit/`). The method mirrors the family's own `CROSS_REPO_AUDIT.md`:
> names are not trusted, wiring is verified by reading code. This is the evidence half
> of `ARCHITECTURE.md`.

## 0. The one-line verdict

The PSY family writes better architecture documents than products. 13 repos, 4 copies of
the foundation, 142 unlicensed commercial samples in one of them, `setInterval(25)` in
every flagship audio path, and **zero** scene matrix / parameter locks / modulation matrix
anywhere. The family audits itself more than it ships. PSYBOSS exists to stop that and build
the one device the family is missing and the market has no browser equivalent for.

---

## 1. Per-repo verdicts (one line each)

| repo | verdict |
|------|---------|
| `psy` | Beautiful foundation, runtime still 2015. Own ROAST is 60% stale — most of `PSY_WINNING_DEVICE.md` got executed, but audio path is still `OscillatorNode+BiquadFilter` and the PLL is fed a hardcoded `confidence:0.85`. |
| `psy3-clean` | Most honest repo. Zero tests, zero worklet, zero PolyBLEP — and the only one that admits it in the README. |
| `psy5` | **Technical peak of the family.** Real worklet DSP (PolyBLEP + Moog, 485 lines), real Worker timer, real `TransportClock` + `BeatEstimator` + `PhaseCorrector` + `ConfidenceTracker`, 314 expects. Should have been the foundation. |
| `PSY6-ULTIMATE` | Marketing-grade self-verification. "PRODUCTION-READY ✓" ×5 in README. **Zero tests.** `Date.now()` seed destroys determinism (`index.html:394`). Grammar system is real; the rest is `OscillatorNode+BiquadFilter` on `setInterval(25)`. |
| `psystar` | Most professionally *engineered* (TypeScript, 953 expects, real WebRTC `RTCPeerConnection`, real 24-ppq MIDI clock). Discipline > DSP — still `setInterval` + `OscillatorNode` in the audio path. |
| `psy4` | Research lab with broken BPM detection (mathematically forced to ~60 BPM per the user's own `PSY4_CLAIMS_VS_REALITY_ROAST.md`) and non-convergent learning. 245 MB mostly bloat. |
| `psy4new` | Research graveyard with a **license bomb**: 142 commercial Roland TR-909 / Elektron Machinedrum / Clavia Nord Drum sample rips physically in `public/samples/real/` despite a manifest that says "QUARANTINED — DO NOT LOAD". Plus ~100 MB of unrelated ClawHub skills. |
| `psy-foundation` | Canonical monorepo. Real `PsyDevice` contract (13 lines of TS) + `DeviceHost` + `Channel`. But the channel is **in-memory pub/sub only** — no cross-tab, no Worker, no IPC. Devices push TO host; host never publishes back. Devices can't talk to each other. |
| `PsySynthPro` | Strongest DSP (mip-mapped wavetable + 6-op FM + ZDF SVF + Moog ladder in a real worklet). But **not a PsyDevice** — refuses to register with a host. README claims 16 voices, code allocates **6**. 3 `setInterval` schedulers. A beautiful instrument that won't talk to its siblings. |
| `psysynth` | Best voice pool (`SynthVoicePool`, deterministic steal, O(1) note lookup). But audio path uses `PeriodicWave` not PolyBLEP (the worklet is dead code), mod matrix is types-only, filter is fake Moog. |
| `psydrum` | Real ACB drum engines (kick/snare/hat/cymbal + Chamberlin SVF), strong contract conformance. Demo transport is `setInterval`. ACB opt-in off by default. |
| `psy-sampler` | Most production-ready device. 51 test files, real Worker scheduler, real provenance gate — with one hole: `library.addFromBuffer` doesn't call `validateProvenance`, so drag-drop bypasses the gate. |
| `psysampler` | Empty. |
| `psyboss` | (This repo. Scope 1 in progress.) |

---

## 2. The 5 biggest gaps vs world-leading devices

1. **No real-time sample-accurate DSP in the flagship grooveboxes.**
   Ableton/Bitwig/Elektron/FL use native compiled DSP (SIMD, sample-accurate, zero main-thread).
   The family flagship (PSY6-ULTIMATE) uses `OscillatorNode+BiquadFilter+WaveShaper` on
   `setInterval(25)`. The worklet DSP exists in `PsySynthPro` (synth-only) and `psy5` (not the
   flagship). **No groovebox ships with a real PolyBLEP/ZDF/FM worklet in the live path.**

2. **No real radio PLL in production.** `psy5` has a real `TransportClock` PLL but it's only
   fed synthetic A–J streams in tests. `psy4` attempted radio-following but BPM detection is
   mathematically forced to ~60 BPM. Ableton Link does real network tempo sync; Elektron does
   real MIDI clock with jitter compensation; Traktor does real-time beat-sync to external audio.
   **No PSY device tracks an external stream's tempo in production.**

3. **No clip/scene launcher (Ableton Session View).** psystar's "scenes" and PSY6-ULTIMATE's
   "sections" are **linear chains** (play one, then the next). Ableton's Session View is a
   **matrix** of independent clips per track × scene. Elektron Octatrack has the same pattern.
   **No PSY device has a true clip matrix.**

4. **No modulation matrix.** Bitwig's Grid, FL's Patcher, VCV Rack, Output Portal — all let you
   route any source (LFO/envelope/MIDI CC/audio follower) to any destination. `PsySynthPro` has
   a basic 6×5 matrix. **The grooveboxes have zero.** Every routing is hardcoded at construction.

5. **No proper sample management with provenance.** Octatrack has sample slots with metadata +
   provenance; Ableton's browser has preview + key/tempo detection. The family: `psy4new` ships
   142 commercial rips with a "QUARANTINED" manifest that provides zero legal protection;
   `psy`'s `soundBank.js` loads whatever URLs it's given. **The flagship grooveboxes cannot
   safely ship with samples.**

---

## 3. The waste (duplication across repos)

| what | copies | where |
|------|--------|-------|
| Foundation modules | **4** | `psy/foundation/*.mjs`, `psy5/foundation/*.ts`, `psy4new/foundation/*.ts`, `psy-foundation/packages/*` |
| Foundation-shim adapter | **4** | `psysynth/`, `psydrum/`, `psy4/`, `psy4new/` — all `src/lib/psy-foundation-shim/` |
| PooledEngine | **3** | PSY6-ULTIMATE inline, `psy5/playground`, `psy4new/src/lib/pooledEngine.ts` |
| Grammar learner | **4** | PSY6-ULTIMATE (naïve, Math.random), `psy/foundation/grammar.mjs`, `psy4/psyLive4/grammar-learner.ts`, `psy4new/foundation/music/LearnedGrammar.ts` |
| MIDI clock | **3** | `psystar/src/engine/midi-clock.ts` (cleanest), PSY6-ULTIMATE inline, psy4 own |
| `Math.tanh` drive curve | **6** | every repo reimplements the same 5 lines |
| Step sequencer + swing | **every** | no shared module |

The family pays triple-to-quadruple maintenance to enforce parity by tests, instead of sharing code.

---

## 4. The license bomb

`psy4new/public/samples/real/` contains 142 commercial hardware sample rips (21 MB):
`909_BD_*.wav` (Roland TR-909), `md_*` (Elektron Machinedrum), `nord_*` (Clavia Nord Drum).
`manifest.json` says `"quarantineStatus":"QUARANTINED"` and `"samples":[]` — but the `.wav`
files are physically present. A manifest that says "do not load" provides **zero** legal
protection when you redistribute the files. This is the kind of thing that kills commercial
products (cf. Native Instruments' 2013 sample-license audit; Ableton's strict provenance).

**PSYBOSS rule: provenance or nothing. No file loads without license metadata. No exceptions.**

---

## 5. The integration failure

The `PsyDevice` contract (`psy-foundation/packages/device-sdk/src/device.ts`, 13 lines of TS)
is a pure HOW-layer interface: `id`, `capabilities()`, `onTransport`, `onContext`, `onEvent`,
`onStart?`, `onStop?`, `reportLatencyMs?`. Routed via `DeviceHost` + `Channel`.

**The contract is one-way push only.** Host pushes transport/context/events TO devices.
Devices never publish events back. There is no device-to-device channel. So:

- A kick device cannot tell a bass device to duck (no sidechain coordination).
- A drum device cannot tell a sampler device to choke (no mute groups).
- Two devices cannot sync their internal clocks (each trusts the host's transport, but can't negotiate).

Every device carries a **verbatim byte-equivalent shim** of the contract pinned to foundation
commit `4ae95d3` instead of depending on the package. So even the contract is duplicated.

**PSYBOSS fixes this with PSYBUS** (see `docs/PSYBUS.md`) — a bidirectional, typed protocol
where devices can `publish` events and the host can route them. PSYBOSS is the first device
that can both host siblings and talk back.

---

## 6. What this roast is NOT

This is not hate. `psy5`'s worklet DSP is genuinely good. `psy-sampler`'s provenance gate is
the right idea (with one hole to fix). `psystar`'s engineering discipline (TypeScript, 953
expects, real WebRTC) is the standard the family should meet. `psy`'s foundation is pure,
deterministic, with replay identity. The architecture documents are correct in every particular.

The problem is **execution gap and integration failure**, not vision gap. PSYBOSS does not
redesign — it **delivers** the design the family already wrote, picks the best implementation
of each capability, consolidates onto one foundation, and adds the two things nobody built:
a real sampler flagship and a real device bus.

---

## 7. PSYBOSS vs the world

| capability | Octatrack MkII | Ableton Session View | Digitakt 2 | **PSYBOSS** |
|---|---|---|---|---|
| Runs in browser | ❌ | ❌ | ❌ | ✅ |
| Zero install | ❌ | ❌ | ❌ | ✅ |
| Scene matrix (tracks × scenes) | ✅ | ✅ | ⚠️ rows | ✅ |
| Per-step parameter locks | ✅ | ⚠️ (clip automation) | ✅ | ✅ (Scope 2) |
| Conditional trigs | ✅ | ❌ | ✅ | ✅ (Scope 2) |
| Real AudioWorklet DSP | n/a (HW) | n/a | n/a | ✅ |
| Sample-accurate transport PLL | ✅ (HW) | ✅ | ✅ | ✅ |
| Provenance-enforced samples | ❌ | ❌ | ❌ | ✅ |
| MIDI clock in/out (24-ppq) | ✅ | ✅ | ✅ | ✅ (Scope 2) |
| WebRTC P2P sync | ❌ | ⚠️ (Link) | ❌ | ✅ (Scope 3) |
| Collaborative live perf | ❌ | ⚠️ | ❌ | ✅ (Scope 3) |
| Deterministic replay identity | ❌ | ❌ | ❌ | ✅ |
| Hosts sibling devices | ❌ | ✅ (tracks) | ❌ | ✅ (PSYBUS) |
| Price | $1,349 | $749+ | $999 | **free (MIT)** |

**No world-leading sampler runs in a browser. No browser DAW is a hardware-style performance
sampler. PSYBOSS is the only device that combines a scene matrix, parameter locks, real worklet
DSP, provenance, P2P sync, and the ability to host sibling devices — in a browser, for free.**
