'use client'

import { useEffect, useState, useCallback, memo } from 'react'
import { usePsyBoss, useMeter, usePattern, useDevices, STEPS_PER_BAR } from '@/psyboss/store'
import { TRACK_NAMES, SCENE_COUNT } from '@/psyboss/engine/dsp'
import type { TrigCondition } from '@/psyboss/engine/lfsr'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Card } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Play, Square, Zap, ShieldCheck, Activity, Radio, Keyboard, Download, Music2, FileAudio, Eraser, Upload, Trash2, Library, FolderOpen, Save, Database, Cable } from 'lucide-react'

const TRACKS = TRACK_NAMES as readonly string[]
const SCENES = SCENE_COUNT

function dbToPct(db: number): number {
  const clamped = Math.max(-60, Math.min(0, db))
  return ((clamped + 60) / 60) * 100
}

// MeterBar subscribes DIRECTLY to the meter store via selector (ROAST-2 #4 fix:
// was receiving db as a prop from Home, which re-rendered 20/sec from meter posts
// and dragged the whole scene matrix with it). Now only MeterBar re-renders.
function MeterBar({ label, accent }: { label: string; accent: string }) {
  const db = useMeter(label === 'PK' ? (s) => s.peak : (s) => s.rms)
  const pct = dbToPct(db)
  return (
    <div className="flex items-center gap-2 min-w-[100px] md:min-w-[120px]">
      <span className="text-[10px] font-mono text-muted-foreground w-6">{label}</span>
      <div className="relative flex-1 h-2 md:h-2.5 rounded-full bg-black/60 overflow-hidden border border-border/50">
        <div
          className={`absolute inset-y-0 left-0 ${accent} transition-[width] duration-75`}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-y-0 left-[98.3%] w-px bg-red-500/70" title="Limiter -1 dBFS" />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-10 text-right tabular-nums">
        {db <= -139 ? '−∞' : db.toFixed(1)}
      </span>
    </div>
  )
}

// memo'd so it only re-renders when its own props change (ROAST-2 #4 fix).
// ROAST-3 fix: onTrig is now a stable callback (handleTrig via useCallback);
// previously a new arrow `() => handleTrig(track, scene)` was created per cell
// per render, defeating React.memo. Now SceneCell receives track+scene+handleTrig
// as separate stable props and calls handleTrig(track, scene) internally.
const SceneCell = memo(function SceneCell({
  track,
  scene,
  armed,
  onTrig,
}: {
  track: number
  scene: number
  armed: boolean
  onTrig: (track: number, scene: number) => void
}) {
  const trackColor = [
    'from-emerald-500/30 to-emerald-700/20 border-emerald-500/40',
    'from-amber-500/30 to-amber-700/20 border-amber-500/40',
    'from-cyan-500/30 to-cyan-700/20 border-cyan-500/40',
    'from-fuchsia-500/30 to-fuchsia-700/20 border-fuchsia-500/40',
  ][track % 4]

  return (
    <button
      onClick={() => onTrig(track, scene)}
      aria-label={`Trigger ${TRACKS[track]} scene ${scene + 1}`}
      className={`
        relative aspect-square rounded-lg border bg-gradient-to-br ${trackColor}
        flex items-center justify-center
        transition-all duration-150
        hover:scale-[1.04] hover:brightness-125 active:scale-95
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400
        ${armed ? 'brightness-150 ring-2 ring-emerald-400 shadow-[0_0_20px_rgba(16,185,129,0.6)]' : ''}
      `}
    >
      <span className="text-[10px] font-mono font-bold text-foreground/70">
        {scene + 1}
      </span>
      {armed && (
        <span className="absolute inset-0 rounded-lg ring-2 ring-emerald-300 animate-ping opacity-40" />
      )}
    </button>
  )
})

