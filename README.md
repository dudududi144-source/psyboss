# PSYBOSS — The Performance Sampler & Conductor for the PSY Family

> **Browser-native Octatrack + Ableton Session View + the host that makes the PSY family play together.**
> No install. No samples without provenance. No `setInterval` in the audio path. No fake intelligence.

PSYBOSS is the **flagship** of the PSY family — a multi-track performance sampler with a scene matrix, per-step parameter locks, conditional trigs, a real AudioWorklet DSP core, a sample-accurate transport PLL, a provenance-enforced sample library, 24-ppq MIDI clock, and WebRTC P2P sync for collaborative live performance.

PSYBOSS is the **sample-manipulation instrument and performance conductor** — the only device that combines all of the above into one live rig, and the first device in the family that can host and orchestrate its siblings through the **PSYBUS** protocol.

## Live Demo

**[https://dudududi144-source.github.io/psyboss/](https://dudududi144-source.github.io/psyboss/)**

> The demo is a static build: AudioWorklet clock, scene matrix, step sequencer, meters, and offline WAV render all work. Project persistence (Prisma/Turso) is disabled in demo mode.

## PSYBUS Device Adapters (Scope 3)

PSYBOSS can now connect to external devices via PSYBUS:

| Adapter | Device | Status |
|---------|--------|--------|
| `PsySynthProAdapter` | 16-voice DSP synthesizer | Ready |
| `PsyDrumAdapter` | PsyDevice-conformant drum machine | Ready |
| `PsySynthAdapter` | Canonical subtractive synth (PolyBLEP + ZDF SVF) | Ready |
| `MidiAdapter` | Web MIDI input/output + 24-ppq clock | Ready |
| `WebRTCAdapter` | Multi-performer P2P sync (NTP-style, jitter-buffered) | Ready |

See `src/psyboss/adapters/` for the full implementation.
## Mastering (Scope 4)

Offline renders can be mastered to broadcast-standard loudness targets before export:

| Preset | Target | True-Peak Ceiling | Use case |
|--------|--------|-------------------|----------|
| **Club** | -8 LUFS | -0.1 dBTP | Beatport / DJ sets |
| **Streaming** | -14 LUFS | -1.0 dBTP | Spotify / YouTube |

The mastering chain implements ITU-R BS.1770-4:
- K-weighting filters (48kHz + 44.1kHz coefficient sets)
- Integrated LUFS with absolute (-70) + relative (-10 LU) gating
- 4x-oversampled true-peak detection (catches inter-sample peaks)
- Lookahead true-peak limiter (holds the OVERSAMPLED peak at the ceiling)
- Loudness normalization to target, with a before/after measurement report
- **A/B reference comparison**: upload a reference track, measure its LUFS, and see the
  loudness delta vs your master with the gain needed to match (loudness-matched A/B)

## Arrangement (Scope 4)

Sequence the current pattern into a full track structure via the **Arrange** tab:
- Add sections (Intro / Build / Drop / Break / Outro) of 4/8/16/32 bars
- Timeline visualization with per-clip labels
- Overlap detection (clips must not collide)
- Export the full arrangement as one mastered WAV (applies the selected mastering preset)


## Documents

| Doc | What it is |
|-----|------------|
| `docs/ROAST.md` | The brutal evidence-based roast of all 14 psy repos vs world leaders |
| `docs/ARCHITECTURE.md` | The PSYBOSS technical architecture (layers, data flow, DSP core) |
| `docs/PSYBUS.md` | The host/device + device/device protocol |
| `docs/ROADMAP.md` | Scoped delivery plan (Scope 1 to Scope N) |

## Run it

```bash
bun install
bun run dev    # http://localhost:3000
```

## Deploy (GitHub Pages)

The site is automatically deployed to GitHub Pages on every push to `main`.
Deployment is handled by `.github/workflows/deploy-pages.yml`.

## Stack

Next.js 16 (App Router), TypeScript 5, Tailwind 4, shadcn/ui, Prisma (Turso libSQL), Web Audio API + AudioWorklet, zustand (state), Vitest (tests), GitHub Actions (CI/CD).

## License

MIT. No commercial samples. No license bombs. Provenance or nothing.
