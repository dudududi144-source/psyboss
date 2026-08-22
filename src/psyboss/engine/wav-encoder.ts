/**
 * PSYBOSS WAV encoder — 16-bit PCM stereo, byte-identical output.
 *
 * Ported from psystar/src/engine/wav-encoder.ts (audited worklog.md AUDIT-A §psystar).
 * Used by the offline renderer to export master + stems.
 *
 * Format: RIFF/WAVE, PCM 16-bit, stereo, little-endian. 44-byte header.
 */

export interface WavInput {
  left: Float32Array
  right: Float32Array
  sampleRate: number
}

export function wavByteLength(numFrames: number): number {
  return 44 + Math.max(0, Math.floor(numFrames)) * 4
}

function floatTo16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value))
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
}

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i))
  }
}

export function encodeWav(input: WavInput): Uint8Array {
  const numChannels = 2
  const sampleRate = Math.max(1, Math.floor(input.sampleRate))
  const numFrames = Math.min(input.left.length, input.right.length)
  const bytesPerSample = 2
  const blockAlign = numChannels * bytesPerSample
  const dataSize = numFrames * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  writeString(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(view, 8, 'WAVE')
  writeString(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true) // bits per sample
  writeString(view, 36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < numFrames; i++) {
    view.setInt16(offset, floatTo16(input.left[i]), true)
    offset += 2
    view.setInt16(offset, floatTo16(input.right[i]), true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

/** Trigger a browser download of a WAV blob. Client-only. */
export function downloadWav(bytes: Uint8Array, filename: string): void {
  if (typeof window === 'undefined') return
  // Copy into a fresh ArrayBuffer to satisfy BlobPart's ArrayBufferView<ArrayBuffer> type.
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  const blob = new Blob([copy], { type: 'audio/wav' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
