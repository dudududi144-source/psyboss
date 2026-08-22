# PSYBOSS — The Performance Sampler & Conductor for the PSY Family

> **Browser-native Octatrack + Ableton Session View + the host that makes the PSY family play together.**
> No install. No samples without provenance. No `setInterval` in the audio path. No fake intelligence.

PSYBOSS is the **missing flagship** of the PSY family — a multi-track performance
sampler with a scene matrix, per-step parameter locks, conditional trigs, a real
AudioWorklet DSP core, a sample-accurate transport PLL, a provenance-enforced sample
library, 24-ppq MIDI clock, and WebRTC P2P sync for collaborative live performance.

It is **not** a synth (that's [`PsySynthPro`](https://github.com/dudududi144-source/PsySynthPro)),
**not** a drum machine (that's [`psydrum`](https://github.com/dudududi144-source/psydrum)),
**not** a generative groovebox (that's [`PSY6-ULTIMATE`](https://github.com/dudududi144-source/PSY6-ULTIMATE)),
and **not** a radio follower (that's [`psy4`](https://github.com/dudududi144-source/psy4)).
PSYBOSS is the **sample-manipulation instrument and performance conductor** — the only
device that combines all of the above into one live rig, and the first device in the
family that can host and orchestrate its siblings through the **PSYBUS** protocol.

## Why this exists

The PSY family is 13 repos that each built one wall of a house, separately. The audits
(see `docs/ROAST.md`) found: 4 copies of the foundation, 3 of the pooled engine, 4 of the
grammar learner, a 142-sample license bomb in `psy4new`, `setInterval(25)` schedulers in
every flagship, and **zero** clip-matrix / parameter-lock / modulation-matrix in any of
them. Meanwhile, no world-leading sampler runs in a browser — the Octatrack, Digitakt,
MPC, and Deluge are all hardware.

PSYBOSS closes that gap with engineering discipline the family has never had:

- **One** clock — a sample-accurate AudioWorklet transport. No `setInterval` in the live path.
- **One** bus — PSYBUS, a typed bidirectional protocol so devices can finally talk (sidechain, choke, sync).
- **One** sample library — provenance-enforced. Refuses to load anything without license metadata.
- **One** replay identity — every performance is deterministic from a seed.

## The vertical slice (Scope 1)

This repo ships Scope 1: the **foundation + proving slice**.

- A real `AudioWorklet` master clock (BPM, play/stop, bar-quantized launch).
- A 4-track × 4-scene matrix — click a cell, it triggers a procedural psytrance sound at the next bar.
- A master bus with real RMS/peak metering computed in the worklet.
- A DAW-style shell UI on `/` (transport bar, scene grid, meters, sticky status footer).
- The PSYBUS protocol types + an in-process host that will route to sibling devices in Scope 2.

Procedural sound generation (no samples) is intentional: it proves the DSP is real and
sidesteps the licensing hole that poisoned `psy4new`. Sample loading with provenance
gating lands in Scope 2.

## Documents

| Doc | What it is |
|-----|-----------|
| `docs/ROAST.md` | The brutal evidence-based roast of all 14 psy repos vs world leaders |
| `docs/ARCHITECTURE.md` | The PSYBOSS technical architecture (layers, data flow, DSP core) |
| `docs/PSYBUS.md` | The host/device + device/device protocol that fixes the family's silence |
| `docs/ROADMAP.md` | Scoped delivery plan (Scope 1 → Scope N) |

## Run it

```bash
bun install
bun run dev    # http://localhost:3000 (the only user route)
```

## Stack

Next.js 16 (App Router) · TypeScript 5 · Tailwind 4 · shadcn/ui · Prisma (Turso libSQL) ·
Web Audio API + AudioWorklet · z-ai-web-dev-sdk (backend only).

## License

MIT. No commercial samples. No license bombs. Provenance or nothing.