// ── Step Sequencer component (Scope 3) ───────────────────────────────────────
function StepSequencer() {
  const pattern = usePattern((s) => s.pattern)
  const selectedTrack = usePattern((s) => s.selectedTrack)
  const toggleStep = usePattern((s) => s.toggleStep)
  const setStepScene = usePattern((s) => s.setStepScene)
  const setStepCondition = usePattern((s) => s.setStepCondition)
  const setStepSample = usePattern((s) => s.setStepSample)
  const setSelectedTrack = usePattern((s) => s.setSelectedTrack)
  const clearPattern = usePattern((s) => s.clearPattern)
  const patternEnabled = usePsyBoss((s) => s.patternEnabled)
  const setPatternEnabled = usePsyBoss((s) => s.setPatternEnabled)
  const samples = usePsyBoss((s) => s.samples) // ROAST-5 #B: for sample-assign UI
  const beat = usePsyBoss((s) => s.beat)

  const currentStep = Math.floor(beat * 4) % STEPS_PER_BAR // 16th position

  return (
    <Card className="border-border/60 bg-card/40 p-3 md:p-4">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-muted-foreground">
            Step Sequencer
          </h3>
          <p className="text-[11px] text-muted-foreground/70 mt-0.5">
            16 steps per bar · per-step locks + conditions · LFSR-seeded (deterministic)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-[10px] gap-1">
            <span className={patternEnabled ? 'text-emerald-400' : 'text-muted-foreground'}>
              {patternEnabled ? '● LIVE' : '○ OFF'}
            </span>
          </Badge>
          <Switch checked={patternEnabled} onCheckedChange={setPatternEnabled} aria-label="Enable pattern playback" />
          <Button size="sm" variant="ghost" onClick={clearPattern} className="h-7 px-2 text-[10px] font-mono">
            <Eraser className="w-3 h-3 mr-1" />
            Clear
          </Button>
        </div>
      </div>

      {/* Track selector */}
      <div className="flex gap-1 mb-3 flex-wrap">
        {TRACKS.map((name, t) => (
          <button
            key={t}
            onClick={() => setSelectedTrack(t)}
            className={`px-3 py-1 rounded-md font-mono text-xs font-bold transition-colors ${
              selectedTrack === t
                ? 'bg-emerald-500 text-black'
                : 'bg-foreground/5 hover:bg-foreground/10 text-foreground/70'
            }`}
          >
            {name}
          </button>
        ))}
      </div>

      {/* Step grid */}
      <div className="overflow-x-auto">
        <div className="min-w-[600px]">
          {/* Step numbers */}
          <div className="grid grid-cols-16 gap-1 mb-1" style={{ gridTemplateColumns: 'repeat(16, 1fr)' }}>
            {Array.from({ length: STEPS_PER_BAR }, (_, i) => (
              <div
                key={i}
                className={`text-center text-[9px] font-mono ${
                  currentStep === i && patternEnabled
                    ? 'text-emerald-400 font-bold'
                    : i % 4 === 0
                    ? 'text-muted-foreground'
                    : 'text-muted-foreground/40'
                }`}
              >
                {i + 1}
              </div>
            ))}
          </div>
          {/* Steps */}
          <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(16, 1fr)' }}>
            {pattern.tracks[selectedTrack]?.map((step, i) => (
              <button
                key={i}
                onClick={(e) => {
                  // Shift+click: cycle through loaded samples (ROAST-5 #B fix).
                  if (e.shiftKey && samples.length > 0) {
                    e.preventDefault()
                    const currentIdx = step.sampleRef
                      ? samples.findIndex((s) => s.id === step.sampleRef!.id)
                      : -1
                    // -1 (no sample) → 0 → 1 → ... → -1 (clear)
                    const nextIdx = currentIdx + 1
                    if (nextIdx >= samples.length) {
                      setStepSample(i, null) // clear → back to procedural
                    } else {
                      const samp = samples[nextIdx]
                      setStepSample(i, { id: samp.id, provenance: samp.provenance })
                    }
                    if (!step.active) toggleStep(i) // auto-activate on assign
                    return
                  }
                  toggleStep(i)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  // Right-click: cycle condition
                  const conds: TrigCondition[] = [
                    { kind: 'always' },
                    { kind: 'probability', p: 0.5 },
                    { kind: 'probability', p: 0.25 },
                    { kind: 'fill', everyBars: 4 },
                    { kind: 'not-fill', everyBars: 4 },
                  ]
                  const next = conds[(conds.findIndex((c) => JSON.stringify(c) === JSON.stringify(step.condition)) + 1) % conds.length]
                  setStepCondition(i, next)
                }}
                aria-label={`Step ${i + 1}`}
                className={`
                  relative aspect-square rounded border transition-all
                  ${step.active
                    ? step.sampleRef
                      ? 'bg-gradient-to-br from-cyan-500/40 to-cyan-700/30 border-cyan-500/60'
                      : 'bg-gradient-to-br from-emerald-500/40 to-emerald-700/30 border-emerald-500/60'
                    : 'bg-foreground/5 border-border/40 hover:border-border/80'
                  }
                  ${currentStep === i && patternEnabled ? 'ring-2 ring-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : ''}
                  ${i % 4 === 0 ? 'border-l-2 border-l-emerald-500/30' : ''}
                `}
                title={`Step ${i + 1} · ${step.condition.kind} · scene ${step.scene + 1}${step.locks.length ? ` · ${step.locks.length} locks` : ''}${step.sampleRef ? ` · sample: ${samples.find((s) => s.id === step.sampleRef!.id)?.name ?? '?'}` : ''}`}
              >
                {step.active && (
                  <span className="text-[8px] font-mono font-bold text-foreground/60 absolute inset-0 flex items-center justify-center">
                    {step.sampleRef ? '♪' : step.scene + 1}
                  </span>
                )}
                {step.condition.kind !== 'always' && step.active && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400" title={step.condition.kind} />
                )}
                {step.locks.length > 0 && (
                  <span className="absolute -bottom-1 -left-1 w-2 h-2 rounded-full bg-fuchsia-400" title={`${step.locks.length} param locks`} />
                )}
              </button>
            ))}
          </div>
          <div className="mt-2 text-[10px] font-mono text-muted-foreground/60">
            Left-click: toggle · Right-click: cycle condition · Shift+click: assign sample ({samples.length} loaded)
          </div>
        </div>
      </div>
    </Card>
  )
}

