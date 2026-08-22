/**
 * PSYBOSS procedural DSP — real sample-by-sample synthesis, rendered into
 * AudioBuffers at load time. No OscillatorNode. No samples. No licensing.
 *
 * Provenance for every sound: { license: 'psboss-dsp', source: 'PSYBOSS DSP v1',
 * fingerprint: 'dsp:<sound>:<seed>' }. The host's provenance gate accepts this.
 *
 * Track map (Scope 1):
 *   track 0 → KICK   (4 variants by scene: tighter / longer / punchier / sub-heavy)
 *   track 1 → SNARE  (4 variants)
 *   track 2 → HAT    (4 variants: closed / open / tight / shaker)
 *   track 3 → BASS   (4 variants: root / octave / fifth / octave+fifth)
 *
 * Scope 2 replaces these with real sample loading through the provenance gate.
 * The DSP here proves the engine renders real audio, not Web Audio node graphs.
 */

export interface StereoBuffer {
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
  sampleRate: number
}

const TAU = Math.PI * 2

// ── Envelope helpers ─────────────────────────────────────────────────────────
function envExp(t: number, decay: number): number {
  // exponential decay, never zero (avoid denormals)
  return Math.exp(-t / decay)
}

function envAR(t: number, attack: number, release: number, peak = 1): number {
  if (t < attack) return (t / attack) * peak
  const rt = t - attack
  return peak * Math.exp(-rt / release)
}

// ── A simple one-pole lowpass (for bass/body) ────────────────────────────────
function onePoleLP(prev: number, input: number, alpha: number): number {
  return prev + alpha * (input - prev)
}

// ── KICK: FM pitch sweep + amp envelope + click transient ────────────────────
function renderKick(sampleRate: number, variant: number): StereoBuffer {
  const dur = 0.32 // 320ms
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  // variant params
  const startFreq = [150, 160, 140, 130][variant] ?? 150
  const endFreq = [50, 48, 52, 45][variant] ?? 50
  const pitchDecayMs = [60, 50, 70, 80][variant] ?? 60
  const ampDecay = [0.09, 0.07, 0.11, 0.14][variant] ?? 0.09
  const clickGain = [0.5, 0.6, 0.4, 0.3][variant] ?? 0.5

  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    // pitch envelope: exponential from startFreq to endFreq over pitchDecayMs
    const pEnv = Math.exp(-t / (pitchDecayMs / 1000))
    const freq = endFreq + (startFreq - endFreq) * pEnv
    phase += (freq / sampleRate) * TAU
    const sine = Math.sin(phase)
    // amp envelope
    const amp = envExp(t, ampDecay)
    // click transient (first 2ms)
    const click = t < 0.002 ? (Math.random() * 2 - 1) * clickGain * (1 - t / 0.002) : 0
    const sample = sine * amp + click * amp
    left[i] = sample
    right[i] = sample
  }
  return { left, right, sampleRate }
}

// ── SNARE: noise + tonal body, bandpass-ish ──────────────────────────────────
function renderSnare(sampleRate: number, variant: number): StereoBuffer {
  const dur = 0.18
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const bodyFreq = [200, 180, 220, 240][variant] ?? 200
  const decay = [0.05, 0.04, 0.06, 0.045][variant] ?? 0.05
  const noiseGain = [0.7, 0.8, 0.6, 0.65][variant] ?? 0.7
  const toneGain = [0.4, 0.35, 0.45, 0.3][variant] ?? 0.4

  // simple state for one-pole HP on noise
  let prevNoise = 0
  let prevHP = 0
  let bodyPhase = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const amp = envExp(t, decay)
    // noise through crude highpass (differentiate)
    const raw = Math.random() * 2 - 1
    prevHP = raw - prevNoise
    prevNoise = raw
    const noise = prevHP * noiseGain
    // tonal body
    bodyPhase += (bodyFreq / sampleRate) * TAU
    const tone = Math.sin(bodyPhase) * toneGain
    const sample = (noise + tone) * amp
    left[i] = sample
    right[i] = sample * 0.9 // slight stereo offset feel
  }
  return { left, right, sampleRate }
}

// ── HAT: noise through highpass, short decay ─────────────────────────────────
function renderHat(sampleRate: number, variant: number): StereoBuffer {
  const dur = [0.08, 0.22, 0.05, 0.16][variant] ?? 0.08
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  const decay = [0.025, 0.06, 0.015, 0.04][variant] ?? 0.025
  const hpAlpha = [0.85, 0.8, 0.9, 0.82][variant] ?? 0.85 // higher = brighter

  let prevRaw = 0
  let prevHP = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    const amp = envExp(t, decay)
    const raw = Math.random() * 2 - 1
    // one-pole HP
    prevHP = hpAlpha * (prevHP + raw - prevRaw)
    prevRaw = raw
    const sample = prevHP * amp * 0.5
    left[i] = sample
    right[i] = sample * 0.85
  }
  return { left, right, sampleRate }
}

// ── BASS: saw through lowpass, one-shot (root/octave/fifth/octave+fifth) ─────
function renderBass(sampleRate: number, variant: number): StereoBuffer {
  const dur = 0.3
  const n = Math.floor(dur * sampleRate)
  const left = new Float32Array(n)
  const right = new Float32Array(n)

  // psytrance bass typically ~55Hz (A1). Variants add harmonics.
  const root = 55 // A1
  const intervals = [1, 2, 1.5, 3][variant] ?? 1 // root, octave, fifth, octave+fifth
  const freq = root * (variant === 3 ? 2 : intervals)
  const lpAlpha = [0.12, 0.18, 0.15, 0.2][variant] ?? 0.12
  const decay = [0.12, 0.1, 0.11, 0.09][variant] ?? 0.12

  let sawPhase = 0
  let lpPrev = 0
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    // saw: phase 0..1, map to -1..1
    sawPhase += freq / sampleRate
    sawPhase -= Math.floor(sawPhase)
    const saw = sawPhase * 2 - 1
    // lowpass
    lpPrev = onePoleLP(lpPrev, saw, lpAlpha)
    // amp envelope (attack 5ms, then exp decay)
    const amp = envAR(t, 0.005, decay, 0.8)
    const sample = lpPrev * amp
    left[i] = sample
    right[i] = sample
  }
  return { left, right, sampleRate }
}

const RENDERERS = [renderKick, renderSnare, renderHat, renderBass]

export const TRACK_NAMES = ['KICK', 'SNARE', 'HAT', 'BASS'] as const
export const SCENE_COUNT = 4

/**
 * Render the full Scope-1 sound bank: 4 tracks × 4 scenes = 16 procedural sounds.
 * Returns a map keyed by `${track}:${scene}`.
 */
export function renderSoundBank(sampleRate: number): Map<string, StereoBuffer> {
  const bank = new Map<string, StereoBuffer>()
  for (let track = 0; track < RENDERERS.length; track++) {
    for (let scene = 0; scene < SCENE_COUNT; scene++) {
      const buf = RENDERERS[track](sampleRate, scene)
      bank.set(`${track}:${scene}`, buf)
    }
  }
  return bank
}

/**
 * Build a provenance record for a PSYBOSS-generated sound.
 * The host's gate accepts 'psboss-dsp' fingerprints of the form 'dsp:<id>'.
 */
export function dspProvenance(soundId: string): import('@/psybus/types').Provenance {
  return {
    license: 'psboss-dsp',
    source: 'PSYBOSS DSP generator v1',
    verifiedAt: Date.now(),
    fingerprint: `dsp:${soundId}`,
  }
}
