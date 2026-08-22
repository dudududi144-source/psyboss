'use client'

import { useEffect, useState } from 'react'
import { usePsyBoss } from '@/psyboss/store'
import { TRACK_NAMES, SCENE_COUNT } from '@/psyboss/engine/dsp'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Card } from '@/components/ui/card'
import { Play, Square, Zap, ShieldCheck, Activity, Radio } from 'lucide-react'

const TRACKS = TRACK_NAMES as readonly string[]
const SCENES = SCENE_COUNT

// Map a dBFS value (-60..0) to a 0..100 fill percentage.
function dbToPct(db: number): number {
  const clamped = Math.max(-60, Math.min(0, db))
  return ((clamped + 60) / 60) * 100
}

function MeterBar({ db, label, accent }: { db: number; label: string; accent: string }) {
  const pct = dbToPct(db)
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <span className="text-[10px] font-mono text-muted-foreground w-8">{label}</span>
      <div className="relative flex-1 h-2.5 rounded-full bg-black/60 overflow-hidden border border-border/50">
        <div
          className={`absolute inset-y-0 left-0 ${accent} transition-[width] duration-75`}
          style={{ width: `${pct}%` }}
        />
        {/* peak tick at -6dB */}
        <div className="absolute inset-y-0 left-[90%] w-px bg-amber-400/60" />
      </div>
      <span className="text-[10px] font-mono text-muted-foreground w-12 text-right">
        {db <= -139 ? '−∞' : db.toFixed(1)}
      </span>
    </div>
  )
}

