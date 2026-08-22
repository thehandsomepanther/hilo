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
 *
 * In the other direction, actions are acked: PeerNetwork queues and retries
 * until the host confirms, and HostNetwork drops duplicates before they reach
 * the dispatcher.  Both sides of that live in protocol.ts.
 */

import type { GameState, Player, MultiplicationDecision } from '../src/types';
import type { BettingAction } from '../src/game';
import type { Transport, PollingMode } from './transport';
import type { BotDifficulty } from './bots/difficulty';
import {
  OutboundActionQueue, InboundActionFilter, ACTION_RETRY_TICK_MS,
} from './protocol';

// ─── Lobby types ─────────────────────────────────────────────────────────────

/**
 * `difficulty` is only meaningful on a bot slot, and is optional so a snapshot
 * from a client that predates the setting still parses.
 */
export type LobbyPlayer = { name: string; isBot: boolean; difficulty?: BotDifficulty };

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
  // Seats whose player currently has a live connection to the host, so every
  // client can show the same per-player connection indicator.
  | { type: 'connections'; v: number; payload: number[] }
  | { type: 'slotAssignment'; payload: { playerIndex: number } }
  | { type: 'proceedToSetup' }
  // Confirms receipt of a peer action so the peer can stop retrying it.
  // Consumed inside PeerNetwork; never surfaces to gameStore.
  | { type: 'ack'; actionId: string }
  // The host refused this connection a seat (see JoinRejection).
  | { type: 'rejected'; reason: JoinRejection };

/** Why a host turned a connection away.  Peers map these to user-facing copy. */
export type JoinRejection = 'game-in-progress' | 'room-full';

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

/**
 * An action on the wire, wrapped in a delivery envelope.
 * `actionId` is `<clientId>:<counter>` (see protocol.ts) — it identifies the
 * action for acks and lets the host reject duplicates from retries.
 */
export type ActionMsg = {
  type: 'action';
  actionId: string;
  /** Seat the sender believes it occupies.  Carried, not yet verified. */
  playerId: string | null;
  payload: SerializedAction;
};

/**
 * A peer's opening message, claiming an identity rather than a connection.
 * `token` persists across page loads, so the host can hand a returning player
 * back the seat they already had instead of appending a new one.  `name` is
 * only a proposal — it is used when the token is new, never to rename an
 * existing seat.
 *
 * Hello rides the same queue as actions, so it is retried until acked and is
 * always delivered before any action from the same peer.
 */
export type HelloMsg = {
  type: 'hello';
  actionId: string;
  token: string;
  name: string;
};

/** Messages sent from a peer to the host. */
export type PeerMsg = ActionMsg | HelloMsg;

/** A peer message before the outbound queue stamps it with an id. */
export type OutboundPeerMsg = Omit<ActionMsg, 'actionId'> | Omit<HelloMsg, 'actionId'>;

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
 *
 * Peer actions are deduplicated and acked here, so `onMessage` fires exactly
 * once per action no matter how many times the peer retries it.
 */
export class HostNetwork {
  private peerIds = new Set<string>();
  private inbound = new InboundActionFilter();

  onConnected: ((peerId: string) => void) | null = null;
  onDisconnected: ((peerId: string) => void) | null = null;
  onMessage: ((peerId: string, msg: PeerMsg) => void) | null = null;

  constructor(private transport: Transport) {
    transport.onPeerConnect = (peerId) => {
      this.peerIds.add(peerId);
      this.onConnected?.(peerId);
    };
    transport.onPeerClose = (peerId) => {
      this.peerIds.delete(peerId);
      this.onDisconnected?.(peerId);
    };
    transport.onMessage = (peerId, data) => {
      this.receive(peerId, decodeMsg<PeerMsg>(data));
    };
  }

