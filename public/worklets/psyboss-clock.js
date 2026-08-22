/**
 * PSYBOSS MasterClock — AudioWorklet processor.
 *
 * THE one clock. Runs on the audio thread. NOT setInterval.
 *
 * Responsibilities:
 *  1. Advance the musical clock every quantum (128 samples) by sampleRate-accurate math.
 *  2. Post transport state (beat/bar/phase/bpm/audioTime) to the main thread on bar boundaries.
 *  3. Pass master-bus audio through (stereo) and meter it (RMS + peak) in real time.
 *  4. Report meter every ~50ms (not every quantum — that would flood the message queue).
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
 * This closes the family's #1 defect: setInterval(25) schedulers in every flagship.
 * The main thread NEVER touches musical timing. It only reads transport posts and
 * schedules Web Audio nodes at sample-accurate audio-context times.
 */
class PsyBossClockProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.bpm = 144
    this.playing = false
    this.beat = 0 // float, advances continuously
    this.bar = 0
    this.lastMeterPost = 0
    this.sumSq = 0
    this.peak = 0
    this.sampleCount = 0
    this._lastBar = -1

    this.port.onmessage = (e) => {
      const m = e.data
      switch (m.kind) {
        case 'setBpm':
          this.bpm = m.bpm
          break
        case 'play':
          this.playing = true
          break
        case 'stop':
          this.playing = false
          break
        case 'seek':
          this.beat = m.beat
          this.bar = Math.floor(m.beat / 4)
          this._lastBar = this.bar
          break
      }
    }
  }

  process(inputs, outputs) {
    // ── Passthrough + meter: master bus audio flows through this node to destination ──
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

      // meter (stereo, sum both channels)
      const a = Math.abs(left)
      const b = Math.abs(right)
      this.sumSq += left * left + right * right
      if (a > this.peak) this.peak = a
      if (b > this.peak) this.peak = b
      this.sampleCount += 2
    }

    // ── Advance the musical clock ──
    if (this.playing && n > 0) {
      const quantumSec = n / sampleRate
      const beatsPerSec = this.bpm / 60
      const prevBeat = this.beat
      this.beat += quantumSec * beatsPerSec

      const prevBar = Math.floor(prevBeat / 4)
      const newBar = Math.floor(this.beat / 4)
      // Post transport on every bar boundary (the main thread arms voices for the next bar)
      if (newBar > prevBar) {
        this.bar = newBar
        this.port.postMessage({
          kind: 'transport',
          bpm: this.bpm,
          beat: this.beat,
          bar: newBar,
          phase: (this.beat % 4) / 4,
          playing: true,
          audioTime: currentTime,
        })
      }
    }

    // ── Meter post every ~50ms ──
    if (currentTime - this.lastMeterPost > 0.05) {
      const rms = this.sampleCount > 0 ? Math.sqrt(this.sumSq / this.sampleCount) : 0
      // convert to dBFS, clamp
      const rmsDb = rms > 1e-7 ? 20 * Math.log10(rms) : -140
      const peakDb = this.peak > 1e-7 ? 20 * Math.log10(this.peak) : -140
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
