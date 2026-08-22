/**
 * PSYBOSS WAV encoder tests — verify byte-format correctness.
 *
 * Run: bun test tests/psyboss/wav-encoder.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { encodeWav, wavByteLength } from '@/psyboss/engine/wav-encoder'

describe('WAV encoder', () => {
  test('header is correct RIFF/WAVE/PCM 16-bit stereo', () => {
    const left = new Float32Array(100)
    const right = new Float32Array(100)
    const bytes = encodeWav({ left, right, sampleRate: 48000 })

    // RIFF header
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE')
    // fmt chunk
    expect(String.fromCharCode(...bytes.slice(12, 16))).toBe('fmt ')
    expect(new DataView(bytes.buffer).getUint32(16, true)).toBe(16) // fmt chunk size
    expect(new DataView(bytes.buffer).getUint16(20, true)).toBe(1) // PCM
    expect(new DataView(bytes.buffer).getUint16(22, true)).toBe(2) // stereo
    expect(new DataView(bytes.buffer).getUint32(24, true)).toBe(48000) // sample rate
    expect(new DataView(bytes.buffer).getUint16(34, true)).toBe(16) // bits per sample
    // data chunk
    expect(String.fromCharCode(...bytes.slice(36, 40))).toBe('data')
  })

  test('byte length = 44 header + 4 bytes per frame', () => {
    const n = 1000
    const left = new Float32Array(n)
    const right = new Float32Array(n)
    const bytes = encodeWav({ left, right, sampleRate: 48000 })
    expect(bytes.length).toBe(44 + n * 4)
    expect(bytes.length).toBe(wavByteLength(n))
  })

  test('float-to-16 conversion: 1.0 → 0x7FFF, -1.0 → 0x8000, 0 → 0', () => {
    const left = new Float32Array([1.0, -1.0, 0.0, 0.5, -0.5])
    const right = new Float32Array([1.0, -1.0, 0.0, 0.5, -0.5])
    const bytes = encodeWav({ left, right, sampleRate: 48000 })
    const view = new DataView(bytes.buffer)
    // First frame: left=1.0 → 0x7FFF, right=1.0 → 0x7FFF
    expect(view.getInt16(44, true)).toBe(0x7fff)
    expect(view.getInt16(46, true)).toBe(0x7fff)
    // Second frame: left=-1.0 → 0x8000, right=-1.0 → 0x8000
    expect(view.getInt16(48, true)).toBe(-0x8000) // DataView returns signed
    expect(view.getInt16(50, true)).toBe(-0x8000)
    // Third frame: 0, 0
    expect(view.getInt16(52, true)).toBe(0)
    expect(view.getInt16(54, true)).toBe(0)
  })

  test('clamps out-of-range floats to [-1, 1]', () => {
    const left = new Float32Array([2.0, -2.0, 1.5])
    const right = new Float32Array([2.0, -2.0, 1.5])
    const bytes = encodeWav({ left, right, sampleRate: 48000 })
    const view = new DataView(bytes.buffer)
    // 2.0 clamps to 1.0 → 0x7FFF
    expect(view.getInt16(44, true)).toBe(0x7fff)
    // -2.0 clamps to -1.0 → 0x8000
    expect(view.getInt16(48, true)).toBe(-0x8000)
  })

  test('deterministic: same input → same bytes', () => {
    const left = new Float32Array([0.1, 0.2, 0.3, -0.4, 0.5])
    const right = new Float32Array([0.5, -0.4, 0.3, 0.2, 0.1])
    const a = encodeWav({ left, right, sampleRate: 48000 })
    const b = encodeWav({ left, right, sampleRate: 48000 })
    expect(a).toEqual(b)
  })

  test('handles empty input (0 frames)', () => {
    const bytes = encodeWav({ left: new Float32Array(0), right: new Float32Array(0), sampleRate: 48000 })
    expect(bytes.length).toBe(44) // header only
  })
})
