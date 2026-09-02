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
import type { LoadedSample, SampleMetadata } from './engine/sample-library'
import { sectionAtBar } from './engine/song-structure'
import {
  createPattern,
  toggleStep,
  setStepScene,
  setStepCondition,
  addParameterLock,
  setStepSample,
  type Pattern,
  type ParameterLock,
  STEPS_PER_BAR,
} from './engine/sequencer'
import type { TrigCondition } from './engine/lfsr'
import { PSY_PRESETS } from './engine/presets'
import { renderOffline } from './engine/offline-render'
import {
  MASTERING_PRESETS,
  type MasteringReport,
} from './engine/mastering'
import {
  createArrangement,
  addClip,
  removeClip,
  moveClip,
  arrangementLengthBars,
  findOverlaps,
  type Arrangement,
  type ArrangementClip,
} from './engine/arrangement'
import { renderArrangement } from './engine/offline-render'
import {
  analyzeReference,
  compareLoudness,
  type ReferenceAnalysis,
  type ABComparison,
} from './engine/reference'
import type { ConnectionStatus, WebRTCAdapter } from './adapters/webrtc-adapter'
import { downloadWav } from './engine/wav-encoder'

// ── Transport + UI state ──────────────────────────────────────────────────────
export interface PsyBossState {
  ready: boolean
  initError: string | null
  bpm: number
  masterFilterHz: number
  songMode: boolean
  currentSection: string
  beat: number
  bar: number
  phase: number
  playing: boolean
  lastFired: string | null
  patternEnabled: boolean
  rendering: boolean
  renderError: string | null
  lastRenderInfo: string | null
  samples: LoadedSample[]
  sampleError: string | null
  init: () => Promise<void>
  togglePlay: () => void
  setBpm: (bpm: number) => void
  setMasterFilter: (hz: number) => void
  toggleSongMode: () => void
  trig: (track: number, scene: number) => void
  setPatternEnabled: (on: boolean) => void
  masteringPreset: 'off' | 'club' | 'streaming'
  setMasteringPreset: (p: 'off' | 'club' | 'streaming') => void
  masteringReport: MasteringReport | null
  renderMaster: (bars: number) => Promise<void>
  renderStems: (bars: number) => Promise<void>
  loadSample: (file: File, metadata: SampleMetadata) => Promise<void>
  refreshSamples: () => void
  removeSample: (id: string) => void
  saveProject: (name: string) => Promise<void>
  loadProject: (id: string) => Promise<void>
  listProjects: () => Promise<void>
  projects: ProjectSummary[]
  persistenceError: string | null
}

// ── Meter state ───────────────────────────────────────────────────────────────
export interface MeterStore {
  rms: number
  peak: number
}

// ── Project summary (for list display) ───────────────────────────────────────
export interface ProjectSummary {
  id: string
  name: string
  bpm: number
  patternEnabled: boolean
  updatedAt: string
  _count: { steps: number; samples: number }
}

// ── Pattern state (step sequencer) ────────────────────────────────────────────
export interface PatternStore {
  pattern: Pattern
  selectedTrack: number
  toggleStep: (step: number) => void
  setStepScene: (step: number, scene: number) => void
  setStepCondition: (step: number, cond: TrigCondition) => void
  addLock: (step: number, lock: ParameterLock) => void
  setStepSample: (step: number, sampleRef: import('@/psybus/types').SampleRef | null) => void
  setSelectedTrack: (t: number) => void
  clearPattern: () => void
  loadPreset: (presetId: string) => void
}

const SEED = 0x9e3779b9
const NUM_TRACKS = 10

let engine: AudioEngine | null = null
let wired = false

