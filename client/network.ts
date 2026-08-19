/**
 * network.ts — message-level networking: wire types plus the HostNetwork /
 * PeerNetwork classes that speak them.
 *
 * Both classes sit on top of a byte-level `Transport` (see transport.ts).
 * Production injects a p2pcf-backed transport (WebRTC data channels with
 * Cloudflare Worker signalling); tests inject an in-memory transport with
 * fault injection.
 *
 * Authority model: the host runs the full game engine and broadcasts
 * GameState snapshots to all peers.  Peers forward serialized actions to the
 * host.
 *
 * State-bearing host messages (`state`, `pendingDecision`, `lobby`) carry a
 * per-type monotonic version `v` (see protocol.ts) so the host can safely
 * rebroadcast snapshots — peers drop stale/duplicate versions.
 */

import type { GameState, Player, MultiplicationDecision } from '../src/types';
import type { BettingAction } from '../src/game';
import type { Transport } from './transport';

// ─── Lobby types ─────────────────────────────────────────────────────────────

export type LobbyPlayer = { name: string; isBot: boolean };

export type LobbyState = {
  players: LobbyPlayer[];
  startingChips: number;
  enforceTimeLimit: boolean;
};

// ─── Wire message types ───────────────────────────────────────────────────────

/**
 * Messages sent from the host to every peer.
 * `v` is a per-message-type monotonic version — peers ignore any message whose
 * version is ≤ the last one they applied for that type.
 */
export type HostMsg =
  | { type: 'state'; v: number; payload: GameState }
  | { type: 'pendingDecision'; v: number; payload: { player: Player } | null }
  | { type: 'lobby'; v: number; payload: LobbyState }
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
  | { name: 'setPlayerReady'; args: [string] };

/** Messages sent from a peer to the host. */
export type PeerMsg = { type: 'action'; payload: SerializedAction };

// ─── Encoding helpers ─────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeMsg(msg: HostMsg | PeerMsg): Uint8Array {
  return enc.encode(JSON.stringify(msg));
}

export function decodeMsg<T extends HostMsg | PeerMsg>(data: Uint8Array): T {
  return JSON.parse(dec.decode(data)) as T;
}

// ─── Room / client IDs ───────────────────────────────────────────────────────

// Unambiguous characters only (no O/0/I/1).
const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The fixed client id the host joins the room under. */
export const HOST_CLIENT_ID = 'host';

export function generateRoomId(): string {
  return Array.from(
    { length: 6 },
    () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)],
  ).join('');
}

/** Random client id for a peer (host is always HOST_CLIENT_ID). */
export function generateClientId(): string {
  return Array.from(
    { length: 8 },
    () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)],
  ).join('');
}

// ─── HostNetwork ─────────────────────────────────────────────────────────────

/**
 * Host-side network.  The host's transport client id is always
 * HOST_CLIENT_ID so peers can identify it unambiguously in the mesh.
 */
export class HostNetwork {
  private peerIds = new Set<string>();

  onConnected: ((peerId: string) => void) | null = null;
  onMessage: ((peerId: string, msg: PeerMsg) => void) | null = null;

  constructor(private transport: Transport) {
    transport.onPeerConnect = (peerId) => {
      this.peerIds.add(peerId);
      this.onConnected?.(peerId);
    };
    transport.onPeerClose = (peerId) => {
      this.peerIds.delete(peerId);
    };
    transport.onMessage = (peerId, data) => {
      this.onMessage?.(peerId, decodeMsg<PeerMsg>(data));
    };
  }

  start(): void {
    this.transport.start();
  }

  send(peerId: string, msg: HostMsg): void {
    if (this.peerIds.has(peerId)) this.transport.send(peerId, encodeMsg(msg));
  }

  broadcast(msg: HostMsg): void {
    this.transport.broadcast(encodeMsg(msg));
  }

  getPeerIds(): string[] {
    return [...this.peerIds];
  }

  getConnectedPeerIds(): string[] {
    return [...this.peerIds];
  }

  stopPolling(): void {
    this.transport.stopPolling();
  }

  close(): void {
    this.transport.close();
    this.peerIds.clear();
  }
}

// ─── PeerNetwork ─────────────────────────────────────────────────────────────

/**
 * Peer-side network.  Ignores every mesh participant except the one whose
 * client id is HOST_CLIENT_ID.
 */
export class PeerNetwork {
  private hostConnected = false;

  onConnected: (() => void) | null = null;
  onMessage: ((msg: HostMsg) => void) | null = null;

  constructor(private transport: Transport) {
    transport.onPeerConnect = (peerId) => {
      if (peerId === HOST_CLIENT_ID) {
        this.hostConnected = true;
        this.onConnected?.();
      }
    };
    transport.onPeerClose = (peerId) => {
      if (peerId === HOST_CLIENT_ID) this.hostConnected = false;
    };
    transport.onMessage = (peerId, data) => {
      if (peerId === HOST_CLIENT_ID) this.onMessage?.(decodeMsg<HostMsg>(data));
    };
  }

  start(): void {
    this.transport.start();
  }

  send(msg: PeerMsg): void {
    if (this.hostConnected) this.transport.send(HOST_CLIENT_ID, encodeMsg(msg));
  }

  isConnected(): boolean {
    return this.hostConnected;
  }

  stopPolling(): void {
    this.transport.stopPolling();
  }

  close(): void {
    this.transport.close();
    this.hostConnected = false;
  }
}
