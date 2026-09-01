/**
 * AnthemClockSync — keeps a hosted psy-anthem engine locked to the PSYBOSS
 * transport clock (the AudioWorklet master clock).
 *
 * The PSYBOSS clock publishes `transport` envelopes (bpm / beat / bar / phase /
 * playing / audioTime). This class mirrors that state and lets the host seek
 * the bus and the anthem engine together. The DeviceAdapter bridge already
 * forwards each transport envelope to the engine; this sync object is the
 * host-side position authority + seek coordinator.
 */

import type { DeviceId } from '@/psybus/types'
import { getBus } from '@/psybus/host'
import type { PsyBossAnthemAdapter } from '../adapters/psy-anthem-adapter'

export class AnthemClockSync {
  private positionBeats = 0
  private playing = false
  private bpm = 140
  private readonly unsub: () => void

  constructor(
    private readonly deviceId: DeviceId,
    private readonly seed: number,
    private readonly adapter: PsyBossAnthemAdapter,
  ) {
    const bus = getBus(seed)
    this.unsub = bus.subscribe(
      deviceId,
      (e) => e.payload.kind === 'transport',
      (e) => {
        if (e.payload.kind !== 'transport') return
        this.positionBeats = e.payload.bar * 4 + e.payload.beat + e.payload.phase
        this.playing = e.payload.playing
        this.bpm = e.payload.bpm
      },
    )
  }

  /** Current transport position in beats (mirrored from the clock). */
  getPosition(): number {
    return this.positionBeats
  }

  isPlaying(): boolean {
    return this.playing
  }

  getBpm(): number {
    return this.bpm
  }

  /** Seek the whole rig: bus + hosted anthem engine move together. */
  setPosition(positionBeats: number): void {
    this.positionBeats = Math.max(0, positionBeats)
    this.adapter.seekAnthem(this.positionBeats)
    const bus = getBus(this.seed)
    bus.publish({
      rev: bus.nextRev(),
      seed: this.seed,
      src: this.deviceId,
      dst: 'broadcast',
      ts: Date.now(),
      payload: { kind: 'transport.seek', beat: this.positionBeats },
    })
  }

  /** Stop mirroring + release the bus subscription. */
  dispose(): void {
    this.unsub()
  }
}