export const usePsyBoss = create<PsyBossState>((set, get) => ({
  ready: false,
  initError: null,
  bpm: 144,
  masterFilterHz: 19000,
  songMode: false,
  currentSection: 'INTRO',
  beat: 0,
  bar: 0,
  phase: 0,
  playing: false,
  lastFired: null,
  patternEnabled: false,
  rendering: false,
  renderError: null,
  lastRenderInfo: null,
  masteringPreset: 'off',
  masteringReport: null,

  setMasteringPreset: (p) => set({ masteringPreset: p }),
  samples: [],
  sampleError: null,
  projects: [],
  persistenceError: null,

  init: async () => {
    if (get().ready) return
    try {
      engine = getEngine()
      if (!wired) {
        engine.onTransport((t: TransportState) => {
          const sectionName = get().songMode ? sectionAtBar(t.bar).section.name : get().currentSection
          set({ bpm: t.bpm, beat: t.beat, bar: t.bar, phase: t.phase, playing: t.playing, currentSection: sectionName })
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

  setMasterFilter: (hz: number) => {
    if (engine) engine.setMasterFilter(hz)
    set({ masterFilterHz: hz })
  },

  toggleSongMode: () => {
    const next = !get().songMode
    if (engine) engine.setSongMode(next)
    set({ songMode: next, currentSection: next ? sectionAtBar(get().bar).section.name : 'INTRO' })
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
      // ROAST-6 #4 fix: pass loaded samples map so steps with sampleRef render correctly.
      const lib = engine.getSampleLibrary()
      const samplesMap = new Map<string, AudioBuffer>()
      if (lib) {
        for (const s of lib.list()) {
          samplesMap.set(s.id, s.buffer)
        }
      }
      const preset = get().masteringPreset
      const mastering = preset === 'off' ? undefined : MASTERING_PRESETS[preset]
      const result = await renderOffline({
        pattern, seed: SEED, bpm: get().bpm, bars, samples: samplesMap, mastering,
      })
      const suffix = preset === 'off' ? '' : `-${preset}`
      downloadWav(result.master, `psyboss-master-${bars}bar${suffix}.wav`)
      // Scope 4: surface the mastering report in the UI.
      set({
        lastRenderInfo: `master: ${bars} bars, ${(result.durationSec).toFixed(1)}s, ${result.master.length} bytes`,
        rendering: false,
        masteringReport: result.masteringReport ?? null,
      })
    } catch (e) {
      set({ renderError: e instanceof Error ? e.message : String(e), rendering: false })
    }
  },

  renderStems: async (bars: number) => {
    if (!engine || get().rendering) return
    set({ rendering: true, renderError: null })
    try {
      const pattern = usePattern.getState().pattern
      // ROAST-6 #4 fix: pass loaded samples map.
      const lib = engine.getSampleLibrary()
      const samplesMap = new Map<string, AudioBuffer>()
      if (lib) {
        for (const s of lib.list()) {
          samplesMap.set(s.id, s.buffer)
        }
      }
      const result = await renderOffline({
        pattern, seed: SEED, bpm: get().bpm, bars, samples: samplesMap,
      })
      for (const [track, bytes] of result.stems) {
        downloadWav(bytes, `psyboss-stem-${track}-${bars}bar.wav`)
      }
      set({ lastRenderInfo: `stems: ${result.stems.size} tracks, ${bars} bars each`, rendering: false })
    } catch (e) {
      set({ renderError: e instanceof Error ? e.message : String(e), rendering: false })
    }
  },

  loadSample: async (file: File, metadata: SampleMetadata) => {
    if (!engine) return
    set({ sampleError: null })
    try {
      await engine.loadSample(file, metadata)
      set({ samples: engine.listSamples() })
    } catch (e) {
      set({ sampleError: e instanceof Error ? e.message : String(e) })
    }
  },

  refreshSamples: () => {
    if (!engine) return
    set({ samples: engine.listSamples() })
  },

  removeSample: (id: string) => {
    if (!engine) return
    const lib = engine.getSampleLibrary()
    if (lib) {
      lib.remove(id)
      set({ samples: engine.listSamples() })
    }
  },

  // ── SCOPE 5: Prisma/Turso persistence ──
  saveProject: async (name: string) => {
    set({ persistenceError: null })
    try {
      const pattern = usePattern.getState().pattern
      const steps: Array<{ track: number; step: number; active: boolean; scene: number; condition: string; locks: string }> = []
      for (let t = 0; t < pattern.tracks.length; t++) {
        for (let s = 0; s < pattern.tracks[t].length; s++) {
          const step = pattern.tracks[t][s]
          steps.push({
            track: t, step: s,
            active: step.active, scene: step.scene,
            condition: JSON.stringify(step.condition),
            locks: JSON.stringify(step.locks),
          })
        }
      }
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, bpm: get().bpm, patternEnabled: get().patternEnabled, steps }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Save failed')
      await get().listProjects()
    } catch (e) {
      set({ persistenceError: e instanceof Error ? e.message : String(e) })
    }
  },

  loadProject: async (id: string) => {
    set({ persistenceError: null })
    try {
      const res = await fetch(`/api/projects/${id}`)
      if (!res.ok) throw new Error('Load failed')
      const { project } = await res.json()
      // Restore BPM + pattern enabled
      get().setBpm(project.bpm)
      get().setPatternEnabled(project.patternEnabled)
      // Restore pattern steps (ROAST-6 #5 fix: use static imports, not dynamic)
      let pattern = createPattern(SEED, NUM_TRACKS)
      for (const s of project.steps) {
        if (s.active) {
          pattern = toggleStep(pattern, s.track, s.step)
        }
        pattern = setStepScene(pattern, s.track, s.step, s.scene)
        const cond = JSON.parse(s.condition)
        pattern = setStepCondition(pattern, s.track, s.step, cond)
      }
      usePattern.setState({ pattern })
      if (engine) engine.setPattern(get().patternEnabled ? pattern : null)
    } catch (e) {
      set({ persistenceError: e instanceof Error ? e.message : String(e) })
    }
  },

  listProjects: async () => {
    set({ persistenceError: null })
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) throw new Error('List failed')
      const { projects } = await res.json()
      set({ projects })
    } catch (e) {
      set({ persistenceError: e instanceof Error ? e.message : String(e) })
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

  setStepSample: (step: number, sampleRef: import('@/psybus/types').SampleRef | null) => {
    const { pattern, selectedTrack } = get()
    const next = setStepSample(pattern, selectedTrack, step, sampleRef)
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

  loadPreset: (presetId: string) => {
    const preset = PSY_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    const pattern = preset.build()
    set({ pattern, selectedTrack: 0 })
    // Presets carry their genre-appropriate tempo.
    usePsyBoss.setState({ bpm: preset.bpm })
    if (engine) {
      engine.setBpm(preset.bpm)
    }
    // BUG FIX (silent presets): this used to gate engine.setPattern on
    // patternEnabled, which defaults to false — so the engine never received the
    // preset and pressing Play was silent. Loading a preset means the user wants
    // to hear it, so enable pattern playback and push the pattern to the engine.
    // setPatternEnabled(true) reads the freshly-set pattern from usePattern.
    usePsyBoss.getState().setPatternEnabled(true)
    // Auto-play: clicking a preset should give immediate sound. Start transport
    // if not already playing (the preset click is a user gesture, so the audio
    // context is allowed to resume).
    if (engine && !usePsyBoss.getState().playing) {
      engine.play()
    }
  },
}))

export { STEPS_PER_BAR }



// ── Devices store (PSYBUS adapter management) ─────────────────────────────
export interface DeviceInfo {
  id: string
  name: string
  description: string
  status: 'disconnected' | 'connecting' | 'connected' | 'error' | 'unsupported' | 'coming-soon'
  error?: string
}

export interface DevicesStore {
  devices: DeviceInfo[]
  connect: (id: string) => Promise<void>
  disconnect: (id: string) => void
  isConnected: (id: string) => boolean
}

const INITIAL_DEVICES: DeviceInfo[] = [
  {
    id: 'psysynthpro',
    name: 'PsySynthPro',
    description: '16-voice DSP synthesizer (PolyBLEP + wavetable + FM)',
    status: 'disconnected',
  },
  {
    id: 'psydrum',
    name: 'psydrum',
    description: 'PsyDevice-conformant drum machine (voice pool + choke)',
    status: 'disconnected',
  },
  {
    id: 'psysynth',
    name: 'psysynth',
    description: 'Canonical subtractive synth (PolyBLEP + ZDF SVF + mod matrix)',
    status: 'disconnected',
  },
  {
    id: 'midi',
    name: 'Web MIDI',
    description: 'MIDI input/output + 24-ppq clock sync',
    status: 'disconnected',
  },
  {
    id: 'webrtc',
    name: 'WebRTC P2P',
    description: 'Multi-performer sync over the internet (NTP-style, jitter-buffered)',
    status: 'disconnected',
  },
]

export const useDevices = create<DevicesStore>((set, get) => ({
  devices: INITIAL_DEVICES,

  connect: async (id: string) => {
    set((state) => ({
      devices: state.devices.map((d) =>
        d.id === id ? { ...d, status: 'connecting' as const } : d
      ),
    }))

    try {
      // Dynamic import to avoid bundling adapters in the initial load
      if (id === 'psysynthpro') {
        const { createPsySynthProAdapter } = await import('./adapters/psy-synth-pro-adapter')
        const adapter = createPsySynthProAdapter(SEED)
        await adapter.init()
        set((state) => ({
          devices: state.devices.map((d) =>
            d.id === id ? { ...d, status: 'connected' as const } : d
          ),
        }))
      } else if (id === 'psydrum') {
        const { createPsyDrumAdapter } = await import('./adapters/psy-drum-adapter')
        const adapter = createPsyDrumAdapter(SEED)
        // psydrum needs AudioContext and outputNode from the engine
        const engine = getEngine()
        if (engine) {
          const ctx = (engine as any).ctx as BaseAudioContext
          const masterGain = (engine as any).masterGain as AudioNode
          if (ctx && masterGain) {
            await adapter.init(ctx, masterGain)
            set((state) => ({
              devices: state.devices.map((d) =>
                d.id === id ? { ...d, status: 'connected' as const } : d
              ),
            }))
          } else {
            throw new Error('AudioEngine not initialized. Boot PSYBOSS first.')
          }
        } else {
          throw new Error('AudioEngine not initialized. Boot PSYBOSS first.')
        }
      } else if (id === 'psysynth') {
        const { createPsySynthAdapter } = await import('./adapters/psy-synth-adapter')
        const adapter = createPsySynthAdapter(SEED)
        const engine = getEngine()
        if (engine) {
          const ctx = (engine as any).ctx as BaseAudioContext
          const masterGain = (engine as any).masterGain as AudioNode
          if (ctx && masterGain) {
            await adapter.init(ctx, masterGain)
            set((state) => ({
              devices: state.devices.map((d) =>
                d.id === id ? { ...d, status: 'connected' as const } : d
              ),
            }))
          } else {
            throw new Error('AudioEngine not initialized. Boot PSYBOSS first.')
          }
        } else {
          throw new Error('AudioEngine not initialized. Boot PSYBOSS first.')
        }
      } else if (id === 'midi') {
        const { createMidiAdapter } = await import('./adapters/midi-adapter')
        const adapter = createMidiAdapter({ seed: SEED })
        await adapter.init()
        set((state) => ({
          devices: state.devices.map((d) =>
            d.id === id ? { ...d, status: 'connected' as const } : d
          ),
        }))
      } else if (id === 'webrtc') {
        // WebRTC uses the dedicated signaling flow (hostSession/joinSession).
        // connect() just marks it as ready-to-configure.
        set((state) => ({
          devices: state.devices.map((d) =>
            d.id === id ? { ...d, status: 'disconnected' as const } : d
          ),
        }))
      }
    } catch (err) {
      set((state) => ({
        devices: state.devices.map((d) =>
          d.id === id
            ? { ...d, status: 'error' as const, error: err instanceof Error ? err.message : String(err) }
            : d
        ),
      }))
    }
  },

  disconnect: (id: string) => {
    set((state) => ({
      devices: state.devices.map((d) =>
        d.id === id ? { ...d, status: 'disconnected' as const, error: undefined } : d
      ),
    }))
  },

  isConnected: (id: string) => {
    return get().devices.find((d) => d.id === id)?.status === 'connected'
  },
}))


// ── WebRTC P2P store (Scope 3 final: multi-performer sync) ───────────────

export interface WebRTCStore {
  role: 'host' | 'guest' | null
  status: ConnectionStatus
  offer: string        // host: generated offer / guest: pasted offer
  answer: string       // guest: generated answer / host: pasted answer
  latencyMs: number
  error: string | null
  adapter: WebRTCAdapter | null

  setRole: (role: 'host' | 'guest') => void
  /** HOST: create the offer (returns it, also stored in state). */
  hostSession: () => Promise<string>
  /** HOST: accept the guest's pasted answer to complete the handshake. */
  acceptAnswer: (answer: string) => Promise<void>
  /** GUEST: accept the host's pasted offer, generate + return the answer. */
  joinSession: (offer: string) => Promise<string>
  disconnect: () => void
  reset: () => void
}

export const useWebRTC = create<WebRTCStore>((set, get) => ({
  role: null,
  status: 'idle',
  offer: '',
  answer: '',
  latencyMs: 0,
  error: null,
  adapter: null,

  setRole: (role) => set({ role, error: null }),

  hostSession: async () => {
    const { createWebRTCAdapter } = await import('./adapters/webrtc-adapter')
    const adapter = createWebRTCAdapter({ seed: SEED, role: 'host' })
    adapter.register()
    set({ adapter, role: 'host', error: null })

    adapter.onStatus((status) => {
      set({ status, latencyMs: adapter.getEstimatedLatencyMs() })
    })

    try {
      const offer = await adapter.createOffer()
      set({ offer, status: 'signaling' })
      return offer
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg, status: 'error' })
      throw err
    }
  },

  acceptAnswer: async (answer) => {
    const { adapter } = get()
    if (!adapter) {
      set({ error: 'No active host session. Create an offer first.' })
      return
    }
    try {
      await adapter.acceptAnswer(answer)
      set({ answer, error: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg, status: 'error' })
    }
  },

  joinSession: async (offer) => {
    const { createWebRTCAdapter } = await import('./adapters/webrtc-adapter')
    const adapter = createWebRTCAdapter({ seed: SEED, role: 'guest' })
    adapter.register()
    set({ adapter, role: 'guest', offer, error: null })

    adapter.onStatus((status) => {
      set({ status, latencyMs: adapter.getEstimatedLatencyMs() })
    })

    try {
      const answer = await adapter.acceptOffer(offer)
      set({ answer, status: 'signaling' })
      return answer
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg, status: 'error' })
      throw err
    }
  },

  disconnect: () => {
    const { adapter } = get()
    if (adapter) adapter.dispose()
    set({ adapter: null, status: 'disconnected' })
  },

  reset: () => {
    const { adapter } = get()
    if (adapter) adapter.dispose()
    set({
      adapter: null,
      role: null,
      status: 'idle',
      offer: '',
      answer: '',
      latencyMs: 0,
      error: null,
    })
  },
}))


