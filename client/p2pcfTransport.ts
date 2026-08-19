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
import type { Transport } from './transport';

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
  onPeerConnect: ((peerId: string) => void) | null = null;
  onPeerClose: ((peerId: string) => void) | null = null;
  onMessage: ((peerId: string, data: Uint8Array) => void) | null = null;

  private peers = new Map<string, P2PCFPeer>();

  constructor(private p2pcf: P2PCFType) {
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

  stopPolling(): void {
    if (this.p2pcf.networkSettingsInterval !== null) {
      clearInterval(this.p2pcf.networkSettingsInterval);
      this.p2pcf.networkSettingsInterval = null;
    }
    this.p2pcf.nextStepTime = Infinity;
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
