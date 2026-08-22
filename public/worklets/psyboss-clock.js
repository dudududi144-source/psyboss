/**
 * PSYBOSS MasterClock — AudioWorklet processor.
 *
 * THE one clock. Runs on the audio thread. NOT setInterval.
 *
 * Scope 2 fixes (ROAST-1 §3):
 *   - Posts transport IMMEDIATELY on `play` message (was: waited for the first bar
 *     boundary → 1.67s silence after first click at 144 BPM).
 *   - Posts transport on `setBpm` too (was: bar/beat readout stale for up to 1 bar
 *     after a BPM change).
 *
 * Responsibilities:
 *   1. Advance the musical clock every quantum (128 samples) by sampleRate-accurate math.
 *   2. Post transport state (beat/bar/phase/bpm/audioTime) to the main thread:
 *      - on bar boundaries (every 4 beats)
 *      - immediately on play
 *      - immediately on setBpm
 *   3. Pass master-bus audio through (stereo) and meter it (RMS + peak with hold).
 *   4. Report meter every ~50ms (not every quantum — that would flood the queue).
 *
 * Messages IN (main → worklet):
 *   { kind: 'setBpm', bpm }
 *   { kind: 'play' }
 *   { kind: 'stop' }
 *   { kind: 'seek', beat }
 *
 * Messages OUT (worklet → main):
 *   { kind: 'transport', bpm, beat, bar, phase, playing, audioTime }
 *   { kind: 'meter', rms, peak }
 *
 * The main thread NEVER touches musical timing. It reads transport posts and
 * schedules Web Audio nodes at sample-accurate audio-context times.
 */
class PsyBossClockProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.bpm = 144
    this.playing = false
    this.beat = 0
    this.bar = 0
    this.lastMeterPost = 0
    this.sumSq = 0
    this.peak = 0
    this.peakHold = 0       // held peak (decays after holdTime)
    this.peakHoldTimer = 0  // seconds since peak was set
    this.sampleCount = 0

    this.port.onmessage = (e) => {
      const m = e.data
      switch (m.kind) {
        case 'setBpm':
          this.bpm = m.bpm
          // Post immediately so the UI's bar/beat readout reflects the new BPM right away
          // (ROAST-1 §3 fix: was stale for up to 1 bar).
          this.postTransport()
          break
        case 'play':
          this.playing = true
          // Post immediately so the engine can arm/flush trigs for beat 0 without waiting
          // 1.67s for the first bar boundary (ROAST-1 §3 fix).
          this.postTransport()
          break
        case 'stop':
          this.playing = false
          // ROAST-5 #C fix: reset beat/bar so next play starts at bar 0 beat 0.
          // Was: beat/bar kept their values, so transport.bar kept incrementing
          // across play/stop cycles, breaking barStartTime math.
          this.beat = 0
          this.bar = 0
          this.postTransport()
          break
        case 'seek':
          this.beat = m.beat
          this.bar = Math.floor(m.beat / 4)
          this.postTransport()
          break
      }
    }
  }

  postTransport() {
    this.port.postMessage({
      kind: 'transport',
      bpm: this.bpm,
      beat: this.beat,
      bar: this.bar,
      phase: (this.beat % 4) / 4,
      playing: this.playing,
      audioTime: currentTime,
    })
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]
    const inCh = input?.length ?? 0
    const outCh = output?.length ?? 0
    const n = outCh > 0 ? output[0].length : 0

    for (let i = 0; i < n; i++) {
      let left = 0
      let right = 0
      if (inCh > 0) left = input[0][i]
      if (inCh > 1) right = input[1][i]
      else if (inCh > 0) right = left
      if (outCh > 0) output[0][i] = left
      if (outCh > 1) output[1][i] = right

      const a = Math.abs(left)
      const b = Math.abs(right)
      this.sumSq += left * left + right * right
      this.sampleCount += 2  // ROAST-2 #1 fix: was never incremented → RMS always 0 = -∞
      const instPeak = a > b ? a : b
      if (instPeak > this.peak) this.peak = instPeak
    }

    if (this.playing && n > 0) {
      const quantumSec = n / sampleRate
      const beatsPerSec = this.bpm / 60
      const prevBar = Math.floor(this.beat / 4)
      const prevStep = Math.floor(this.beat * 4) // 16th-note step index (0-15 per bar)
      this.beat += quantumSec * beatsPerSec
      const newBar = Math.floor(this.beat / 4)
      const newStep = Math.floor(this.beat * 4)
      // ROAST-3 #2 fix: post transport on EVERY 16th-note boundary (not just bars)
      // so the UI's step highlight can track the current step. At 144 BPM, a 16th =
      // 104ms → ~9.6 posts/sec (manageable, not a flood).
      if (newStep > prevStep || newBar > prevBar) {
        this.bar = newBar
        this.postTransport()
      }
    }

    // Meter post every ~50ms with peak-hold (ROAST-1 §1 fix: was resetting peak every window).
    if (currentTime - this.lastMeterPost > 0.05) {
      const rms = this.sampleCount > 0 ? Math.sqrt(this.sumSq / this.sampleCount) : 0
      const rmsDb = rms > 1e-7 ? 20 * Math.log10(rms) : -140
      // Peak-hold: hold the peak for 1s, then decay at 6 dB/s
      if (this.peak > this.peakHold) {
        this.peakHold = this.peak
        this.peakHoldTimer = 0
      } else {
        this.peakHoldTimer += 0.05
        if (this.peakHoldTimer > 1.0) {
          // decay 6dB/s → multiply by 0.5 every second → 0.5^(0.05) per post
          this.peakHold *= Math.pow(0.5, 0.05)
        }
      }
      const peakDb = this.peakHold > 1e-7 ? 20 * Math.log10(this.peakHold) : -140
      this.port.postMessage({ kind: 'meter', rms: rmsDb, peak: peakDb })
      this.sumSq = 0
      this.peak = 0
      this.sampleCount = 0
      this.lastMeterPost = currentTime
    }

    return true
  }
}

registerProcessor('psyboss-clock', PsyBossClockProcessor)