// ── Render & Export panel (Scope 3) ──────────────────────────────────────────
function RenderPanel() {
  const rendering = usePsyBoss((s) => s.rendering)
  const renderError = usePsyBoss((s) => s.renderError)
  const lastRenderInfo = usePsyBoss((s) => s.lastRenderInfo)
  const renderMaster = usePsyBoss((s) => s.renderMaster)
  const renderStems = usePsyBoss((s) => s.renderStems)
  const bpm = usePsyBoss((s) => s.bpm)
  const patternEnabled = usePsyBoss((s) => s.patternEnabled)

  return (
    <Card className="border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileAudio className="w-4 h-4 text-emerald-400" />
        <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Offline Render
        </h3>
      </div>
      <p className="text-[11px] text-muted-foreground/70 mb-3">
        Renders the current pattern to 16-bit WAV via <span className="font-mono text-emerald-400">OfflineAudioContext</span>.
        Deterministic: same seed → byte-identical output. Master = all tracks mixed; Stems = per-track.
      </p>

      {!patternEnabled && (
        <div className="mb-3 p-2 rounded-md border border-amber-500/30 bg-amber-500/5 text-amber-400 text-[11px] font-mono">
          ⚠ Pattern playback is OFF — enable it in the Step Sequencer tab to render the pattern.
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 mb-3">
        <Button
          onClick={() => renderMaster(4)}
          disabled={rendering}
          className="bg-emerald-500 hover:bg-emerald-400 text-black font-mono"
        >
          <Download className="w-3.5 h-3.5 mr-1.5" />
          Master · 4 bars
        </Button>
        <Button
          onClick={() => renderMaster(8)}
          disabled={rendering}
          variant="outline"
          className="font-mono"
        >
          <Download className="w-3.5 h-3.5 mr-1.5" />
          Master · 8 bars
        </Button>
        <Button
          onClick={() => renderStems(4)}
          disabled={rendering}
          variant="outline"
          className="font-mono"
        >
          <Download className="w-3.5 h-3.5 mr-1.5" />
          Stems · 4 bars
        </Button>
        <Button
          onClick={() => renderStems(8)}
          disabled={rendering}
          variant="outline"
          className="font-mono"
        >
          <Download className="w-3.5 h-3.5 mr-1.5" />
          Stems · 8 bars
        </Button>
      </div>

      {rendering && (
        <div className="text-[11px] font-mono text-emerald-400 animate-pulse">
          Rendering... (offline, no real-time wait)
        </div>
      )}
      {renderError && (
        <div className="text-[11px] font-mono text-destructive">
          Error: {renderError}
        </div>
      )}
      {lastRenderInfo && !rendering && (
        <div className="text-[11px] font-mono text-muted-foreground">
          ✓ {lastRenderInfo} · @ {bpm} BPM
        </div>
      )}
    </Card>
  )
}

// ── Sample panel component (Scope 4) ─────────────────────────────────────────
function SamplePanel() {
  const samples = usePsyBoss((s) => s.samples)
  const sampleError = usePsyBoss((s) => s.sampleError)
  const loadSample = usePsyBoss((s) => s.loadSample)
  const removeSample = usePsyBoss((s) => s.removeSample)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [license, setLicense] = useState<string>('CC0')
  const [source, setSource] = useState<string>('')
  const [author, setAuthor] = useState<string>('')

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) setSelectedFile(f)
  }

  const handleLoad = async () => {
    if (!selectedFile || !source.trim()) return
    await loadSample(selectedFile, {
      name: selectedFile.name,
      license: license as 'CC0' | 'CC-BY' | 'CC-BY-SA' | 'CC-BY-NC' | 'commercial-licensed',
      source: source.trim(),
      author: author.trim() || undefined,
    })
    setSelectedFile(null)
    setSource('')
    setAuthor('')
  }

  return (
    <Card className="border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Library className="w-4 h-4 text-emerald-400" />
        <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Sample Library
        </h3>
      </div>
      <p className="text-[11px] text-muted-foreground/70 mb-3">
        Load your own samples. Every sample MUST carry a <span className="font-mono text-emerald-400">Provenance</span> record
        with a SHA-256 fingerprint. The PSYBUS gate rejects anything without valid provenance.
      </p>

      {/* Load form */}
      <div className="space-y-2 mb-4 p-3 rounded-md border border-border/40 bg-black/20">
        <div className="text-[10px] font-mono text-muted-foreground uppercase">Import Sample</div>
        <input
          type="file"
          accept="audio/*"
          onChange={handleFile}
          className="text-[11px] font-mono w-full"
        />
        {selectedFile && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={license}
                onChange={(e) => setLicense(e.target.value)}
                className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1"
              >
                <option value="CC0">CC0 (public domain)</option>
                <option value="CC-BY">CC-BY (attribution)</option>
                <option value="CC-BY-SA">CC-BY-SA (share-alike)</option>
                <option value="CC-BY-NC">CC-BY-NC (non-commercial)</option>
                <option value="commercial-licensed">Commercial-licensed</option>
              </select>
              <input
                type="text"
                placeholder="Source URL *"
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1"
              />
            </div>
            <input
              type="text"
              placeholder="Author (optional)"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1 w-full"
            />
            <Button
              onClick={handleLoad}
              disabled={!source.trim()}
              size="sm"
              className="bg-emerald-500 hover:bg-emerald-400 text-black font-mono w-full"
            >
              <Upload className="w-3.5 h-3.5 mr-1.5" />
              Load & Fingerprint
            </Button>
          </>
        )}
        {sampleError && (
          <div className="text-[11px] font-mono text-destructive">
            Error: {sampleError}
          </div>
        )}
      </div>

      {/* Loaded samples list */}
      <div className="text-[10px] font-mono text-muted-foreground uppercase mb-2">
        Loaded ({samples.length})
      </div>
      {samples.length === 0 ? (
        <div className="text-[11px] font-mono text-muted-foreground/50 italic">
          No samples loaded. Procedural DSP is active for all tracks.
        </div>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {samples.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-2 p-2 rounded border border-border/40 bg-black/20 text-[11px] font-mono"
            >
              <div className="flex-1 min-w-0">
                <div className="truncate text-foreground/80">{s.name}</div>
                <div className="text-[9px] text-muted-foreground/60">
                  {s.provenance.license} · {s.provenance.fingerprint.slice(0, 16)}… · {s.buffer.duration.toFixed(1)}s · {s.buffer.sampleRate}Hz
                </div>
              </div>
              <button
                onClick={() => removeSample(s.id)}
                className="text-muted-foreground hover:text-destructive p-1"
                aria-label="Remove sample"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

// ── Project panel component (SCOPE 5 — persistence UI) ──────────────────────
function ProjectPanel() {
  const projects = usePsyBoss((s) => s.projects)
  const persistenceError = usePsyBoss((s) => s.persistenceError)
  const saveProject = usePsyBoss((s) => s.saveProject)
  const loadProject = usePsyBoss((s) => s.loadProject)
  const listProjects = usePsyBoss((s) => s.listProjects)
  const [projectName, setProjectName] = useState('')
  const [saving, setSaving] = useState(false)

  // Load project list on mount
  useEffect(() => {
    listProjects()
  }, [listProjects])

  const handleSave = async () => {
    if (!projectName.trim()) return
    setSaving(true)
    await saveProject(projectName.trim())
    setSaving(false)
    setProjectName('')
  }

  const handleLoad = async (id: string) => {
    await loadProject(id)
  }

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      await listProjects()
    } catch (e) {
      console.error('Delete failed:', e)
    }
  }

  return (
    <Card className="border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <Database className="w-4 h-4 text-emerald-400" />
        <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Projects (Turso)
        </h3>
      </div>
      <p className="text-[11px] text-muted-foreground/70 mb-3">
        Save and load patterns to <span className="font-mono text-emerald-400">Turso libSQL</span>.
        BPM, pattern steps, conditions, and locks are persisted. Loaded samples are not (they're
        in-memory only — reload them after loading a project).
      </p>

      {/* Save form */}
      <div className="flex gap-2 mb-4">
        <input
          type="text"
          placeholder="Project name..."
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
          className="text-[11px] font-mono bg-background border border-border rounded px-2 py-1.5 flex-1"
        />
        <Button
          onClick={handleSave}
          disabled={!projectName.trim() || saving}
          size="sm"
          className="bg-emerald-500 hover:bg-emerald-400 text-black font-mono"
        >
          <Save className="w-3.5 h-3.5 mr-1.5" />
          Save
        </Button>
        <Button
          onClick={() => listProjects()}
          size="sm"
          variant="outline"
          className="font-mono"
        >
          <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>

      {persistenceError && (
        <div className="mb-3 text-[11px] font-mono text-destructive">
          Error: {persistenceError}
        </div>
      )}

      {/* Project list */}
      <div className="text-[10px] font-mono text-muted-foreground uppercase mb-2">
        Saved ({projects.length})
      </div>
      {projects.length === 0 ? (
        <div className="text-[11px] font-mono text-muted-foreground/50 italic">
          No saved projects. Enter a name above and click Save.
        </div>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {projects.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 p-2 rounded border border-border/40 bg-black/20 text-[11px] font-mono"
            >
              <div className="flex-1 min-w-0">
                <div className="truncate text-foreground/80">{p.name}</div>
                <div className="text-[9px] text-muted-foreground/60">
                  {p.bpm} BPM · {p._count.steps} steps · {p._count.samples} samples · {new Date(p.updatedAt).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={() => handleLoad(p.id)}
                className="text-emerald-400 hover:text-emerald-300 p-1"
                aria-label="Load project"
                title="Load"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleDelete(p.id)}
                className="text-muted-foreground hover:text-destructive p-1"
                aria-label="Delete project"
                title="Delete"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}


// ── DEVICES PANEL (Scope 3: PSYBUS device adapters) ─────────────────────
function DevicesPanel() {
  const devices = useDevices((s) => s.devices)
  const connect = useDevices((s) => s.connect)
  const disconnect = useDevices((s) => s.disconnect)
  const [midiSupported, setMidiSupported] = useState<boolean | null>(null)
  const [midiDevices, setMidiDevices] = useState<Array<{ id: string; name: string; type: string }>>([])

  useEffect(() => {
    // Check Web MIDI support
    type MidiNav = Navigator & { requestMIDIAccess?: (opts?: { sysex?: boolean }) => Promise<unknown> }
    const nav = navigator as MidiNav
    const hasMidi = typeof nav.requestMIDIAccess === 'function'
    setMidiSupported(hasMidi)

    // List MIDI devices if supported
    if (hasMidi && nav.requestMIDIAccess) {
      nav.requestMIDIAccess().then((access: unknown) => {
        const devices: Array<{ id: string; name: string; type: string }> = []
        // Use duck typing to avoid TS conflicts with MIDIAccess interface
        const midiAccess = access as {
          inputs?: { forEach?: (cb: (input: { id: string; name?: string }) => void) => void }
          outputs?: { forEach?: (cb: (output: { id: string; name?: string }) => void) => void }
        }
        if (midiAccess.inputs?.forEach) {
          midiAccess.inputs.forEach((input) => {
            devices.push({ id: input.id, name: input.name || 'Unknown MIDI Input', type: 'input' })
          })
        }
        if (midiAccess.outputs?.forEach) {
          midiAccess.outputs.forEach((output) => {
            devices.push({ id: output.id, name: output.name || 'Unknown MIDI Output', type: 'output' })
          })
        }
        setMidiDevices(devices)
      }).catch(() => {
        // MIDI access denied or unavailable
      })
    }
  }, [])

  const toggleAdapter = (id: string) => {
    const device = devices.find((d) => d.id === id)
    if (!device) return
    if (device.status === 'connected') {
      disconnect(id)
    } else if (device.status === 'disconnected' || device.status === 'error') {
      connect(id)
    }
  }

  const getAdapterIcon = (id: string) => {
    switch (id) {
      case 'psysynthpro': return <Zap className="w-4 h-4" />
      case 'psysynth': return <Music2 className="w-4 h-4" />
      case 'psydrum': return <Radio className="w-4 h-4" />
      case 'midi': return <Keyboard className="w-4 h-4" />
      case 'webrtc': return <Activity className="w-4 h-4" />
      default: return <Cable className="w-4 h-4" />
    }
  }

  return (
    <Card className="border-border/60 bg-card/40 p-3 md:p-4">
      <div className="mb-4">
        <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-muted-foreground">
          PSYBUS Devices
        </h3>
        <p className="text-[11px] text-muted-foreground/70 mt-0.5">
          Connect external devices to the PSYBOSS conductor. All devices sync via PSYBUS protocol.
        </p>
      </div>

      <div className="grid gap-2">
        {devices.map((adapter) => {
          const connected = adapter.status === 'connected'
          const connecting = adapter.status === 'connecting'
          const isAvailable = adapter.status !== 'coming-soon' && adapter.status !== 'unsupported'

          return (
            <div
              key={adapter.id}
              className={`flex items-center justify-between gap-3 p-3 rounded-lg border transition-all ${
                connected
                  ? 'border-emerald-500/50 bg-emerald-500/10'
                  : adapter.status === 'error'
                  ? 'border-red-500/50 bg-red-500/5'
                  : 'border-border/40 bg-background/20'
              } ${!isAvailable ? 'opacity-50' : ''}`}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-md ${connected ? 'bg-emerald-500/20 text-emerald-400' : 'bg-foreground/5 text-muted-foreground'}`}>
                  {getAdapterIcon(adapter.id)}
                </div>
                <div>
                  <div className="font-mono text-xs font-bold flex items-center gap-2">
                    {adapter.name}
                    {connecting && (
                      <span className="text-[9px] text-amber-400 animate-pulse">CONNECTING...</span>
                    )}
                    {connected && (
                      <span className="text-[9px] text-emerald-400">● LIVE</span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted-foreground/70">{adapter.description}</div>
                  {adapter.error && (
                    <div className="text-[9px] text-red-400/80 mt-0.5 font-mono">{adapter.error}</div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {adapter.status === 'coming-soon' && (
                  <Badge variant="outline" className="font-mono text-[9px] text-amber-400 border-amber-400/30">
                    SOON
                  </Badge>
                )}
                {adapter.status === 'unsupported' && (
                  <Badge variant="outline" className="font-mono text-[9px] text-red-400 border-red-400/30">
                    NOT SUPPORTED
                  </Badge>
                )}
                {isAvailable && (
                  <Switch
                    checked={connected}
                    disabled={connecting}
                    onCheckedChange={() => toggleAdapter(adapter.id)}
                    aria-label={`Connect ${adapter.name}`}
                  />
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* MIDI Devices List */}
      {midiSupported && midiDevices.length > 0 && (
        <div className="mt-4 pt-3 border-t border-border/40">
          <h4 className="font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground mb-2">
            Connected MIDI Devices
          </h4>
          <div className="flex flex-wrap gap-2">
            {midiDevices.map((device) => (
              <Badge key={device.id} variant="outline" className="font-mono text-[9px] gap-1">
                {device.type === 'input' ? <Keyboard className="w-2.5 h-2.5" /> : <Activity className="w-2.5 h-2.5" />}
                {device.name}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {midiSupported === false && (
        <div className="mt-4 pt-3 border-t border-border/40">
          <p className="text-[10px] font-mono text-red-400/70">
            Web MIDI API is not supported in this browser. Use Chrome, Edge, or Opera for MIDI support.
          </p>
        </div>
      )}
    </Card>
  )
}


export default function Home() {
  // Selectors: each field pulled individually so a change to one doesn't re-render
  // components that only depend on another. (ROAST-2 #4 fix: was destructuring the
  // whole store → any state change re-rendered everything 20/sec from meter posts.)
  const ready = usePsyBoss((s) => s.ready)
  const initError = usePsyBoss((s) => s.initError)
  const bpm = usePsyBoss((s) => s.bpm)
  const beat = usePsyBoss((s) => s.beat)
  const bar = usePsyBoss((s) => s.bar)
  const playing = usePsyBoss((s) => s.playing)
  const lastFired = usePsyBoss((s) => s.lastFired)
  const init = usePsyBoss((s) => s.init)
  const togglePlay = usePsyBoss((s) => s.togglePlay)
  const setBpm = usePsyBoss((s) => s.setBpm)
  const trig = usePsyBoss((s) => s.trig)

  const [booted, setBooted] = useState(false)

  const handleBoot = async () => {
    setBooted(true)
    await init()
  }

  const [currentTrack, setCurrentTrack] = useState(0)

  const handleTrig = useCallback(
    (track: number, scene: number) => {
      if (!ready) return
      trig(track, scene)
    },
    [ready, trig],
  )

  // ── Keyboard shortcuts: number keys 1-4 fire scenes on the current track row,
  // Q/W/E/R select track row 0-3. (ROAST-1 §6 fix: was zero shortcuts.)
  useEffect(() => {
    if (!ready) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const k = e.key.toLowerCase()
      if (k >= '1' && k <= '4') {
        e.preventDefault()
        trig(currentTrack, Number(k) - 1)
      } else if (k === 'q') setCurrentTrack(0)
      else if (k === 'w') setCurrentTrack(1)
      else if (k === 'e') setCurrentTrack(2)
      else if (k === 'r') setCurrentTrack(3)
      else if (k === ' ') {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ready, trig, togglePlay, currentTrack])

  const beatDisplay = (Math.floor(beat) % 4) + 1
  const barDisplay = bar + 1

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ── TRANSPORT BAR (sticky top) ── */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-card/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-3 md:px-4 py-2.5 md:py-3 flex items-center gap-3 md:gap-4 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="relative w-8 h-8 rounded-md bg-gradient-to-br from-emerald-400 to-emerald-700 flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.4)]">
              <Zap className="w-5 h-5 text-black" fill="currentColor" />
            </div>
            <div className="leading-none">
              <div className="font-mono font-bold tracking-tight text-base md:text-lg">PSYBOSS</div>
              <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest hidden sm:block">
                Performance Sampler · v0.4
              </div>
            </div>
          </div>

          <div className="h-8 w-px bg-border/60" />

          <div className="flex items-center gap-2">
            <Button
              onClick={togglePlay}
              disabled={!ready}
              size="sm"
              className={`h-9 w-9 p-0 ${
                playing
                  ? 'bg-emerald-500 hover:bg-emerald-400 text-black'
                  : 'bg-foreground/10 hover:bg-foreground/20'
              }`}
              aria-label={playing ? 'Stop' : 'Play'}
            >
              {playing ? (
                <Square className="w-4 h-4" fill="currentColor" />
              ) : (
                <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
              )}
            </Button>
            <div className="flex flex-col items-center px-2 md:px-3 py-1 rounded-md bg-black/40 border border-border/50 min-w-[80px] md:min-w-[88px]">
              <div className="font-mono text-lg md:text-xl font-bold tabular-nums leading-none">
                {barDisplay.toString().padStart(2, '0')}
                <span className="text-muted-foreground">:</span>
                {beatDisplay}
              </div>
              <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider mt-0.5">
                bar : beat
              </div>
            </div>
            <div className="flex gap-0.5">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className={`w-1.5 h-1.5 rounded-full ${
                    playing && beatDisplay - 1 === i
                      ? 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.8)]'
                      : 'bg-foreground/15'
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="h-8 w-px bg-border/60" />

          <div className="flex items-center gap-2 md:gap-3 min-w-[160px] md:min-w-[200px]">
            <div className="flex flex-col">
              <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">
                BPM
              </span>
              <span className="font-mono text-base md:text-lg font-bold tabular-nums leading-none">
                {bpm}
              </span>
            </div>
            <Slider
              value={[bpm]}
              onValueChange={(v) => setBpm(v[0])}
              min={120}
              max={160}
              step={1}
              disabled={!ready}
              className="flex-1"
              aria-label="Tempo"
            />
          </div>

          {/* Master meter — visible on ALL sizes (was hidden on mobile in Scope 1) */}
          <div className="flex flex-col gap-1 flex-1 min-w-[140px] md:min-w-[220px]">
            <MeterBar label="PK" accent="bg-gradient-to-r from-emerald-500 to-amber-400" />
            <MeterBar label="RMS" accent="bg-gradient-to-r from-emerald-600 to-emerald-400" />
          </div>

          <div className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className={`font-mono text-[9px] gap-1 ${
                ready
                  ? 'border-emerald-500/50 text-emerald-400'
                  : 'border-amber-500/50 text-amber-400'
              }`}
            >
              <Activity className="w-2.5 h-2.5" />
              {ready ? 'WORKLET' : 'IDLE'}
            </Badge>
            <Badge variant="outline" className="font-mono text-[9px] gap-1 border-border/60 hidden sm:flex">
              <ShieldCheck className="w-2.5 h-2.5 text-emerald-400" />
              CC0/DSP
            </Badge>
          </div>
        </div>
      </header>

      {/* ── MAIN ── */}
      <main className="flex-1 mx-auto max-w-7xl w-full px-3 md:px-4 py-4 md:py-6 flex flex-col gap-4 md:gap-6">
        {!ready ? (
          <Card className="border-border/60 bg-card/50 p-6 md:p-8 flex flex-col items-center justify-center gap-4 min-h-[50vh]">
            <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-400 to-emerald-700 flex items-center justify-center shadow-[0_0_30px_rgba(16,185,129,0.5)]">
              <Radio className="w-8 h-8 text-black" />
            </div>
            <div className="text-center max-w-md">
              <h2 className="font-mono text-xl font-bold mb-1">Initialize the engine</h2>
              <p className="text-sm text-muted-foreground mb-1">
                PSYBOSS runs a real <span className="font-mono text-emerald-400">AudioWorklet</span> clock
                on the audio thread — no <span className="font-mono">setInterval</span> in the live path.
              </p>
              <p className="text-xs text-muted-foreground">
                Browsers require a user gesture to start audio. Click below to boot.
              </p>
            </div>
            <Button
              onClick={handleBoot}
              size="lg"
              className="bg-emerald-500 hover:bg-emerald-400 text-black font-mono"
            >
              <Zap className="w-4 h-4 mr-2" fill="currentColor" />
              Boot PSYBOSS
            </Button>
            {initError && (
              <div className="mt-2 max-w-md p-3 rounded-md border border-destructive/40 bg-destructive/10 text-destructive text-xs font-mono">
                {initError}
              </div>
            )}
            <div className="mt-4 grid grid-cols-3 gap-3 text-center max-w-lg">
              <div className="p-2 rounded-md bg-black/30 border border-border/40">
                <div className="text-[9px] font-mono text-muted-foreground uppercase">Clock</div>
                <div className="text-xs font-mono text-emerald-400">Worklet</div>
              </div>
              <div className="p-2 rounded-md bg-black/30 border border-border/40">
                <div className="text-[9px] font-mono text-muted-foreground uppercase">Provenance</div>
                <div className="text-xs font-mono text-emerald-400">Enforced</div>
              </div>
              <div className="p-2 rounded-md bg-black/30 border border-border/40">
                <div className="text-[9px] font-mono text-muted-foreground uppercase">DSP</div>
                <div className="text-xs font-mono text-emerald-400">Seeded</div>
              </div>
            </div>
          </Card>
        ) : (
          <>
            <section>
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <div>
                  <h2 className="font-mono text-sm font-bold uppercase tracking-wider text-muted-foreground">
                    Scene Matrix
                  </h2>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    Tap a cell — fires bar-quantized. Keys: <kbd className="px-1 rounded bg-muted text-[10px]">1-4</kbd> scenes, <kbd className="px-1 rounded bg-muted text-[10px]">Q-R</kbd> track, <kbd className="px-1 rounded bg-muted text-[10px]">Space</kbd> play.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="font-mono text-[10px] gap-1">
                    <Keyboard className="w-3 h-3" />
                    Row: {TRACKS[currentTrack]}
                  </Badge>
                  <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                    {TRACKS.length}×{SCENES}
                  </Badge>
                </div>
              </div>

              <div className="rounded-xl border border-border/60 bg-card/40 p-3 md:p-4 overflow-x-auto">
                <div className="min-w-[420px]">
                  <div className="grid grid-cols-[56px_repeat(4,1fr)] md:grid-cols-[64px_repeat(4,1fr)] gap-2 mb-2">
                    <div />
                    {Array.from({ length: SCENES }, (_, i) => (
                      <div
                        key={i}
                        className="text-center text-[10px] font-mono font-bold text-muted-foreground uppercase"
                      >
                        Scene {i + 1}
                      </div>
                    ))}
                  </div>
                  {TRACKS.map((name, track) => (
                    <div
                      key={track}
                      className={`grid grid-cols-[56px_repeat(4,1fr)] md:grid-cols-[64px_repeat(4,1fr)] gap-2 mb-2 last:mb-0 ${currentTrack === track ? 'ring-1 ring-emerald-500/30 rounded-md p-1 -m-1' : ''}`}
                    >
                      <button
                        onClick={() => setCurrentTrack(track)}
                        className="flex items-center text-left hover:text-emerald-400 transition-colors"
                      >
                        <span className={`font-mono text-xs font-bold tracking-wide ${currentTrack === track ? 'text-emerald-400' : 'text-foreground/80'}`}>
                          {name}
                        </span>
                      </button>
                      {Array.from({ length: SCENES }, (_, scene) => {
                        const key = `${track}:${scene}`
                        const armed = lastFired === key
                        return (
                          <SceneCell
                            key={scene}
                            track={track}
                            scene={scene}
                            armed={armed}
                            onTrig={handleTrig}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </section>

            {/* ── SEQUENCER + RENDER + SAMPLES + PROJECTS ── */}
            <Tabs defaultValue="sequencer" className="w-full">
              <TabsList className="grid w-full grid-cols-5 bg-card/40">
                <TabsTrigger value="sequencer" className="font-mono text-xs data-[state=active]:bg-emerald-500/20">
                  <Music2 className="w-3.5 h-3.5 mr-1.5" />
                  Sequencer
                </TabsTrigger>
                <TabsTrigger value="render" className="font-mono text-xs data-[state=active]:bg-emerald-500/20">
                  <FileAudio className="w-3.5 h-3.5 mr-1.5" />
                  Render
                </TabsTrigger>
                <TabsTrigger value="samples" className="font-mono text-xs data-[state=active]:bg-emerald-500/20">
                  <Library className="w-3.5 h-3.5 mr-1.5" />
                  Samples
                </TabsTrigger>
                <TabsTrigger value="projects" className="font-mono text-xs data-[state=active]:bg-emerald-500/20">
                  <Database className="w-3.5 h-3.5 mr-1.5" />
                  Projects
                </TabsTrigger>
                <TabsTrigger value="devices" className="font-mono text-xs data-[state=active]:bg-emerald-500/20">
                  <Cable className="w-3.5 h-3.5 mr-1.5" />
                  Devices
                </TabsTrigger>
              </TabsList>

              <TabsContent value="sequencer" className="mt-3">
                <StepSequencer />
              </TabsContent>
              <TabsContent value="render" className="mt-3">
                <RenderPanel />
              </TabsContent>
              <TabsContent value="samples" className="mt-3">
                <SamplePanel />
              </TabsContent>
              <TabsContent value="projects" className="mt-3">
                <ProjectPanel />
              </TabsContent>
              <TabsContent value="devices" className="mt-3">
                <DevicesPanel />
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>

      {/* ── STATUS FOOTER (mt-auto, NOT sticky — sticky caused overlap with long content) ── */}
      <footer className="mt-auto border-t border-border/60 bg-card/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-3 md:px-4 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[10px] font-mono text-muted-foreground">
            <span className={`w-1.5 h-1.5 rounded-full ${playing ? 'bg-emerald-400 animate-pulse' : 'bg-foreground/30'}`} />
            {playing ? 'RUNNING' : 'STOPPED'}
          </div>
          <div className="text-[10px] font-mono text-emerald-400/60">
            PSYBOSS · v0.6 · MIT
          </div>
        </div>
      </footer>
    </div>
  )
}
