/**
 * lanTransport.ts — a Transport for two devices on the same network with no
 * internet, introduced by QR code instead of by a signalling server.
 *
 * It plugs into the same seam the in-memory test transport uses: both
 * `setupAsHost` and `setupAsPeer` accept an injected Transport, so nothing in
 * gameStore, network.ts or protocol.ts changes. Versioned snapshots, the acked
 * action queue, seat identity by token and the heartbeat all work unmodified —
 * none of them know how the bytes arrive.
 *
 * Two members of the interface are necessarily no-ops here. `setPollingMode`
 * and `wake` modulate p2pcf's signalling poll, and once the QR exchange is done
 * there is no signalling channel left to modulate. That costs less than it
 * sounds: a brief drop still heals itself, because ICE recovers a
 * `disconnected` connection without re-signalling and the message layer resyncs
 * on the next heartbeat. What it does cost is a page reload — the connection
 * dies with the page and only a fresh QR exchange can rebuild it. The seat
 * survives (sessionStorage keeps the token, and `handleHello` hands the same
 * seat back), so a rescan resumes the game rather than restarting it.
 */

import type { Transport, PollingMode } from './transport';
import { HOST_CLIENT_ID, generateClientId } from './network';
import { encodePayload, decodePayload } from './lanSignal';
import type { LanPayload } from './lanSignal';

const CHANNEL_LABEL = 'hilo';

/**
 * How long to wait for ICE gathering before sending what we have.  Gathering
 * host candidates off a local interface is near-instant; this only guards
 * against a browser that never reports `complete`.
 */
const GATHER_TIMEOUT_MS = 3000;

/** No STUN, no TURN: on one subnet the only useful candidates are host ones,
 *  and an unreachable STUN server just delays gathering. */
const LAN_ONLY: RTCConfiguration = { iceServers: [] };

/**
 * Ask for the camera, then immediately hand it back.
 *
 * This is not about video — it is what makes the connection work at all.  By
 * default Chrome hides local IPs behind mDNS `.local` candidate hostnames,
 * which the far side can only use if multicast DNS is working; phone hotspots
 * and locked-down access points routinely drop multicast, which is precisely
 * the situation this feature exists for.  Holding camera permission switches
 * the browser to publishing real local IPs, measured:
 *
 *     camera NOT granted → 2 candidates — 2 mDNS .local, 0 real IPv4
 *     camera GRANTED     → 4 candidates — 0 mDNS,        2 real IPv4 (+ IPv6)
 *
 * The QR scanner needs the camera regardless, so this costs nothing extra —
 * but the ORDER is load-bearing: permission must be held *before* the offer or
 * answer is created, because candidates are gathered then.  Prime it first and
 * the SDP carries real addresses; prime it after and it carries mDNS names and
 * the permission was pointless.
 *
 * Failure is not fatal — mDNS candidates still work on plenty of networks — so
 * a refused camera degrades to "might not connect" rather than stopping here.
 * (The scanner will ask again anyway, and report its own error.)
 */
export async function unmaskLocalCandidates(): Promise<void> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    // Left masked; see above.
  }
}

function gatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    };
    const onChange = () => { if (pc.iceGatheringState === 'complete') done(); };
    const timer = setTimeout(done, GATHER_TIMEOUT_MS);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/** Shared connection bookkeeping for both ends. */
abstract class LanTransportBase implements Transport {
  abstract readonly clientId: string;

  onPeerConnect: ((peerId: string) => void) | null = null;
  onPeerClose: ((peerId: string) => void) | null = null;
  onMessage: ((peerId: string, data: Uint8Array) => void) | null = null;

  protected connections = new Map<string, { pc: RTCPeerConnection; dc: RTCDataChannel }>();

  /** Connections are established by the QR exchange, not by start(). */
  start(): void {}

  send(peerId: string, data: Uint8Array): void {
    const dc = this.connections.get(peerId)?.dc;
    // Fire-and-forget, dropped when the link is down — the semantics the
    // message layer above already expects and heals from.
    // `slice()` hands the channel a buffer of its own; the caller's view may be
    // a window onto a larger (or shared) buffer, which send() won't take.
    if (dc?.readyState === 'open') dc.send(data.slice().buffer as ArrayBuffer);
  }

  broadcast(data: Uint8Array): void {
    for (const peerId of this.connections.keys()) this.send(peerId, data);
  }

  /** No signalling channel to modulate once the QR exchange is done. */
  setPollingMode(_mode: PollingMode): void {}

  /** Nothing to re-announce to: there is no room to be discovered in. */
  wake(): void {}

