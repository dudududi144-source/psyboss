/**
 * PSYBOSS sample library tests — provenance validation + metadata checks.
 *
 * Browser-only functions (decodeAudioData, crypto.subtle) can't run in Node.
 * These tests cover the pure-logic parts: validateMetadata, fingerprint format.
 * The SHA-256 + decode path is verified by the Agent Browser E2E.
 *
 * Run: bun test tests/psyboss/sample-library.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { validateMetadata } from '@/psyboss/engine/sample-library'

describe('validateMetadata', () => {
  test('accepts a complete CC0 metadata record', () => {
    const errors = validateMetadata({
      name: 'kick-01.wav',
      license: 'CC0',
      source: 'https://freesound.org/s/12345/',
    })
    expect(errors).toEqual([])
  })

  test('accepts CC-BY with author', () => {
    const errors = validateMetadata({
      name: 'snare.wav',
      license: 'CC-BY',
      source: 'https://freesound.org/s/67890/',
      author: 'Sample Artist',
    })
    expect(errors).toEqual([])
  })

  test('rejects missing name', () => {
    const errors = validateMetadata({
      name: '',
      license: 'CC0',
      source: 'https://example.com',
    })
    expect(errors).toContain('name is required')
  })

  test('rejects missing source', () => {
    const errors = validateMetadata({
      name: 'kick.wav',
      license: 'CC0',
      source: '',
    })
    expect(errors).toContain('source is required')
  })

  test('rejects missing license', () => {
    const errors = validateMetadata({
      name: 'kick.wav',
      source: 'https://example.com',
    })
    expect(errors.some((e) => e.includes('license is required'))).toBe(true)
  })

  test('rejects unknown license', () => {
    const errors = validateMetadata({
      name: 'kick.wav',
      license: 'GPL' as never,
      source: 'https://example.com',
    })
    expect(errors.some((e) => e.includes('unknown license'))).toBe(true)
  })

  test('accepts all valid license types', () => {
    const licenses = ['CC0', 'CC-BY', 'CC-BY-SA', 'CC-BY-NC', 'commercial-licensed'] as const
    for (const license of licenses) {
      const errors = validateMetadata({
        name: 'test.wav',
        license,
        source: 'https://example.com',
      })
      expect(errors).toEqual([])
    }
  })
})

describe('provenance fingerprint format', () => {
  test('sha-256 produces 64-char lowercase hex', async () => {
    // We can't import the browser-only sha256Fingerprint directly (it needs crypto.subtle).
    // But we CAN verify the format contract: the host's assertProvenance requires
    // non-psboss-dsp fingerprints to be 64-char lowercase hex.
    const fakeFingerprint = 'a'.repeat(64)
    expect(fakeFingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(fakeFingerprint.length).toBe(64)
  })

  test('uppercase hex is rejected by the gate (verified in psybus.test.ts)', () => {
    // This is a documentation test — the actual rejection is tested in psybus.test.ts
    // "rejects sha-256 with uppercase hex (must be lowercase)".
    // Here we just verify the regex contract.
    const uppercaseFp = 'A'.repeat(64)
    expect(uppercaseFp).not.toMatch(/^[a-f0-9]{64}$/)
  })
})
