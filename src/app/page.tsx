'use client'

import { useEffect, useState, useCallback, memo } from 'react'
import { usePsyBoss, useMeter, usePattern, useDevices, useWebRTC, useArrangement, useReference, STEPS_PER_BAR } from '@/psyboss/store'
import { TRACK_NAMES, SCENE_COUNT } from '@/psyboss/engine/dsp'
import type { TrigCondition } from '@/psyboss/engine/lfsr'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Card } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Play, Square, Zap, ShieldCheck, Activity, Radio, Keyboard, Download, Music2, FileAudio, Eraser, Upload, Trash2, Library, FolderOpen, Save, Database, Cable, Copy, Check, Users, Layers } from 'lucide-react'

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

// ── A/B REFERENCE PANEL (Scope 4: loudness-matched comparison) ───────────
function ABReferencePanel({ myMasterLufs }: { myMasterLufs: number | null }) {
  const reference = useReference((s) => s.reference)
  const comparison = useReference((s) => s.comparison)
  const analyzing = useReference((s) => s.analyzing)
  const error = useReference((s) => s.error)
  const loadReference = useReference((s) => s.loadReference)
  const compare = useReference((s) => s.compare)
  const clear = useReference((s) => s.clear)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) loadReference(file)
  }

  return (
    <div className="mt-3 p-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-cyan-400">
          A/B Reference (loudness-matched)
        </div>
        {reference && (
          <button onClick={clear} className="text-[9px] font-mono text-muted-foreground hover:text-red-400 transition-colors">
            clear
          </button>
        )}
      </div>

      {!reference && (
        <label className="flex items-center justify-center gap-2 p-3 rounded-md border border-dashed border-cyan-500/30 cursor-pointer hover:border-cyan-500/60 transition-colors">
          <Upload className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-[10px] font-mono text-muted-foreground">
            {analyzing ? 'Analyzing reference...' : 'Upload a reference track (.wav/.mp3)'}
          </span>
          <input type="file" accept="audio/*" onChange={handleFile} disabled={analyzing} className="hidden" />
        </label>
      )}

      {reference && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-mono">
            <div className="text-muted-foreground truncate">{reference.name}</div>
            <div className="text-right tabular-nums">{reference.durationSec.toFixed(0)}s</div>
            <div className="text-muted-foreground">Reference loudness</div>
            <div className="text-right tabular-nums text-cyan-400">{reference.lufs.integrated.toFixed(1)} LUFS</div>
            <div className="text-muted-foreground">Reference true peak</div>
            <div className="text-right tabular-nums">{reference.truePeakDb.toFixed(1)} dBTP</div>
          </div>

          <Button
            onClick={() => myMasterLufs !== null && compare(myMasterLufs)}
            disabled={myMasterLufs === null}
            size="sm"
            variant="outline"
            className="w-full font-mono text-[10px]"
          >
            {myMasterLufs === null
              ? 'Master a track first to compare'
              : `Compare to my master (${myMasterLufs.toFixed(1)} LUFS)`}
          </Button>

          {comparison && (
            <div className="p-2 rounded-md bg-background/40 border border-border/40 text-[10px] font-mono">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <div className="text-muted-foreground">Δ loudness</div>
                <div className={`text-right tabular-nums ${Math.abs(comparison.deltaLu) <= 1 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {comparison.deltaLu >= 0 ? '+' : ''}{comparison.deltaLu.toFixed(1)} LU
                </div>
                <div className="text-muted-foreground">Gain to match</div>
                <div className="text-right tabular-nums">
                  {comparison.gainToMatchDb >= 0 ? '+' : ''}{comparison.gainToMatchDb.toFixed(1)} dB
                </div>
              </div>
              <div className="mt-1.5 text-muted-foreground/80">{comparison.verdict}</div>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-2 text-[10px] font-mono text-red-400">{error}</div>
      )}
    </div>
  )
}

function RenderPanel() {
  const rendering = usePsyBoss((s) => s.rendering)
  const renderError = usePsyBoss((s) => s.renderError)
  const lastRenderInfo = usePsyBoss((s) => s.lastRenderInfo)
  const renderMaster = usePsyBoss((s) => s.renderMaster)
  const renderStems = usePsyBoss((s) => s.renderStems)
  const bpm = usePsyBoss((s) => s.bpm)
  const patternEnabled = usePsyBoss((s) => s.patternEnabled)
  const masteringPreset = usePsyBoss((s) => s.masteringPreset)
  const setMasteringPreset = usePsyBoss((s) => s.setMasteringPreset)
  const masteringReport = usePsyBoss((s) => s.masteringReport)

  const presets = [
    { id: 'off', label: 'Off', desc: 'Raw render, no mastering', target: '' },
    { id: 'club', label: 'Club', desc: '-8 LUFS · -0.1 dBTP', target: 'Beatport / DJ' },
    { id: 'streaming', label: 'Streaming', desc: '-14 LUFS · -1 dBTP', target: 'Spotify / YouTube' },
  ] as const

  return (
    <Card className="border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2 mb-3">
        <FileAudio className="w-4 h-4 text-emerald-400" />
        <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Offline Render + Mastering
        </h3>
      </div>
      <p className="text-[11px] text-muted-foreground/70 mb-3">
        Renders the pattern to 16-bit WAV via <span className="font-mono text-emerald-400">OfflineAudioContext</span>,
        then optionally masters it to a loudness target (ITU-R BS.1770 LUFS + true-peak limiting).
      </p>

      {!patternEnabled && (
        <div className="mb-3 p-2 rounded-md border border-amber-500/30 bg-amber-500/5 text-amber-400 text-[11px] font-mono">
          ⚠ Pattern playback is OFF — enable it in the Step Sequencer tab to render the pattern.
        </div>
      )}

      {/* Mastering preset selector */}
      <div className="mb-3">
        <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
          Mastering Target
        </div>
        <div className="grid grid-cols-3 gap-2">
          {presets.map((p) => (
            <button
              key={p.id}
              onClick={() => setMasteringPreset(p.id)}
              className={`p-2 rounded-lg border transition-all text-left ${
                masteringPreset === p.id
                  ? 'border-emerald-500/60 bg-emerald-500/10'
                  : 'border-border/40 bg-background/20 hover:border-border'
              }`}
            >
              <div className={`font-mono text-[11px] font-bold ${masteringPreset === p.id ? 'text-emerald-400' : 'text-foreground/80'}`}>
                {p.label}
              </div>
              <div className="text-[9px] text-muted-foreground/70 mt-0.5 font-mono">{p.desc}</div>
            </button>
          ))}
        </div>
      </div>

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
          Rendering{masteringPreset !== 'off' ? ' + mastering' : ''}... (offline, no real-time wait)
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

      {/* Mastering report (Scope 4) */}
      {masteringReport && masteringPreset !== 'off' && !rendering && (
        <div className="mt-3 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
          <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-emerald-400 mb-2">
            Mastering Report
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] font-mono">
            <div className="text-muted-foreground">Loudness (before)</div>
            <div className="text-right tabular-nums">{masteringReport.preIntegratedLufs.toFixed(1)} LUFS</div>
            <div className="text-muted-foreground">Loudness (after)</div>
            <div className="text-right tabular-nums text-emerald-400">{masteringReport.postIntegratedLufs.toFixed(1)} LUFS</div>
            <div className="text-muted-foreground">True peak (before)</div>
            <div className="text-right tabular-nums">{masteringReport.preTruePeakDb.toFixed(1)} dBTP</div>
            <div className="text-muted-foreground">True peak (after)</div>
            <div className="text-right tabular-nums text-emerald-400">{masteringReport.postTruePeakDb.toFixed(1)} dBTP</div>
            <div className="text-muted-foreground">Gain applied</div>
            <div className="text-right tabular-nums">{masteringReport.appliedGainDb >= 0 ? '+' : ''}{masteringReport.appliedGainDb.toFixed(1)} dB</div>
          </div>
          {masteringReport.limited && (
            <div className="mt-2 text-[9px] font-mono text-emerald-400/70">
              ✓ True peak held at ceiling — safe for DAC playback
            </div>
          )}
        </div>
      )}

      <ABReferencePanel myMasterLufs={masteringReport?.postIntegratedLufs ?? null} />
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



// ── Copy-to-clipboard helper button ──────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {
      // Clipboard API unavailable; user can select manually.
    })
  }
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1 px-2 py-1 rounded-md bg-foreground/5 hover:bg-foreground/10 text-[10px] font-mono text-muted-foreground transition-colors"
    >
      {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ── WEBRTC SIGNALING PANEL (Scope 3 final) ───────────────────────────────
// Serverless P2P sync: host creates an offer, guest pastes it and returns an
// answer, host pastes the answer. No signaling server, no accounts.
function WebRTCSignalingPanel() {
  const role = useWebRTC((s) => s.role)
  const status = useWebRTC((s) => s.status)
  const offer = useWebRTC((s) => s.offer)
  const answer = useWebRTC((s) => s.answer)
  const latencyMs = useWebRTC((s) => s.latencyMs)
  const error = useWebRTC((s) => s.error)
  const setRole = useWebRTC((s) => s.setRole)
  const hostSession = useWebRTC((s) => s.hostSession)
  const acceptAnswer = useWebRTC((s) => s.acceptAnswer)
  const joinSession = useWebRTC((s) => s.joinSession)
  const disconnect = useWebRTC((s) => s.disconnect)
  const reset = useWebRTC((s) => s.reset)

  const [hostOfferInput, setHostOfferInput] = useState('') // guest pastes host offer
  const [hostAnswerInput, setHostAnswerInput] = useState('') // host pastes guest answer
  const [busy, setBusy] = useState(false)

  const statusColor = {
    idle: 'text-muted-foreground',
    signaling: 'text-amber-400',
    connecting: 'text-amber-400',
    connected: 'text-emerald-400',
    disconnected: 'text-muted-foreground',
    error: 'text-red-400',
  }[status]

  const statusLabel = {
    idle: 'IDLE',
    signaling: 'SIGNALING',
    connecting: 'CONNECTING',
    connected: 'CONNECTED',
    disconnected: 'DISCONNECTED',
    error: 'ERROR',
  }[status]

  const handleCreateOffer = async () => {
    setBusy(true)
    try {
      await hostSession()
    } finally {
      setBusy(false)
    }
  }

  const handleJoinSession = async () => {
    if (!hostOfferInput.trim()) return
    setBusy(true)
    try {
      await joinSession(hostOfferInput.trim())
    } finally {
      setBusy(false)
    }
  }

  const handleAcceptAnswer = async () => {
    if (!hostAnswerInput.trim()) return
    setBusy(true)
    try {
      await acceptAnswer(hostAnswerInput.trim())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-4 pt-3 border-t border-border/40">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-emerald-400" />
          <h4 className="font-mono text-xs font-bold uppercase tracking-wider text-muted-foreground">
            P2P Sync Session
          </h4>
        </div>
        <div className="flex items-center gap-3">
          <span className={`font-mono text-[10px] font-bold ${statusColor}`}>
            {status === 'connected' ? '● ' : '○ '}{statusLabel}
          </span>
          {status === 'connected' && latencyMs > 0 && (
            <span className="font-mono text-[10px] text-emerald-400/70">
              ~{Math.round(latencyMs)}ms
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 p-2 rounded-md bg-red-500/10 border border-red-500/30 text-[10px] font-mono text-red-400">
          {error}
        </div>
      )}

      {/* Role selection */}
      {!role && (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setRole('host')}
            className="p-3 rounded-lg border border-border/40 bg-background/20 hover:border-emerald-500/50 hover:bg-emerald-500/5 transition-all text-left"
          >
            <div className="font-mono text-xs font-bold text-emerald-400">I am the HOST</div>
            <div className="text-[10px] text-muted-foreground/70 mt-0.5">
              I set the tempo. I create the offer.
            </div>
          </button>
          <button
            onClick={() => setRole('guest')}
            className="p-3 rounded-lg border border-border/40 bg-background/20 hover:border-cyan-500/50 hover:bg-cyan-500/5 transition-all text-left"
          >
            <div className="font-mono text-xs font-bold text-cyan-400">I am the GUEST</div>
            <div className="text-[10px] text-muted-foreground/70 mt-0.5">
              I follow the host. I paste the offer.
            </div>
          </button>
        </div>
      )}

      {/* HOST flow */}
      {role === 'host' && (
        <div className="space-y-3">
          {!offer && (
            <Button onClick={handleCreateOffer} disabled={busy} size="sm" className="w-full font-mono text-xs">
              {busy ? 'Generating offer...' : 'Create Offer (Step 1)'}
            </Button>
          )}

          {offer && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-mono font-bold text-muted-foreground">
                    Step 1: Send this OFFER to the guest
                  </label>
                  <CopyButton text={offer} />
                </div>
                <Textarea value={offer} readOnly rows={3} className="font-mono text-[9px] resize-none" />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-mono font-bold text-muted-foreground">
                    Step 2: Paste the guest's ANSWER here
                  </label>
                </div>
                <Textarea
                  value={hostAnswerInput}
                  onChange={(e) => setHostAnswerInput(e.target.value)}
                  placeholder="Paste the guest's answer..."
                  rows={3}
                  className="font-mono text-[9px] resize-none"
                />
              </div>

              <Button
                onClick={handleAcceptAnswer}
                disabled={busy || !hostAnswerInput.trim() || status === 'connected'}
                size="sm"
                className="w-full font-mono text-xs"
              >
                {status === 'connected' ? 'Connected' : busy ? 'Connecting...' : 'Accept Answer & Connect (Step 3)'}
              </Button>
            </>
          )}
        </div>
      )}

      {/* GUEST flow */}
      {role === 'guest' && (
        <div className="space-y-3">
          {!answer && (
            <>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] font-mono font-bold text-muted-foreground">
                    Step 1: Paste the host's OFFER here
                  </label>
                </div>
                <Textarea
                  value={hostOfferInput}
                  onChange={(e) => setHostOfferInput(e.target.value)}
                  placeholder="Paste the host's offer..."
                  rows={3}
                  className="font-mono text-[9px] resize-none"
                />
              </div>
              <Button
                onClick={handleJoinSession}
                disabled={busy || !hostOfferInput.trim()}
                size="sm"
                className="w-full font-mono text-xs"
              >
                {busy ? 'Generating answer...' : 'Generate Answer (Step 2)'}
              </Button>
            </>
          )}

          {answer && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-mono font-bold text-muted-foreground">
                  Step 3: Send this ANSWER back to the host
                </label>
                <CopyButton text={answer} />
              </div>
              <Textarea value={answer} readOnly rows={3} className="font-mono text-[9px] resize-none" />
              <p className="text-[9px] font-mono text-muted-foreground/60 mt-1">
                Waiting for host to accept your answer. Connection will open automatically.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Connected: show disconnect + reset */}
      {(status === 'connected' || status === 'disconnected') && role && (
        <div className="flex gap-2 mt-3">
          <Button onClick={disconnect} variant="outline" size="sm" className="flex-1 font-mono text-xs">
            Disconnect
          </Button>
          <Button onClick={reset} variant="ghost" size="sm" className="flex-1 font-mono text-xs">
            New Session
          </Button>
        </div>
      )}
    </div>
  )
}


// ── ARRANGEMENT PANEL (Scope 4: linear timeline) ─────────────────────────
const CLIP_LABELS = ['Intro', 'Build', 'Drop', 'Break', 'Outro'] as const

function ArrangementPanel() {
  const arrangement = useArrangement((s) => s.arrangement)
  const rendering = useArrangement((s) => s.rendering)
  const renderError = useArrangement((s) => s.renderError)
  const lastExportInfo = useArrangement((s) => s.lastExportInfo)
  const masteringReport = useArrangement((s) => s.masteringReport)
  const addClip = useArrangement((s) => s.addClip)
  const removeClip = useArrangement((s) => s.removeClip)
  const setClipLabel = useArrangement((s) => s.setClipLabel)
  const clear = useArrangement((s) => s.clear)
  const exportArrangement = useArrangement((s) => s.exportArrangement)
  const masteringPreset = usePsyBoss((s) => s.masteringPreset)
  const [newClipBars, setNewClipBars] = useState(8)

  const totalBars = arrangement.clips.reduce((acc, c) => acc + c.lengthBars, 0)
  const clipColors = [
    'border-emerald-500/50 bg-emerald-500/15',
    'border-amber-500/50 bg-amber-500/15',
    'border-cyan-500/50 bg-cyan-500/15',
    'border-fuchsia-500/50 bg-fuchsia-500/15',
    'border-violet-500/50 bg-violet-500/15',
  ]

  return (
    <Card className="border-border/60 bg-card/40 p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-emerald-400" />
          <h3 className="font-mono text-sm font-bold uppercase tracking-wider text-muted-foreground">
            Arrangement Timeline
          </h3>
        </div>
        <Badge variant="outline" className="font-mono text-[10px]">
          {arrangement.clips.length} clips · {totalBars} bars
        </Badge>
      </div>
      <p className="text-[11px] text-muted-foreground/70 mb-3">
        Build a full track by sequencing the current pattern into sections. Each clip renders the
        pattern for its length, then the whole arrangement is concatenated and mastered.
      </p>

      {/* Add clip controls */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="flex items-center gap-1">
          {[4, 8, 16, 32].map((bars) => (
            <button
              key={bars}
              onClick={() => setNewClipBars(bars)}
              className={`px-2 py-1 rounded-md font-mono text-[10px] font-bold transition-colors ${
                newClipBars === bars
                  ? 'bg-emerald-500 text-black'
                  : 'bg-foreground/5 hover:bg-foreground/10 text-muted-foreground'
              }`}
            >
              {bars}
            </button>
          ))}
          <span className="text-[9px] font-mono text-muted-foreground ml-1">bars</span>
        </div>
        <Button onClick={() => addClip(newClipBars)} size="sm" className="h-7 px-3 font-mono text-xs bg-emerald-500 hover:bg-emerald-400 text-black">
          + Add Section
        </Button>
        <Button onClick={clear} size="sm" variant="ghost" className="h-7 px-3 font-mono text-xs">
          <Trash2 className="w-3 h-3 mr-1" />
          Clear
        </Button>
      </div>

      {/* Timeline visualization */}
      <div className="mb-3">
        <div className="text-[10px] font-mono font-bold uppercase tracking-wider text-muted-foreground mb-1.5">
          Timeline
        </div>
        {arrangement.clips.length === 0 ? (
          <div className="p-6 rounded-lg border border-dashed border-border/40 text-center text-[11px] font-mono text-muted-foreground/60">
            No clips yet. Add sections to build your track.
          </div>
        ) : (
          <div className="flex gap-1 overflow-x-auto pb-2">
            {arrangement.clips.map((clip, i) => (
              <div
                key={clip.id}
                className={`flex-shrink-0 rounded-lg border p-2 ${clipColors[i % clipColors.length]}`}
                style={{ minWidth: `${Math.max(60, clip.lengthBars * 8)}px` }}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <select
                    value={CLIP_LABELS.includes(clip.label as typeof CLIP_LABELS[number]) ? clip.label : 'Drop'}
                    onChange={(e) => setClipLabel(clip.id, e.target.value)}
                    className="bg-transparent border-none text-[10px] font-mono font-bold text-foreground/80 outline-none cursor-pointer"
                  >
                    {CLIP_LABELS.map((label) => (
                      <option key={label} value={label} className="bg-background">{label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeClip(clip.id)}
                    className="text-muted-foreground hover:text-red-400 transition-colors"
                    aria-label="Remove clip"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
                <div className="text-[9px] font-mono text-muted-foreground">
                  {clip.lengthBars} bars
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Export */}
      <div className="flex items-center gap-2">
        <Button
          onClick={() => exportArrangement(masteringPreset)}
          disabled={rendering || arrangement.clips.length === 0}
          className="flex-1 font-mono text-xs bg-emerald-500 hover:bg-emerald-400 text-black"
        >
          <Download className="w-3.5 h-3.5 mr-1.5" />
          {rendering ? 'Rendering full track...' : `Export Full Track (${masteringPreset === 'off' ? 'raw' : masteringPreset})`}
        </Button>
      </div>

      {renderError && (
        <div className="mt-2 text-[11px] font-mono text-red-400">{renderError}</div>
      )}
      {lastExportInfo && !rendering && (
        <div className="mt-2 text-[11px] font-mono text-muted-foreground">
          ✓ {lastExportInfo}
        </div>
      )}
      {masteringReport && masteringPreset !== 'off' && !rendering && (
        <div className="mt-2 p-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 text-[10px] font-mono text-emerald-400">
          Mastered: {masteringReport.postIntegratedLufs.toFixed(1)} LUFS · peak {masteringReport.postTruePeakDb.toFixed(1)} dBTP
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
          <WebRTCSignalingPanel />
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
              <TabsList className="grid w-full grid-cols-6 bg-card/40">
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
                <TabsTrigger value="arrange" className="font-mono text-xs data-[state=active]:bg-emerald-500/20">
                  <Layers className="w-3.5 h-3.5 mr-1.5" />
                  Arrange
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
              <TabsContent value="arrange" className="mt-3">
                <ArrangementPanel />
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
            PSYBOSS · v1.0 · MIT
          </div>
        </div>
      </footer>
    </div>
  )
}