  private receive(peerId: string, msg: PeerMsg): void {
    if (msg.type !== 'action' && msg.type !== 'hello') return;
    switch (this.inbound.admit(peerId, msg.actionId)) {
      case 'apply':
        // Dispatch first, ack second: the ack means "applied", and a lost one
        // costs only a redundant retry that the filter will call a duplicate.
        this.onMessage?.(peerId, msg);
        this.send(peerId, { type: 'ack', actionId: msg.actionId });
        break;
      case 'duplicate':
        // Already applied — the peer just never heard about it.
        this.send(peerId, { type: 'ack', actionId: msg.actionId });
        break;
      case 'gap':
      case 'invalid':
        break;
    }
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

  isPeerConnected(peerId: string): boolean {
    return this.peerIds.has(peerId);
  }

  setPollingMode(mode: PollingMode): void {
    this.transport.setPollingMode(mode);
  }

  /** Re-announce now — connectivity may have changed under us. */
  wake(): void {
    this.transport.wake();
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
 *
 * Actions are never dropped: `sendAction` queues, and the queue drains
 * whenever the host link is up, retrying on a timer until each action is
 * acked.  An action issued while disconnected therefore lands as soon as the
 * connection returns instead of stalling the game forever.
 */
export class PeerNetwork {
  private hostConnected = false;
  private queue: OutboundActionQueue;
  private retryTimer: ReturnType<typeof setInterval> | null = null;

  onConnected: (() => void) | null = null;
  onDisconnected: (() => void) | null = null;
  onMessage: ((msg: HostMsg) => void) | null = null;
  /** Fired whenever the unacked-action count changes (drives the UI banner). */
  onPendingChange: ((count: number) => void) | null = null;

  constructor(private transport: Transport) {
    this.queue = new OutboundActionQueue(transport.clientId);
    transport.onPeerConnect = (peerId) => {
      if (peerId !== HOST_CLIENT_ID) return;
      this.hostConnected = true;
      this.onConnected?.();
      // Anything queued while the link was down goes out immediately.
      this.queue.resetBackoff();
      this.flush();
    };
    transport.onPeerClose = (peerId) => {
      if (peerId !== HOST_CLIENT_ID) return;
      this.hostConnected = false;
      this.onDisconnected?.();
    };
    transport.onMessage = (peerId, data) => {
      if (peerId !== HOST_CLIENT_ID) return;
      const msg = decodeMsg<HostMsg>(data);
      // Acks are delivery bookkeeping — retire the action, tell no one.
      if (msg.type === 'ack') {
        if (this.queue.ack(msg.actionId)) this.onPendingChange?.(this.queue.pendingActions);
        return;
      }
      this.onMessage?.(msg);
    };
  }

  start(): void {
    this.transport.start();
    this.retryTimer ??= setInterval(() => this.flush(), ACTION_RETRY_TICK_MS);
  }

  /**
   * Claim a seat.  Must be the peer's first message; the queue guarantees the
   * host sees it before any action, and retries it until acked.
   */
  sendHello(token: string, name: string): string {
    return this.enqueue({ type: 'hello', token, name });
  }

  /** Queue an action for the host and try to send it right away. */
  sendAction(payload: SerializedAction, playerId: string | null = null): string {
    return this.enqueue({ type: 'action', playerId, payload });
  }

  private enqueue(msg: OutboundPeerMsg): string {
    const { actionId } = this.queue.enqueue(msg);
    this.onPendingChange?.(this.queue.pendingActions);
    this.flush();
    return actionId;
  }

  private flush(): void {
    if (!this.hostConnected) return;
    for (const msg of this.queue.due(Date.now())) {
      this.transport.send(HOST_CLIENT_ID, encodeMsg(msg));
    }
  }

  /** Actions sent but not yet acked.  Nonzero means "the host hasn't heard us". */
  pendingActionCount(): number {
    return this.queue.pendingActions;
  }

  isConnected(): boolean {
    return this.hostConnected;
  }

  setPollingMode(mode: PollingMode): void {
    this.transport.setPollingMode(mode);
  }

  /** Re-announce now, and flush anything the queue is holding. */
  wake(): void {
    this.transport.wake();
    this.queue.resetBackoff();
    this.flush();
  }

  close(): void {
    if (this.retryTimer !== null) { clearInterval(this.retryTimer); this.retryTimer = null; }
    this.transport.close();
    this.hostConnected = false;
  }
}