function SceneCell({
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
}

export default function Home() {
  const {
    ready,
    initError,
    bpm,
    beat,
    bar,
    phase,
    playing,
    rms,
    peak,
    lastFired,
    init,
    togglePlay,
    setBpm,
    trig,
  } = usePsyBoss()

  const [booted, setBooted] = useState(false)

  // Init must happen on user gesture (browser AudioContext policy). Show a gate.
  useEffect(() => {
    if (booted && !ready && !initError) {
      // auto-init attempt after user gesture (the boot button)
    }
  }, [booted, ready, initError])

  const handleBoot = async () => {
    setBooted(true)
    await init()
  }

  const handleTrig = (track: number, scene: number) => {
    if (!ready) return
    trig(track, scene)
  }

  const beatDisplay = (beat % 4) + 1
  const barDisplay = bar + 1

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* ── TRANSPORT BAR (sticky top) ── */}
      <header className="sticky top-0 z-30 border-b border-border/60 bg-card/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 py-3 flex items-center gap-4 flex-wrap">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <div className="relative w-8 h-8 rounded-md bg-gradient-to-br from-emerald-400 to-emerald-700 flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.4)]">
              <Zap className="w-5 h-5 text-black" fill="currentColor" />
            </div>
            <div className="leading-none">
              <div className="font-mono font-bold tracking-tight text-lg">PSYBOSS</div>
              <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-widest">
                Performance Sampler · v0.1
              </div>
            </div>
          </div>

          <div className="h-8 w-px bg-border/60" />

          {/* Transport */}
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
            <div className="flex flex-col items-center px-3 py-1 rounded-md bg-black/40 border border-border/50 min-w-[88px]">
              <div className="font-mono text-xl font-bold tabular-nums leading-none">
                {barDisplay.toString().padStart(2, '0')}
                <span className="text-muted-foreground">:</span>
                {beatDisplay}
              </div>
              <div className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider mt-0.5">
                bar : beat
              </div>
            </div>
            {/* phase indicator */}
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

          {/* BPM */}
          <div className="flex items-center gap-3 min-w-[200px]">
            <div className="flex flex-col">
              <span className="text-[9px] font-mono text-muted-foreground uppercase tracking-wider">
                BPM
              </span>
              <span className="font-mono text-lg font-bold tabular-nums leading-none">
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

          <div className="h-8 w-px bg-border/60 hidden md:block" />

          {/* Master meter */}
          <div className="hidden md:flex flex-col gap-1.5 flex-1 min-w-[220px]">
            <MeterBar db={peak} label="PK" accent="bg-gradient-to-r from-emerald-500 to-amber-400" />
            <MeterBar db={rms} label="RMS" accent="bg-gradient-to-r from-emerald-600 to-emerald-400" />
          </div>

          {/* Status badges */}
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
            <Badge variant="outline" className="font-mono text-[9px] gap-1 border-border/60">
              <ShieldCheck className="w-2.5 h-2.5 text-emerald-400" />
              CC0/DSP
            </Badge>
          </div>
        </div>
      </header>

      {/* ── MAIN: SCENE MATRIX ── */}
      <main className="flex-1 mx-auto max-w-7xl w-full px-4 py-6 flex flex-col gap-6">
        {!ready ? (
          <Card className="border-border/60 bg-card/50 p-8 flex flex-col items-center justify-center gap-4 min-h-[50vh]">
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
                <div className="text-[9px] font-mono text-muted-foreground uppercase">Samples</div>
                <div className="text-xs font-mono text-emerald-400">Procedural</div>
              </div>
            </div>
          </Card>
        ) : (
          <>
            {/* Scene matrix */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h2 className="font-mono text-sm font-bold uppercase tracking-wider text-muted-foreground">
                    Scene Matrix
                  </h2>
                  <p className="text-[11px] text-muted-foreground/70 mt-0.5">
                    Tap a cell — fires bar-quantized, sample-accurate.
                  </p>
                </div>
                <Badge variant="outline" className="font-mono text-[10px] text-muted-foreground">
                  {TRACKS.length} tracks × {SCENES} scenes
                </Badge>
              </div>

              <div className="rounded-xl border border-border/60 bg-card/40 p-3 md:p-4 overflow-x-auto">
                <div className="min-w-[480px]">
                  {/* scene number header */}
                  <div className="grid grid-cols-[64px_repeat(4,1fr)] gap-2 mb-2">
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
                  {/* tracks */}
                  {TRACKS.map((name, track) => (
                    <div
                      key={track}
                      className="grid grid-cols-[64px_repeat(4,1fr)] gap-2 mb-2 last:mb-0"
                    >
                      <div className="flex items-center">
                        <span className="font-mono text-xs font-bold tracking-wide text-foreground/80">
                          {name}
                        </span>
                      </div>
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

            {/* Info strip */}
            <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card className="p-4 bg-card/40 border-border/60">
                <div className="flex items-center gap-2 mb-2">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider">
                    Engine
                  </span>
                </div>
                <div className="space-y-1 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sample rate</span>
                    <span>48 kHz</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Scheduler</span>
                    <span className="text-emerald-400">AudioWorklet</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Quantize</span>
                    <span>Bar (4/4)</span>
                  </div>
                </div>
              </Card>
              <Card className="p-4 bg-card/40 border-border/60">
                <div className="flex items-center gap-2 mb-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider">
                    Provenance
                  </span>
                </div>
                <div className="space-y-1 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Policy</span>
                    <span className="text-emerald-400">Enforced</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Sources</span>
                    <span>PSYBOSS DSP</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">License</span>
                    <span>CC0 / MIT</span>
                  </div>
                </div>
              </Card>
              <Card className="p-4 bg-card/40 border-border/60">
                <div className="flex items-center gap-2 mb-2">
                  <Radio className="w-4 h-4 text-emerald-400" />
                  <span className="font-mono text-xs font-bold uppercase tracking-wider">
                    PSYBUS
                  </span>
                </div>
                <div className="space-y-1 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Tier</span>
                    <span>0 (in-process)</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Devices</span>
                    <span>{TRACKS.length} tracks</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Direction</span>
                    <span className="text-emerald-400">Bidirectional</span>
                  </div>
                </div>
              </Card>
            </section>
          </>
        )}
      </main>

      {/* ── STATUS FOOTER (sticky bottom) ── */}
      <footer className="sticky bottom-0 z-30 mt-auto border-t border-border/60 bg-card/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 py-2 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${playing ? 'bg-emerald-400 animate-pulse' : 'bg-foreground/30'}`} />
              {playing ? 'TRANSPORT RUNNING' : 'TRANSPORT STOPPED'}
            </span>
            <span className="text-border">|</span>
            <span>phase {(phase * 100).toFixed(0)}%</span>
            <span className="text-border">|</span>
            <span>beat {beat.toFixed(2)}</span>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono text-muted-foreground">
            <span className="hidden sm:inline">No setInterval in audio path</span>
            <span className="hidden sm:inline text-border">|</span>
            <span className="text-emerald-400/80">PSYBOSS · Scope 1 · MIT</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
