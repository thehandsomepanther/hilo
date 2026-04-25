/**
 * network.ts — WebRTC networking via p2pcf (Cloudflare Worker signalling).
 *
 * Peers discover each other automatically by sharing a short room code.
 * No manual SDP blob exchange is required.
 *
 * Authority model is unchanged: the host runs the full game engine and
 * broadcasts GameState to all peers.  Peers forward serialized actions
 * to the host.
 */

import P2PCF from 'p2pcf';
import type { P2PCFPeer } from 'p2pcf';
import type { GameState, Player, MultiplicationDecision } from '../src/types';
import type { BettingAction } from '../src/game';

// ─── Lobby types ─────────────────────────────────────────────────────────────

export type LobbyPlayer = { name: string; isBot: boolean };

export type LobbyState = {
  players: LobbyPlayer[];
  startingChips: number;
  enforceTimeLimit: boolean;
};

// ─── Wire message types ───────────────────────────────────────────────────────

/** Messages sent from the host to every peer. */
export type HostMsg =
  | { type: 'state'; payload: GameState }
  | { type: 'pendingDecision'; payload: { player: Player } | null }
  | { type: 'lobby'; payload: LobbyState }
  | { type: 'slotAssignment'; payload: { playerIndex: number } }
  | { type: 'proceedToSetup' };

/**
 * All game actions a peer can invoke, serialised for network transport.
 * Maps 1-to-1 with exported functions in gameStore.ts.
 */
export type SerializedAction =
  | { name: 'initGame'; args: [string[], number, boolean] }
  | { name: 'doForcedBets' }
  | { name: 'doDeal'; args: [1 | 2] }
  | { name: 'doBettingAction'; args: [BettingAction] }
  | { name: 'submitEquation'; args: [string, 'low' | 'high', string] }
  | { name: 'unsubmitEquation'; args: [string, 'low' | 'high'] }
  | { name: 'doAdvanceToBetting2' }
  | { name: 'doSubmitBetChoices'; args: [Record<string, 'high' | 'low' | 'swing' | null>] }
  | { name: 'doNextRound' }
  | { name: 'resolveDecision'; args: [MultiplicationDecision] }
  | { name: 'updateLobbyName'; args: [number, string] }
  | { name: 'submitMyBetChoice'; args: [string, 'high' | 'low' | 'swing'] }
  | { name: 'setPlayerReady';    args: [string] };

/** Messages sent from a peer to the host. */
export type PeerMsg = { type: 'action'; payload: SerializedAction };

// ─── Encoding helpers ─────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function encode(s: string): Uint8Array { return enc.encode(s); }
function decode(b: ArrayBuffer): string { return dec.decode(b); }

// ─── Room ID ──────────────────────────────────────────────────────────────────

// Unambiguous characters only (no O/0/I/1).
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomId(): string {
  return Array.from(
    { length: 6 },
    () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)],
  ).join('');
}

// ─── HostNetwork ─────────────────────────────────────────────────────────────

/**
 * Host-side network.  The host's p2pcf client_id is always 'host' so peers
 * can identify it unambiguously in the mesh.
 */
export class HostNetwork {
  private p2pcf: P2PCF;
  private peers = new Map<string, P2PCFPeer>();

  onConnected: ((peerId: string) => void) | null = null;
  onMessage: ((peerId: string, msg: PeerMsg) => void) | null = null;

  constructor(roomId: string, workerUrl?: string) {
    this.p2pcf = new P2PCF('host', roomId, {
      workerUrl,
      fastPollingRateMs: 2000,
      slowPollingRateMs: 8000,
      networkChangePollIntervalMs: 30000,
    });

    this.p2pcf.on('peerconnect', (peer) => {
      this.peers.set(peer.client_id, peer);
      this.onConnected?.(peer.client_id);
    });

    this.p2pcf.on('peerclose', (peer) => {
      this.peers.delete(peer.client_id);
    });

    this.p2pcf.on('msg', (peer, data) => {
      const msg = JSON.parse(decode(data)) as PeerMsg;
      this.onMessage?.(peer.client_id, msg);
    });
  }

  start(): void {
    this.p2pcf.start().catch((e) => console.error('[HostNetwork] start error', e));
  }

  send(peerId: string, msg: HostMsg): void {
    const peer = this.peers.get(peerId);
    if (peer) this.p2pcf.send(peer, encode(JSON.stringify(msg)));
  }

  broadcast(msg: HostMsg): void {
    this.p2pcf.broadcast(encode(JSON.stringify(msg)));
  }

  getPeerIds(): string[] {
    return [...this.peers.keys()];
  }

  getConnectedPeerIds(): string[] {
    return [...this.peers.keys()];
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

// ─── PeerNetwork ─────────────────────────────────────────────────────────────

/**
 * Peer-side network.  Each peer gets a random client_id; it discovers the
 * host by looking for the peer whose client_id is 'host'.
 */
export class PeerNetwork {
  private p2pcf: P2PCF;
  private hostPeer: P2PCFPeer | null = null;

  onConnected: (() => void) | null = null;
  onMessage: ((msg: HostMsg) => void) | null = null;

  constructor(roomId: string, workerUrl?: string) {
    const clientId = Array.from(
      { length: 8 },
      () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)],
    ).join('');

    this.p2pcf = new P2PCF(clientId, roomId, {
      workerUrl,
      fastPollingRateMs: 2000,
      slowPollingRateMs: 8000,
      networkChangePollIntervalMs: 30000,
    });

    this.p2pcf.on('peerconnect', (peer) => {
      if (peer.client_id === 'host') {
        this.hostPeer = peer;
        this.onConnected?.();
      }
    });

    this.p2pcf.on('peerclose', (peer) => {
      if (peer.client_id === 'host') this.hostPeer = null;
    });

    this.p2pcf.on('msg', (peer, data) => {
      if (peer.client_id === 'host') {
        const msg = JSON.parse(decode(data)) as HostMsg;
        this.onMessage?.(msg);
      }
    });
  }

  start(): void {
    this.p2pcf.start().catch((e) => console.error('[PeerNetwork] start error', e));
  }

  send(msg: PeerMsg): void {
    if (this.hostPeer) this.p2pcf.send(this.hostPeer, encode(JSON.stringify(msg)));
  }

  isConnected(): boolean {
    return this.hostPeer !== null;
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
    this.hostPeer = null;
  }
}
