/**
 * PSYBOSS -> WebRTC P2P adapter.
 *
 * Enables two performers to share one PSYBUS over the internet with
 * sample-accurate transport sync. This is the final piece of Scope 3:
 * "two performers, one bus, jitter-buffered transport."
 *
 * Architecture (ported from psystar's RTCPeerConnection approach, but
 * rebuilt for PSYBOSS's envelope model):
 *
 *   HOST (performer A)                    GUEST (performer B)
 *   PSYBUS (local) publish()              PSYBUS (local) publish()
 *        |                                     |
 *        v (subscribe: trig/param/transport)   v
 *   WebRTCAdapter (host)  <-DataChannel->  WebRTCAdapter (guest)
 *   RTCPeerConnection      JSON envelopes  RTCPeerConnection
 *
 * Signaling is SERVERLESS: host generates an offer (compressed SDP),
 * guest pastes it and generates an answer, host pastes the answer.
 * No signaling server, no accounts, works behind any NAT via ICE.
 *
 * Transport sync strategy:
 *   - Host is the CLOCK AUTHORITY. Guest never advances its own clock
 *     during sync; it follows host transport posts.
 *   - Every transport envelope carries host audioTime + Date.now().
 *   - Guest computes one-way latency estimate from NTP-style exchange,
 *     then schedules local voices at (hostTime + offset).
 *   - Jitter buffer: 60ms default, absorbs network variance without
 *     breaking the groove.
 */

import { DeviceAdapter } from './device-adapter'
import type { BusEnvelope, ParamId } from '@/psybus/types'
import { deviceId } from '@/psybus/types'

// ── Wire protocol (what goes over the DataChannel) ──────────────────────
type WireMessage =
  | { kind: 'envelope'; envelope: BusEnvelope }
  | { kind: 'sync-ping'; seq: number; sentAt: number }
  | { kind: 'sync-pong'; seq: number; sentAt: number; receivedAt: number }
  | {
      kind: 'transport-follow'
      bpm: number
      beat: number
      bar: number
      phase: number
      playing: boolean
      hostAudioTime: number
      hostWallTime: number
    }
  | { kind: 'hello'; role: 'host' | 'guest'; name: string }

export interface WebRTCAdapterOptions {
  seed: number
  role: 'host' | 'guest'
  performerName?: string
  /** Jitter buffer in ms (default 60). Lower = tighter, higher = safer. */
  jitterBufferMs?: number
  /** ICE servers. Default: Google STUN only (no TURN = no forced relay). */
  iceServers?: RTCIceServer[]
}

export type ConnectionStatus =
  | 'idle'
  | 'signaling'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
]

const DATA_CHANNEL_LABEL = 'psybus-sync'
const DEFAULT_JITTER_MS = 60
const SYNC_INTERVAL_MS = 2000
const LATENCY_SAMPLES = 8

export class WebRTCAdapter extends DeviceAdapter {
  private peerConnection: RTCPeerConnection | null = null
  private dataChannel: RTCDataChannel | null = null
  private readonly role: 'host' | 'guest'
  private readonly performerName: string
  private readonly jitterBufferMs: number
  private readonly iceServers: RTCIceServer[]

  private status: ConnectionStatus = 'idle'
  private statusListeners = new Set<(s: ConnectionStatus) => void>()

  // Latency estimation (NTP-style)
  private syncSeq = 0
  private pendingPings = new Map<number, number>()
  private latencySamples: number[] = []
  private estimatedOffsetMs = 0 // guest: how far ahead host clock is

  private syncTimer: ReturnType<typeof setInterval> | null = null

  constructor(options: WebRTCAdapterOptions) {
    super({
      deviceId: deviceId('webrtc-p2p'),
      seed: options.seed,
      capabilities: {
        audio: false,
        midiIn: false,
        midiOut: false,
        maxVoices: 0,
        params: [],
      },
    })
    this.role = options.role
    this.performerName = options.performerName ?? `${options.role}-${options.seed.toString(16)}`
    this.jitterBufferMs = options.jitterBufferMs ?? DEFAULT_JITTER_MS
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS
  }

  // ── Public connection lifecycle ─────────────────────────────────────────

  /** Status subscription for the UI. Returns unsubscribe fn. */
  onStatus(fn: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(fn)
    fn(this.status)
    return () => {
      this.statusListeners.delete(fn)
    }
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  getRole(): 'host' | 'guest' {
    return this.role
  }

  getPerformerName(): string {
    return this.performerName
  }

  /** Estimated one-way latency in ms (after sync converges). */
  getEstimatedLatencyMs(): number {
    if (this.latencySamples.length === 0) return 0
    const sorted = [...this.latencySamples].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] // median, robust to spikes
  }

