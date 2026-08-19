/**
 * p2pcfTransport.ts — production Transport backed by p2pcf (WebRTC data
 * channels with a Cloudflare Worker signalling server).
 *
 * p2pcf imports browser-only modules at load time, so this file must only be
 * imported from browser code paths.  gameStore loads it with a dynamic
 * `import()` inside setupAsHost/setupAsPeer, keeping the test import graph
 * (and Node) free of it.
 */

import type P2PCFType from 'p2pcf';
import type { P2PCFPeer } from 'p2pcf';
import type { Transport, PollingMode } from './transport';

/**
 * Signalling rate once a game is underway and everyone is connected.  Slow
 * enough that the Cloudflare Worker sees almost no traffic, but the room stays
 * discoverable so a peer that drops can rejoin.  When anyone *is* missing,
 * gameStore switches back to 'active'.
 */
const IDLE_POLLING_RATE_MS = 45000;

// ─── ICE servers ─────────────────────────────────────────────────────────────

const STUN_ONLY: RTCIceServer[] = [
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

/**
 * Fetch TURN credentials from the signalling worker's /turn-creds endpoint.
 * Falls back to STUN-only if the worker URL is unknown or the request fails.
 */
export async function fetchIceServers(workerUrl?: string): Promise<RTCIceServer[]> {
  if (!workerUrl) return STUN_ONLY;
  try { new URL(workerUrl); } catch { return STUN_ONLY; }
  try {
    const res = await fetch(`${workerUrl}/turn-creds`);
    if (!res.ok) return STUN_ONLY;
    const turnServers = await res.json() as RTCIceServer[];
    return turnServers.length > 0 ? [...STUN_ONLY, ...turnServers] : STUN_ONLY;
  } catch {
    return STUN_ONLY;
  }
}

// ─── Transport implementation ────────────────────────────────────────────────

class P2pcfTransport implements Transport {
  readonly clientId: string;

  onPeerConnect: ((peerId: string) => void) | null = null;
  onPeerClose: ((peerId: string) => void) | null = null;
  onMessage: ((peerId: string, data: Uint8Array) => void) | null = null;

  private peers = new Map<string, P2PCFPeer>();

  constructor(private p2pcf: P2PCFType) {
    this.clientId = p2pcf.clientId;
    this.p2pcf.on('peerconnect', (peer) => {
      this.peers.set(peer.client_id, peer);
      this.onPeerConnect?.(peer.client_id);
    });
    this.p2pcf.on('peerclose', (peer) => {
      this.peers.delete(peer.client_id);
      this.onPeerClose?.(peer.client_id);
    });
    this.p2pcf.on('msg', (peer, data) => {
      this.onMessage?.(peer.client_id, new Uint8Array(data));
    });
  }

  start(): void {
    this.p2pcf.start().catch((e) => console.error('[P2pcfTransport] start error', e));
  }

  send(peerId: string, data: Uint8Array): void {
    const peer = this.peers.get(peerId);
    if (peer) this.p2pcf.send(peer, data);
  }

  broadcast(data: Uint8Array): void {
    this.p2pcf.broadcast(data);
  }

  /**
   * p2pcf re-reads these fields off the instance on every step, so flipping
   * them at runtime moves the room between polling tiers.  Both the step loop
   * and the network-change watcher keep running either way — they are what
   * recovers a dropped connection, and p2pcf grants itself 10s of fast polling
   * automatically whenever the peer set changes.
   */
  setPollingMode(mode: PollingMode): void {
    const now = Date.now();
    if (mode === 'idle') {
      this.p2pcf.idlePollingAfterMs = 0;
      this.p2pcf.idlePollingRateMs = IDLE_POLLING_RATE_MS;
      this.p2pcf.startIdlePollingAt = now;
    } else {
      this.p2pcf.idlePollingAfterMs = Infinity;
      this.p2pcf.startIdlePollingAt = Infinity;
      // Cut short any idle-length wait already scheduled.
      this.p2pcf.nextStepTime = Math.min(this.p2pcf.nextStepTime, now);
    }
  }

  close(): void {
    this.p2pcf.destroy();
    this.peers.clear();
  }
}

/**
 * Build a p2pcf-backed transport.  Fetches TURN credentials from the worker
 * (if configured), then joins the room under the given client id.
 */
export async function createP2pcfTransport(
  clientId: string,
  roomId: string,
  workerUrl?: string,
): Promise<Transport> {
  const iceServers = await fetchIceServers(workerUrl);
  const { default: P2PCF } = await import('p2pcf');
  const p2pcf = new P2PCF(clientId, roomId, {
    workerUrl,
    stunIceServers: iceServers,
    turnIceServers: iceServers,
    fastPollingRateMs: 2000,
    slowPollingRateMs: 8000,
    networkChangePollIntervalMs: 30000,
  });
  return new P2pcfTransport(p2pcf);
}