  close(): void {
    for (const { pc, dc } of this.connections.values()) {
      dc.onopen = dc.onclose = dc.onmessage = null;
      pc.onconnectionstatechange = null;
      dc.close();
      pc.close();
    }
    this.connections.clear();
  }

  /** True once this peer's data channel is open. */
  isConnected(peerId: string): boolean {
    return this.connections.get(peerId)?.dc.readyState === 'open';
  }

  protected register(peerId: string, pc: RTCPeerConnection, dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    this.connections.set(peerId, { pc, dc });

    const closed = () => {
      if (this.connections.has(peerId)) this.onPeerClose?.(peerId);
    };

    dc.onopen = () => this.onPeerConnect?.(peerId);
    dc.onclose = closed;
    dc.onmessage = (e: MessageEvent) => {
      const data = e.data as ArrayBuffer | string;
      const bytes = typeof data === 'string'
        ? new TextEncoder().encode(data)
        : new Uint8Array(data);
      this.onMessage?.(peerId, bytes);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closed();
    };

    // A channel can already be open by the time we attach (the peer answers
    // into a channel the host opened), and no event will replay for us.
    if (dc.readyState === 'open') this.onPeerConnect?.(peerId);
  }
}

// ─── Host ─────────────────────────────────────────────────────────────────────

/**
 * Host side.  One RTCPeerConnection per player, each needing its own two-scan
 * exchange, so the invite is generated once per player rather than once per
 * game.
 */
export class LanHostTransport extends LanTransportBase {
  readonly clientId = HOST_CLIENT_ID;

  /** The connection an invite has been shown for, awaiting its answer. */
  private pending: { pc: RTCPeerConnection; dc: RTCDataChannel } | null = null;

  constructor(private readonly sessionId: string) {
    super();
  }

  /**
   * Build an offer for the next player and return the text to put in a QR
   * code.  Call `unmaskLocalCandidates()` before this, not after.
   */
  async createInvite(): Promise<string> {
    this.discardPending();

    const pc = new RTCPeerConnection(LAN_ONLY);
    const dc = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    await pc.setLocalDescription(await pc.createOffer());
    await gatheringComplete(pc);

    this.pending = { pc, dc };
    return encodePayload({
      v: 1,
      t: 'offer',
      s: this.sessionId,
      sdp: pc.localDescription?.sdp ?? '',
    });
  }

  /** Take the answer scanned back off the player's screen.  Returns their id. */
  async acceptAnswer(text: string): Promise<string> {
    const payload = await decodePayload(text);
    if (payload.t !== 'answer') {
      throw new Error("That's an invite code, not a player's reply.");
    }
    if (payload.s !== this.sessionId) {
      throw new Error('That reply belongs to a different game.');
    }
    if (!this.pending) {
      throw new Error('No invite is waiting for a reply — show a new one first.');
    }

    const { pc, dc } = this.pending;
    this.pending = null;
    await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
    this.register(payload.c, pc, dc);
    return payload.c;
  }

  private discardPending(): void {
    if (!this.pending) return;
    this.pending.dc.close();
    this.pending.pc.close();
    this.pending = null;
  }

  override close(): void {
    this.discardPending();
    super.close();
  }
}

// ─── Peer ─────────────────────────────────────────────────────────────────────

/**
 * Peer side.  Exactly one connection, registered under HOST_CLIENT_ID because
 * PeerNetwork ignores every peer whose id is not that.
 */
export class LanPeerTransport extends LanTransportBase {
  readonly clientId = generateClientId();

  /**
   * Answer the host's invite.  Returns the text for the QR code to show back.
   * The camera is already granted by this point — the offer was scanned with
   * it — so candidates come out as real addresses.
   */
  async acceptInvite(text: string): Promise<string> {
    const payload = await decodePayload(text);
    if (payload.t !== 'offer') {
      throw new Error("That's a player's reply, not an invite code.");
    }

    const pc = new RTCPeerConnection(LAN_ONLY);
    // The host opens the channel; ours arrives with the connection.
    pc.ondatachannel = (e) => this.register(HOST_CLIENT_ID, pc, e.channel);

    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await gatheringComplete(pc);

    return encodePayload({
      v: 1,
      t: 'answer',
      s: payload.s,
      c: this.clientId,
      sdp: pc.localDescription?.sdp ?? '',
    });
  }
}

/** Read a scanned code far enough to route it, without building a connection. */
export async function peekPayload(text: string): Promise<LanPayload> {
  return decodePayload(text);
}