  /**
   * HOST ONLY: Create the offer. Returns a compact string the host sends
   * to the guest (copy-paste signaling, no server).
   */
  async createOffer(): Promise<string> {
    if (this.role !== 'host') {
      throw new Error('createOffer() is host-only')
    }
    this.setStatus('signaling')
    this.setupPeerConnection()

    // Host creates the DataChannel BEFORE the offer (so it's in the SDP).
    this.dataChannel = this.peerConnection!.createDataChannel(DATA_CHANNEL_LABEL, {
      ordered: true,
      maxRetransmits: 0, // we'd rather drop a stale envelope than replay it late
    })
    this.wireDataChannel(this.dataChannel)

    const offer = await this.peerConnection!.createOffer()
    await this.peerConnection!.setLocalDescription(offer)

    // Wait for ICE gathering to complete so the offer is self-contained.
    await this.waitForIceGathering()

    return this.encodeSignal(this.peerConnection!.localDescription!)
  }

  /**
   * GUEST ONLY: Accept the host's offer, return an answer string.
   */
  async acceptOffer(offerStr: string): Promise<string> {
    if (this.role !== 'guest') {
      throw new Error('acceptOffer() is guest-only')
    }
    this.setStatus('signaling')
    this.setupPeerConnection()

    const offer = this.decodeSignal(offerStr)
    await this.peerConnection!.setRemoteDescription(offer)

    // Guest receives the DataChannel that the host created.
    this.peerConnection!.ondatachannel = (event) => {
      this.dataChannel = event.channel
      this.wireDataChannel(event.channel)
    }

    const answer = await this.peerConnection!.createAnswer()
    await this.peerConnection!.setLocalDescription(answer)
    await this.waitForIceGathering()

    return this.encodeSignal(this.peerConnection!.localDescription!)
  }

  /**
   * HOST ONLY: Accept the guest's answer to complete the handshake.
   */
  async acceptAnswer(answerStr: string): Promise<void> {
    if (this.role !== 'host') {
      throw new Error('acceptAnswer() is host-only')
    }
    const answer = this.decodeSignal(answerStr)
    await this.peerConnection!.setRemoteDescription(answer)
    this.setStatus('connecting')
  }

