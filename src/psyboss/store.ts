/**
 * PSYBOSS UI stores — bridges the AudioEngine to React.
 *
 * Split into THREE stores:
 *   - usePsyBoss: transport + UI state (changes infrequently)
 *   - useMeter: RMS/peak (20×/sec)
 *   - usePattern: the step-sequencer pattern (changes on user edits)
 */

import { create } from 'zustand'
import {
  getEngine,
  type AudioEngine,
  type TransportState,
  type MeterState,
} from './engine/audio-engine'
import {
  createPattern,
  toggleStep,
  setStepScene,
  setStepCondition,
  addParameterLock,
  type Pattern,
  type ParameterLock,
  STEPS_PER_BAR,
} from './engine/sequencer'
import type { TrigCondition } from './engine/lfsr'
import { renderOffline } from './engine/offline-render'
import { downloadWav } from './engine/wav-encoder'

// ── Transport + UI state ──────────────────────────────────────────────────────
export interface PsyBossState {
  ready: boolean
  initError: string | null
  bpm: number
  beat: number
  bar: number
  phase: number
  playing: boolean
  lastFired: string | null
  patternEnabled: boolean
  rendering: boolean
  renderError: string | null
  lastRenderInfo: string | null
  init: () => Promise<void>
  togglePlay: () => void
  setBpm: (bpm: number) => void
  trig: (track: number, scene: number) => void
  setPatternEnabled: (on: boolean) => void
  renderMaster: (bars: number) => Promise<void>
  renderStems: (bars: number) => Promise<void>
}

// ── Meter state ───────────────────────────────────────────────────────────────
export interface MeterStore {
  rms: number
  peak: number
}

// ── Pattern state (step sequencer) ────────────────────────────────────────────
export interface PatternStore {
  pattern: Pattern
  selectedTrack: number
  toggleStep: (step: number) => void
  setStepScene: (step: number, scene: number) => void
  setStepCondition: (step: number, cond: TrigCondition) => void
  addLock: (step: number, lock: ParameterLock) => void
  setSelectedTrack: (t: number) => void
  clearPattern: () => void
}

const SEED = 0x9e3779b9
const NUM_TRACKS = 4

let engine: AudioEngine | null = null
let wired = false

export const usePsyBoss = create<PsyBossState>((set, get) => ({
  ready: false,
  initError: null,
  bpm: 144,
  beat: 0,
  bar: 0,
  phase: 0,
  playing: false,
  lastFired: null,
  patternEnabled: false,
  rendering: false,
  renderError: null,
  lastRenderInfo: null,

  init: async () => {
    if (get().ready) return
    try {
      engine = getEngine()
      if (!wired) {
        engine.onTransport((t: TransportState) => {
          set({ bpm: t.bpm, beat: t.beat, bar: t.bar, phase: t.phase, playing: t.playing })
        })
        engine.onMeter((m: MeterState) => {
          useMeter.setState({ rms: m.rms, peak: m.peak })
        })
        wired = true
      }
      await engine.init()
      // Push the current pattern to the engine so sequencer playback works.
      engine.setPattern(get().patternEnabled ? usePattern.getState().pattern : null)
      set({ ready: true })
    } catch (e) {
      set({ initError: e instanceof Error ? e.message : String(e) })
    }
  },

  togglePlay: () => {
    if (!engine) return
    if (get().playing) engine.stop()
    else engine.play()
  },

  setBpm: (bpm: number) => {
    const clamped = Math.max(120, Math.min(160, Math.round(bpm)))
    if (engine) engine.setBpm(clamped)
    set({ bpm: clamped })
  },

  trig: (track: number, scene: number) => {
    if (!engine) return
    engine.requestTrig(track, scene)
    set({ lastFired: `${track}:${scene}` })
    setTimeout(() => {
      if (get().lastFired === `${track}:${scene}`) set({ lastFired: null })
    }, 180)
  },

  setPatternEnabled: (on: boolean) => {
    set({ patternEnabled: on })
    if (engine) {
      engine.setPattern(on ? usePattern.getState().pattern : null)
    }
  },

  renderMaster: async (bars: number) => {
    if (!engine || get().rendering) return
    set({ rendering: true, renderError: null })
    try {
      const pattern = usePattern.getState().pattern
      const result = await renderOffline({
        pattern, seed: SEED, bpm: get().bpm, bars,
      })
      downloadWav(result.master, `psyboss-master-${bars}bar.wav`)
      set({ lastRenderInfo: `master: ${bars} bars, ${(result.durationSec).toFixed(1)}s, ${result.master.length} bytes`, rendering: false })
    } catch (e) {
      set({ renderError: e instanceof Error ? e.message : String(e), rendering: false })
    }
  },

  renderStems: async (bars: number) => {
    if (!engine || get().rendering) return
    set({ rendering: true, renderError: null })
    try {
      const pattern = usePattern.getState().pattern
      const result = await renderOffline({
        pattern, seed: SEED, bpm: get().bpm, bars,
      })
      for (const [track, bytes] of result.stems) {
        downloadWav(bytes, `psyboss-stem-${track}-${bars}bar.wav`)
      }
      set({ lastRenderInfo: `stems: ${result.stems.size} tracks, ${bars} bars each`, rendering: false })
    } catch (e) {
      set({ renderError: e instanceof Error ? e.message : String(e), rendering: false })
    }
  },
}))

export const useMeter = create<MeterStore>(() => ({ rms: -140, peak: -140 }))

export const usePattern = create<PatternStore>((set, get) => ({
  pattern: createPattern(SEED, NUM_TRACKS),
  selectedTrack: 0,

  toggleStep: (step: number) => {
    const { pattern, selectedTrack } = get()
    const next = toggleStep(pattern, selectedTrack, step)
    set({ pattern: next })
    if (engine && usePsyBoss.getState().patternEnabled) {
      engine.setPattern(next)
    }
  },

  setStepScene: (step: number, scene: number) => {
    const { pattern, selectedTrack } = get()
    const next = setStepScene(pattern, selectedTrack, step, scene)
    set({ pattern: next })
    if (engine && usePsyBoss.getState().patternEnabled) {
      engine.setPattern(next)
    }
  },

  setStepCondition: (step: number, cond: TrigCondition) => {
    const { pattern, selectedTrack } = get()
    const next = setStepCondition(pattern, selectedTrack, step, cond)
    set({ pattern: next })
    if (engine && usePsyBoss.getState().patternEnabled) {
      engine.setPattern(next)
    }
  },

  addLock: (step: number, lock: ParameterLock) => {
    const { pattern, selectedTrack } = get()
    const next = addParameterLock(pattern, selectedTrack, step, lock)
    set({ pattern: next })
    if (engine && usePsyBoss.getState().patternEnabled) {
      engine.setPattern(next)
    }
  },

  setSelectedTrack: (t: number) => set({ selectedTrack: t }),

  clearPattern: () => {
    const next = createPattern(SEED, NUM_TRACKS)
    set({ pattern: next })
    if (engine && usePsyBoss.getState().patternEnabled) {
      engine.setPattern(next)
    }
  },
}))

export { STEPS_PER_BAR }

