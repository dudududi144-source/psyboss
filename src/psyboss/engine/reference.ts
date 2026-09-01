/**
 * PSYBOSS Reference-track analysis — Scope 4 (A/B loudness matching).
 *
 * Mastering engineers A/B their work against a known-good reference track.
 * The trick is LOUDNESS MATCHING: a louder track always *sounds* better, so a
 * fair comparison requires normalizing both to the same integrated LUFS.
 *
 * This module analyzes an uploaded reference file:
 *   1. Decode it to PCM (reuses the AudioContext.decodeAudioData path).
 *   2. Measure its integrated LUFS + true peak via the ITU-R BS.1770 meter in
 *      mastering.ts.
 *   3. Return the measurements so the UI can show the delta against the user's
 *      own master and suggest the gain needed to match.
 *
 * All DSP is reused from mastering.ts — this module only orchestrates decoding
 * and the comparison math. No new loudness math lives here.
 */

import { measureLufs, measureTruePeak, type LufsResult } from './mastering'

export interface ReferenceAnalysis {
  /** File name of the uploaded reference. */
  name: string
  /** Duration in seconds. */
  durationSec: number
  /** Sample rate of the decoded file. */
  sampleRate: number
  /** Integrated LUFS (gated) of the reference. */
  lufs: LufsResult
  /** True peak in dBTP. */
  truePeakDb: number
}

export interface ABComparison {
  /** The user's own master integrated LUFS. */
  myLufs: number
  /** The reference integrated LUFS. */
  refLufs: number
  /** myLufs - refLufs. Positive = your master is louder. */
  deltaLu: number
  /** Gain (dB) to apply to YOUR master to match the reference loudness. */
  gainToMatchDb: number
  /** Human-readable verdict. */
  verdict: string
}

/**
 * Decode an uploaded audio file and measure its loudness.
 * Throws if the file cannot be decoded.
 */
export async function analyzeReference(
  file: File,
  ctx: AudioContext,
): Promise<ReferenceAnalysis> {
  const arrayBuffer = await file.arrayBuffer()
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer)

  const sampleRate = audioBuffer.sampleRate
  const left = audioBuffer.getChannelData(0)
  // Mono files: reuse channel 0 for the right channel.
  const right = audioBuffer.numberOfChannels > 1
    ? audioBuffer.getChannelData(1)
    : audioBuffer.getChannelData(0)

  // Copy to standalone arrays (the AudioBuffer may be GC'd / neutered).
  const leftCopy = new Float32Array(left.length)
  const rightCopy = new Float32Array(right.length)
  leftCopy.set(left)
  rightCopy.set(right)

  const lufs = measureLufs(leftCopy, rightCopy, sampleRate)
  const truePeakDb = measureTruePeak(leftCopy, rightCopy)

  return {
    name: file.name,
    durationSec: audioBuffer.duration,
    sampleRate,
    lufs,
    truePeakDb,
  }
}

/**
 * Compare the user's master loudness against the reference and compute the
 * gain needed to match. Tolerance band is +-1 LU (broadcast practice: matching
 * within 1 LU is considered loudness-matched).
 */
export function compareLoudness(myLufs: number, ref: ReferenceAnalysis): ABComparison {
  const refLufs = ref.lufs.integrated
  const deltaLu = myLufs - refLufs
  const gainToMatchDb = -deltaLu // apply this to YOUR master to reach ref level

  let verdict: string
  const absDelta = Math.abs(deltaLu)
  if (absDelta <= 1.0) {
    verdict = 'Loudness-matched (within +-1 LU). A/B comparison is fair.'
  } else if (deltaLu > 0) {
    verdict = `Your master is ${deltaLu.toFixed(1)} LU LOUDER. Apply ${gainToMatchDb.toFixed(1)} dB to match, or judge it as-is knowing louder biases "better".`
  } else {
    verdict = `Your master is ${absDelta.toFixed(1)} LU QUIETER. Apply +${absDelta.toFixed(1)} dB to match, or judge it as-is knowing quieter biases "worse".`
  }

  return { myLufs, refLufs, deltaLu, gainToMatchDb, verdict }
}