// ── Arrangement store (Scope 4: linear timeline UI) ──────────────────────
export interface ArrangementStore {
  arrangement: Arrangement
  rendering: boolean
  renderError: string | null
  lastExportInfo: string | null
  masteringReport: MasteringReport | null

  addClip: (lengthBars: number, label?: string) => void
  removeClip: (clipId: string) => void
  moveClip: (clipId: string, newStartBar: number) => void
  setClipLabel: (clipId: string, label: string) => void
  clear: () => void
  exportArrangement: (preset: 'off' | 'club' | 'streaming') => Promise<void>
}

export const useArrangement = create<ArrangementStore>((set, get) => ({
  arrangement: createArrangement('Untitled Track', 144, SEED),
  rendering: false,
  renderError: null,
  lastExportInfo: null,
  masteringReport: null,

  addClip: (lengthBars, label) => {
    // Each clip references the CURRENT step-sequencer pattern. The arrangement
    // sequences that pattern over time (intro/build/drop/outro structure).
    const currentPattern = usePattern.getState().pattern
    const arr = get().arrangement
    const startBar = arrangementLengthBars(arr)
    const clip: ArrangementClip = {
      id: `clip-${startBar}-${arr.clips.length}-${Date.now().toString(36)}`,
      pattern: currentPattern,
      startBar,
      lengthBars,
      label: label ?? `Section ${arr.clips.length + 1}`,
    }
    set({ arrangement: addClip(arr, clip) })
  },

  removeClip: (clipId) => {
    set({ arrangement: removeClip(get().arrangement, clipId) })
  },

  moveClip: (clipId, newStartBar) => {
    set({ arrangement: moveClip(get().arrangement, clipId, newStartBar) })
  },

  setClipLabel: (clipId, label) => {
    set({
      arrangement: {
        ...get().arrangement,
        clips: get().arrangement.clips.map((c) =>
          c.id === clipId ? { ...c, label } : c
        ),
      },
    })
  },

  clear: () => {
    const arr = get().arrangement
    set({
      arrangement: createArrangement(arr.name, arr.bpm, arr.seed),
      lastExportInfo: null,
      masteringReport: null,
    })
  },

  exportArrangement: async (preset) => {
    const { arrangement } = get()
    if (arrangement.clips.length === 0) {
      set({ renderError: 'Arrangement is empty. Add clips first.' })
      return
    }
    const overlaps = findOverlaps(arrangement)
    if (overlaps.length > 0) {
      set({ renderError: `Clips overlap (${overlaps.length} pair(s)). Move them apart first.` })
      return
    }
    set({ rendering: true, renderError: null })
    try {
      const mastering = preset === 'off' ? undefined : MASTERING_PRESETS[preset]
      const result = await renderArrangement({ arrangement, mastering })
      const suffix = preset === 'off' ? '' : `-${preset}`
      downloadWav(result.master, `${arrangement.name.replace(/\s+/g, '-').toLowerCase() || 'psyboss-track'}${suffix}.wav`)
      set({
        rendering: false,
        lastExportInfo: `${result.clipCount} clips, ${result.durationSec.toFixed(1)}s, ${result.master.length} bytes`,
        masteringReport: result.masteringReport ?? null,
      })
    } catch (err) {
      set({
        rendering: false,
        renderError: err instanceof Error ? err.message : String(err),
      })
    }
  },
}))


// ── Reference A/B store (Scope 4: loudness-matched comparison) ───────────
export interface ReferenceStore {
  reference: ReferenceAnalysis | null
  comparison: ABComparison | null
  analyzing: boolean
  error: string | null

  loadReference: (file: File) => Promise<void>
  /** Compare the given master LUFS against the loaded reference. */
  compare: (myLufs: number) => void
  clear: () => void
}

export const useReference = create<ReferenceStore>((set, get) => ({
  reference: null,
  comparison: null,
  analyzing: false,
  error: null,

  loadReference: async (file) => {
    set({ analyzing: true, error: null })
    try {
      // A temporary context is fine for decoding; we don't play through it.
      const ctx = new AudioContext()
      const analysis = await analyzeReference(file, ctx)
      await ctx.close()
      set({ reference: analysis, analyzing: false })
    } catch (err) {
      set({
        analyzing: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  compare: (myLufs) => {
    const { reference } = get()
    if (!reference) {
      set({ error: 'Load a reference track first.' })
      return
    }
    set({ comparison: compareLoudness(myLufs, reference) })
  },

  clear: () => set({ reference: null, comparison: null, error: null }),
}))
