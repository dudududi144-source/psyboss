/**
 * PSYBOSS UI store — bridges the AudioEngine to React.
 *
 * The engine is the source of truth for audio. This store mirrors the slices
 * React needs to render (transport, meter, armed cells) and exposes actions
 * that delegate to the engine.
 */

import { create } from 'zustand'
import { getEngine, type AudioEngine, type TransportState, type MeterState } from './engine/audio-engine'

export interface PsyBossState {
  // engine lifecycle
  ready: boolean
  initError: string | null

  // transport
  bpm: number
  beat: number
  bar: number
  phase: number
  playing: boolean

  // meter (dBFS)
  rms: number
  peak: number

  // UI feedback: which cell last fired (transient highlight)
  lastFired: string | null // `${track}:${scene}`

  // actions
  init: () => Promise<void>
  togglePlay: () => void
  setBpm: (bpm: number) => void
  trig: (track: number, scene: number) => void
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
  rms: -140,
  peak: -140,
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
          set({ rms: m.rms, peak: m.peak })
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
    // clear the highlight after 180ms
    setTimeout(() => {
      if (get().lastFired === `${track}:${scene}`) set({ lastFired: null })
    }, 180)
  },
}))