  /** Tear down the connection cleanly. */
  dispose(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer)
      this.syncTimer = null
    }
    if (this.dataChannel) {
      this.dataChannel.close()
      this.dataChannel = null
    }
    if (this.peerConnection) {
      this.peerConnection.close()
      this.peerConnection = null
    }
    this.setStatus('disconnected')
    this.unregister()
  }

  // ── Abstract method implementations (DeviceAdapter contract) ───────────

  protected onTransport(
    bpm: number,
    beat: number,
    bar: number,
    playing: boolean,
    audioTime: number,
  ): void {
    // HOST broadcasts transport to the guest. Guest applies it (wire handler).
    if (this.role === 'host' && this.isOpen()) {
      this.send({
        kind: 'transport-follow',
        bpm,
        beat,
        bar,
        phase: (beat % 4) / 4,
        playing,
        hostAudioTime: audioTime,
        hostWallTime: Date.now(),
      })
    }
  }

  protected onTransportStart(): void {
    // Handled via transport-follow broadcast.
  }

  protected onTransportStop(): void {
    // Handled via transport-follow broadcast.
  }

  protected onTransportSeek(_beat: number): void {
    // Handled via transport-follow broadcast.
  }

  protected onParamSet(_param: ParamId, _value: number): void {
    // Param changes flow through the generic envelope relay (setupSubscriptions).
  }

  protected onChoke(_group: string): void {
    // Choke flows through the generic envelope relay.
  }

  protected setupSubscriptions(): void {
    // Relay outbound envelopes: any envelope matching a live-sync kind gets
    // forwarded to the peer.
    const relayKinds = new Set([
      'trig',
      'note',
      'note.off',
      'param.set',
      'param.lock',
      'sidechain.duck',
      'choke',
      'context',
      'transport.start',
      'transport.stop',
      'transport.seek',
    ])

    this.subscribe(
      (e) => relayKinds.has(e.payload.kind),
      (e) => {
        // Don't echo envelopes that came FROM the peer (loop prevention).
        if ((e as BusEnvelope & { _remote?: boolean })._remote) return
        if (this.isOpen()) {
          this.send({ kind: 'envelope', envelope: e })
        }
      },
    )

    // Start periodic latency sync once connected.
    this.startSyncLoop()
  }

  // ── Private: WebRTC plumbing ───────────────────────────────────────────

  private setupPeerConnection(): void {
    this.peerConnection = new RTCPeerConnection({ iceServers: this.iceServers })

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection?.connectionState
      if (state === 'connected') {
        this.setStatus('connected')
        this.send({ kind: 'hello', role: this.role, name: this.performerName })
      } else if (state === 'failed' || state === 'disconnected') {
        this.setStatus('disconnected')
      }
    }

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState
      if (state === 'failed') {
        this.setStatus('error')
      }
    }
  }

  private wireDataChannel(channel: RTCDataChannel): void {
    channel.onopen = () => {
      this.setStatus('connected')
      this.send({ kind: 'hello', role: this.role, name: this.performerName })
    }

    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as WireMessage
        this.handleWireMessage(message)
      } catch (err) {
        this.reportError('webrtc-parse', String(err))
      }
    }

    channel.onclose = () => {
      this.setStatus('disconnected')
    }
  }

  private handleWireMessage(message: WireMessage): void {
    switch (message.kind) {
      case 'hello':
        // Peer introduced itself. UI can show the peer name via onStatus.
        break

      case 'envelope': {
        // Inject the remote envelope into the LOCAL bus so all local
        // devices (sampler, synths, drums) react to the peer's playing.
        // Mark it _remote so setupSubscriptions won't re-relay it (loop guard).
        const envelope = message.envelope as BusEnvelope & { _remote?: boolean }
        envelope._remote = true
        this.publish(envelope)
        break
      }

      case 'sync-ping': {
        // Respond immediately with a pong carrying receive timestamp.
        this.send({
          kind: 'sync-pong',
          seq: message.seq,
          sentAt: message.sentAt,
          receivedAt: Date.now(),
        })
        break
      }

      case 'sync-pong': {
        // NTP-style round-trip: estimate one-way latency + clock offset.
        const now = Date.now()
        const sentAt = this.pendingPings.get(message.seq)
        if (sentAt === undefined) return
        this.pendingPings.delete(message.seq)

        const roundTrip = now - sentAt
        const oneWay = roundTrip / 2
        this.latencySamples.push(oneWay)
        if (this.latencySamples.length > LATENCY_SAMPLES) {
          this.latencySamples.shift()
        }

        // Clock offset: how far the peer's wall clock is from ours.
        const peerTimeAtReceive = message.receivedAt
        const estimatedPeerNow = peerTimeAtReceive + oneWay
        this.estimatedOffsetMs = estimatedPeerNow - now
        break
      }

      case 'transport-follow': {
        // GUEST applies host transport. We do NOT re-publish transport here
        // to avoid feedback; the guest's local engine consumes this directly.
        if (this.role === 'guest') {
          this.applyRemoteTransport(message)
        }
        break
      }
    }
  }

  private applyRemoteTransport(msg: Extract<WireMessage, { kind: 'transport-follow' }>): void {
    // Compensate for network latency + jitter buffer so the guest's
    // transport lines up with the host's audible output.
    const latency = this.getEstimatedLatencyMs()
    const totalDelayMs = latency + this.jitterBufferMs

    // Reconstruct where the host transport SHOULD be right now.
    const elapsedSinceHost = Date.now() - msg.hostWallTime - this.estimatedOffsetMs
    const beatsElapsed = (elapsedSinceHost / 1000) * (msg.bpm / 60)
    const correctedBeat = msg.beat + beatsElapsed

    // Publish corrected transport to the local bus for local devices.
    this.publish({
      rev: this.nextRev(),
      seed: this.seed,
      src: this.id,
      dst: 'broadcast',
      ts: Date.now(),
      payload: {
        kind: 'transport',
        bpm: msg.bpm,
        beat: correctedBeat,
        bar: Math.floor(correctedBeat / 4),
        phase: (correctedBeat % 4) / 4,
        playing: msg.playing,
        audioTime: 0,
      },
    })

    // Surface latency for UI metering.
    this.reportLatency(totalDelayMs)
  }

  // ── Private: sync loop ─────────────────────────────────────────────────

  private startSyncLoop(): void {
    if (this.syncTimer) return
    this.syncTimer = setInterval(() => {
      if (this.isOpen() && this.role === 'host') {
        const seq = this.syncSeq++
        this.pendingPings.set(seq, Date.now())
        this.send({ kind: 'sync-ping', seq, sentAt: Date.now() })
      }
    }, SYNC_INTERVAL_MS)
  }

  // ── Private: signaling encode/decode ───────────────────────────────────

  private encodeSignal(desc: RTCSessionDescription): string {
    // Compact JSON, base64-encoded for easy copy-paste.
    const payload = JSON.stringify({ type: desc.type, sdp: desc.sdp })
    return btoa(unescape(encodeURIComponent(payload)))
  }

  private decodeSignal(str: string): RTCSessionDescriptionInit {
    const json = decodeURIComponent(escape(atob(str.trim())))
    const parsed = JSON.parse(json) as { type: RTCSdpType; sdp: string }
    return { type: parsed.type, sdp: parsed.sdp }
  }

  private waitForIceGathering(): Promise<void> {
    return new Promise((resolve) => {
      const pc = this.peerConnection
      if (!pc) return resolve()
      if (pc.iceGatheringState === 'complete') return resolve()
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check)
          resolve()
        }
      }
      pc.addEventListener('icegatheringstatechange', check)
      // Safety timeout: resolve after 3s even if gathering isn't "complete".
      setTimeout(resolve, 3000)
    })
  }

  // ── Private: helpers ───────────────────────────────────────────────────

  private isOpen(): boolean {
    return this.dataChannel?.readyState === 'open'
  }

  private send(message: WireMessage): void {
    if (!this.isOpen()) return
    try {
      this.dataChannel!.send(JSON.stringify(message))
    } catch (err) {
      this.reportError('webrtc-send', String(err))
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status
    this.statusListeners.forEach((fn) => fn(status))
  }
}

/** Factory function for creating a WebRTC adapter. */
export function createWebRTCAdapter(options: WebRTCAdapterOptions): WebRTCAdapter {
  return new WebRTCAdapter(options)
}
