'use client'

import { useEffect, useState, useCallback, memo } from 'react'
import { usePsyBoss, useMeter, usePattern, STEPS_PER_BAR } from '@/psyboss/store'
import { TRACK_NAMES, SCENE_COUNT } from '@/psyboss/engine/dsp'
import type { TrigCondition } from '@/psyboss/engine/lfsr'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Card } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Play, Square, Zap, ShieldCheck, Activity, Radio, Keyboard, Download, Music2, FileAudio, Eraser } from 'lucide-react'

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

// memo'd so it only re-renders when its own props change (ROAST-2 #4 fix:
// without memo, every meter post (20/sec) re-rendered all 16 cells).
const SceneCell = memo(function SceneCell({
  track,
  scene,
  armed,
  onTrig,
}: {
  track: number
  scene: number
  armed: boolean
  onTrig: () => void
}) {
  const trackColor = [
    'from-emerald-500/30 to-emerald-700/20 border-emerald-500/40',
    'from-amber-500/30 to-amber-700/20 border-amber-500/40',
    'from-cyan-500/30 to-cyan-700/20 border-cyan-500/40',
    'from-fuchsia-500/30 to-fuchsia-700/20 border-fuchsia-500/40',
  ][track % 4]

  return (
    <button
      onClick={onTrig}
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
  const setSelectedTrack = usePattern((s) => s.setSelectedTrack)
  const clearPattern = usePattern((s) => s.clearPattern)
  const patternEnabled = usePsyBoss((s) => s.patternEnabled)
  const setPatternEnabled = usePsyBoss((s) => s.setPatternEnabled)
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
                onClick={() => toggleStep(i)}
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
                    ? 'bg-gradient-to-br from-emerald-500/40 to-emerald-700/30 border-emerald-500/60'
                    : 'bg-foreground/5 border-border/40 hover:border-border/80'
                  }
                  ${currentStep === i && patternEnabled ? 'ring-2 ring-emerald-300 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : ''}
                  ${i % 4 === 0 ? 'border-l-2 border-l-emerald-500/30' : ''}
                `}
                title={`Step ${i + 1} · ${step.condition.kind} · scene ${step.scene + 1}${step.locks.length ? ` · ${step.locks.length} locks` : ''}`}
              >
                {step.active && (
                  <span className="text-[8px] font-mono font-bold text-foreground/60 absolute inset-0 flex items-center justify-center">
                    {step.scene + 1}
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
            Left-click: toggle · Right-click: cycle condition (always → 50% → 25% → fill/4 → not-fill/4)
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

export default function Home() {
  // Selectors: each field pulled individually so a change to one doesn't re-render
  // components that only depend on another. (ROAST-2 #4 fix: was destructuring the
  // whole store → any state change re-rendered everything 20/sec from meter posts.)
  const ready = usePsyBoss((s) => s.ready)
  const initError = usePsyBoss((s) => s.initError)
  const bpm = usePsyBoss((s) => s.bpm)
  const beat = usePsyBoss((s) => s.beat)
  const bar = usePsyBoss((s) => s.bar)
  const phase = usePsyBoss((s) => s.phase)
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
                Performance Sampler · v0.2
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
                            onTrig={() => handleTrig(track, scene)}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </section>

            <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card className="p-4 bg-card/40 border-border/60">
                <div className="flex items-center gap-2 mb-2">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider">Engine</span>
                </div>
                <div className="space-y-1 text-xs font-mono">
                  <div className="flex justify-between"><span className="text-muted-foreground">Scheduler</span><span className="text-emerald-400">AudioWorklet</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Voice cap</span><span>64 (steal)</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Quantize</span><span>Bar (4/4)</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Seed</span><span>0x9e3779b9</span></div>
                </div>
              </Card>
              <Card className="p-4 bg-card/40 border-border/60">
                <div className="flex items-center gap-2 mb-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider">Provenance</span>
                </div>
                <div className="space-y-1 text-xs font-mono">
                  <div className="flex justify-between"><span className="text-muted-foreground">Policy</span><span className="text-emerald-400">Enforced</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Gate path</span><span className="text-emerald-400">bus.publish</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Sources</span><span>PSYBOSS DSP</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Fingerprint</span><span>dsp:id:seed</span></div>
                </div>
              </Card>
              <Card className="p-4 bg-card/40 border-border/60">
                <div className="flex items-center gap-2 mb-2">
                  <Radio className="w-4 h-4 text-emerald-400" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider">PSYBUS</span>
                </div>
                <div className="space-y-1 text-xs font-mono">
                  <div className="flex justify-between"><span className="text-muted-foreground">Tier</span><span>0 (in-process)</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Routing</span><span className="text-emerald-400">unicast+broadcast</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Devices</span><span>2 (UI+eng)</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Direction</span><span className="text-emerald-400">Bidirectional</span></div>
                </div>
              </Card>
            </section>

            {/* ── STEP SEQUENCER + RENDER (Scope 3) ── */}
            <Tabs defaultValue="sequencer" className="w-full">
              <TabsList className="grid w-full grid-cols-2 bg-card/40">
                <TabsTrigger value="sequencer" className="font-mono text-xs data-[state=active]:bg-emerald-500/20">
                  <Music2 className="w-3.5 h-3.5 mr-1.5" />
                  Step Sequencer
                </TabsTrigger>
                <TabsTrigger value="render" className="font-mono text-xs data-[state=active]:bg-emerald-500/20">
                  <FileAudio className="w-3.5 h-3.5 mr-1.5" />
                  Render & Export
                </TabsTrigger>
              </TabsList>

              {/* ── Step Sequencer tab ── */}
              <TabsContent value="sequencer" className="mt-3">
                <StepSequencer />
              </TabsContent>

              {/* ── Render tab ── */}
              <TabsContent value="render" className="mt-3">
                <RenderPanel />
              </TabsContent>
            </Tabs>
          </>
        )}
      </main>

      {/* ── STATUS FOOTER (sticky bottom) ── */}
      <footer className="sticky bottom-0 z-30 mt-auto border-t border-border/60 bg-card/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-3 md:px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 md:gap-3 text-[10px] font-mono text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${playing ? 'bg-emerald-400 animate-pulse' : 'bg-foreground/30'}`} />
              {playing ? 'TRANSPORT RUNNING' : 'TRANSPORT STOPPED'}
            </span>
            <span className="text-border hidden sm:inline">|</span>
            <span className="hidden sm:inline">phase {(phase * 100).toFixed(0)}%</span>
            <span className="text-border hidden md:inline">|</span>
            <span className="hidden md:inline">beat {beat.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-2 md:gap-3 text-[10px] font-mono text-muted-foreground">
            <span className="hidden md:inline">No setInterval in audio path</span>
            <span className="hidden md:inline text-border">|</span>
            <span className="text-emerald-400/80">PSYBOSS · Scope 2 · MIT</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
