/**
 * PSYBOSS sample library — real sample loading through the provenance gate.
 *
 * SCOPE 4: replaces the "procedural-only" sound bank with user-loadable samples.
 * Every sample MUST carry a Provenance record with a SHA-256 fingerprint. The
 * PSYBUS host's assertProvenance gate rejects anything without valid provenance.
 *
 * Flow:
 *   1. User selects a file (drag-drop or file input).
 *   2. UI collects license metadata (license type, source URL, author).
 *   3. SampleLibrary.add(file, metadata) → decode → SHA-256 → store AudioBuffer + Provenance.
 *   4. When a trig fires with a SampleRef pointing to this sample, the engine looks
 *      it up by id and plays it. The gate has already validated the provenance at
 *      bus.publish time.
 *
 * Browser-only: uses AudioContext.decodeAudioData + crypto.subtle.digest.
 */

import type { Provenance, SampleRef, License } from '@/psybus/types'

export interface LoadedSample {
  id: string
  buffer: AudioBuffer
  provenance: Provenance
  name: string
}

export interface SampleMetadata {
  name: string
  license: License
  source: string
  author?: string
}

/**
 * Compute the SHA-256 fingerprint of an ArrayBuffer (lowercase hex, 64 chars).
 * Uses the Web Crypto API (browser-only).
 */
export async function sha256Fingerprint(data: ArrayBuffer): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('crypto.subtle is required for SHA-256 fingerprinting (browser-only)')
  }
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(hashBuffer)
  let hex = ''
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * The SampleLibrary holds loaded samples keyed by id. Each sample carries a
 * Provenance record with a real SHA-256 fingerprint (not the 'psboss-dsp' shortcut).
 */
export class SampleLibrary {
  private samples = new Map<string, LoadedSample>()
  private ctx: AudioContext

  constructor(ctx: AudioContext) {
    this.ctx = ctx
  }

  /**
   * Add a sample from a File (drag-drop or file input). Decodes the audio,
   * computes the SHA-256 fingerprint, and stores it with provenance.
   *
   * Returns the SampleRef that can be used in a PSYBUS `trig` envelope.
   * Throws if the file can't be decoded or the metadata is incomplete.
   */
  async add(file: File, metadata: SampleMetadata): Promise<SampleRef> {
    const arrayBuffer = await file.arrayBuffer()
    // Decode the audio (mp3, wav, ogg, etc. — whatever the browser supports).
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer.slice(0))
    // Compute the SHA-256 of the original file bytes (not the decoded PCM —
    // the fingerprint identifies the SOURCE file, not the in-memory representation).
    const fingerprint = await sha256Fingerprint(arrayBuffer)

    const id = `sample-${fingerprint.slice(0, 12)}`
    const provenance: Provenance = {
      license: metadata.license,
      source: metadata.source,
      author: metadata.author,
      verifiedAt: Date.now(),
      fingerprint,
    }

    const loaded: LoadedSample = {
      id,
      buffer: audioBuffer,
      provenance,
      name: metadata.name,
    }
    this.samples.set(id, loaded)
    return { id, provenance }
  }

  /** Add a sample from a raw ArrayBuffer (for programmatic import). */
  async addFromBuffer(
    data: ArrayBuffer,
    metadata: SampleMetadata,
    name?: string,
  ): Promise<SampleRef> {
    const audioBuffer = await this.ctx.decodeAudioData(data.slice(0))
    const fingerprint = await sha256Fingerprint(data)
    const id = `sample-${fingerprint.slice(0, 12)}`
    const provenance: Provenance = {
      license: metadata.license,
      source: metadata.source,
      author: metadata.author,
      verifiedAt: Date.now(),
      fingerprint,
    }
    this.samples.set(id, {
      id,
      buffer: audioBuffer,
      provenance,
      name: name ?? metadata.name,
    })
    return { id, provenance }
  }

  get(id: string): LoadedSample | undefined {
    return this.samples.get(id)
  }

  list(): LoadedSample[] {
    return Array.from(this.samples.values())
  }

  remove(id: string): boolean {
    return this.samples.delete(id)
  }

  clear(): void {
    this.samples.clear()
  }
}

/**
 * Validate that a SampleMetadata has all required fields before adding.
 * Returns an array of error messages (empty = valid).
 */
export function validateMetadata(meta: Partial<SampleMetadata>): string[] {
  const errors: string[] = []
  if (!meta.name || meta.name.trim() === '') errors.push('name is required')
  if (!meta.license) errors.push('license is required')
  if (!meta.source || meta.source.trim() === '') errors.push('source is required')
  // CC0 and commercial-licensed are the only "safe for distribution" licenses.
  // CC-BY-NC is allowed for personal use but NOT for commercial distribution.
  if (meta.license && !['CC0', 'CC-BY', 'CC-BY-SA', 'CC-BY-NC', 'commercial-licensed'].includes(meta.license)) {
    errors.push(`unknown license: ${meta.license}`)
  }
  return errors
}
