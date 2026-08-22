/**
 * PSYBOSS UI stores — bridges the AudioEngine to React.
 *
 * Split into TWO stores (ROAST-1 §6 fix): the meter fires ~20×/sec and was causing
 * the entire app (including the scene matrix) to re-render 20×/sec. Now meter
 * subscribers select from `useMeter` and transport/UI subscribers select from
 * `usePsyBoss`. Cells that don't depend on meter no longer re-render on meter posts.
 */

import { create } from 'zustand'
import {
  getEngine,
  type AudioEngine,
  type TransportState,
  type MeterState,
} from './engine/audio-engine'

// ── Transport + UI state (changes infrequently: play/stop/bpm/trig) ──────────
export interface PsyBossState {
  ready: boolean
  initError: string | null
  bpm: number
  beat: number
  bar: number
  phase: number
  playing: boolean
  lastFired: string | null
  init: () => Promise<void>
  togglePlay: () => void
  setBpm: (bpm: number) => void
  trig: (track: number, scene: number) => void
}

// ── Meter state (changes ~20×/sec during playback) — separate store ──────────
export interface MeterStore {
  rms: number
  peak: number
}

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

  init: async () => {
    if (get().ready) return
    try {
      engine = getEngine()
      if (!wired) {
        engine.onTransport((t: TransportState) => {
          set({
            bpm: t.bpm,
            beat: t.beat,
            bar: t.bar,
            phase: t.phase,
            playing: t.playing,
          })
        })
        engine.onMeter((m: MeterState) => {
          // Direct write to the meter store — does NOT re-render PsyBossState subscribers.
          useMeter.setState({ rms: m.rms, peak: m.peak })
        })
        wired = true
      }
      await engine.init()
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
}))

export const useMeter = create<MeterStore>(() => ({ rms: -140, peak: -140 }))
