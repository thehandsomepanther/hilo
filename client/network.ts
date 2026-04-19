/**
 * network.ts — WebRTC data-channel networking with manual (out-of-band) signaling.
 *
 * No signaling server is involved.  Instead:
 *   1. The host generates one RTCPeerConnection per joining peer and waits for
 *      ICE gathering to finish before exposing the local description as a
 *      base-64 blob the host can share however they like (text, QR code, etc.).
 *   2. Each peer pastes that blob, creates an answer (also waiting for gathering),
 *      and sends the answer blob back to the host.
 *   3. The host applies the answer — the data channel opens and the game is live.
 *
 * All communication after that happens over RTCDataChannel messages.
 */

import type { GameState, Player, MultiplicationDecision, RoundResult } from '../src/types';
import type { BettingAction } from '../src/game';

// ─── Lobby types ─────────────────────────────────────────────────────────────

/** One entry in the pre-game lobby — just the player's chosen name. */
export type LobbyPlayer = { name: string };

/**
 * Shared pre-game state that all clients mirror before `initGame` is called.
 * The host is the source of truth; peers receive updates via the 'lobby' message.
 */
export type LobbyState = {
  players: LobbyPlayer[];
  startingChips: number;
  forcedBetAmount: number;
};

// ─── Serialization helpers ────────────────────────────────────────────────────

/**
 * RoundResult uses a Map<string,number> for payouts which doesn't survive
 * JSON.stringify.  We wire it as a plain object instead.
 */
export type PlainRoundResult = {
  lowWinnerId: string | null;
  highWinnerId: string | null;
  payouts: Record<string, number>;
};

export function serializeRoundResult(r: RoundResult): PlainRoundResult {
  return { ...r, payouts: Object.fromEntries(r.payouts) };
}

export function deserializeRoundResult(r: PlainRoundResult): RoundResult {
  return { ...r, payouts: new Map(Object.entries(r.payouts).map(([k, v]) => [k, v])) };
}

// ─── Wire message types ───────────────────────────────────────────────────────

/** Messages sent from the host to every peer. */
export type HostMsg =
  | { type: 'state'; payload: GameState }
  | { type: 'roundResult'; payload: PlainRoundResult | null }
  /** Tells peers that a × card decision is pending for this player. */
  | { type: 'pendingDecision'; payload: { player: Player } | null }
  /** Full lobby snapshot — sent on every lobby change and on initial peer connect. */
  | { type: 'lobby'; payload: LobbyState }
  /** Tells the connecting peer which slot index they own. */
  | { type: 'slotAssignment'; payload: { playerIndex: number } };

/**
 * A serialisable representation of every game action a peer can invoke.
 * Maps 1-to-1 with the exported functions in gameStore.ts.
 */
export type SerializedAction =
  | { name: 'initGame';            args: [string[], number, number] }
  | { name: 'doForcedBets' }
  | { name: 'doDeal';              args: [1 | 2] }
  | { name: 'doBettingAction';     args: [BettingAction] }
  | { name: 'submitEquation';      args: [string, 'low' | 'high', string] }
  | { name: 'unsubmitEquation';    args: [string, 'low' | 'high'] }
  | { name: 'doAdvanceToBetting2' }
  | { name: 'doSubmitBetChoices';  args: [Record<string, 'high' | 'low' | 'swing' | null>] }
  | { name: 'doNextRound' }
  | { name: 'resolveDecision';     args: [MultiplicationDecision] }
  /** Peer requests a name change for their own lobby slot. */
  | { name: 'updateLobbyName';     args: [number, string] }
  /** Peer submits their own bet choice (networked play, one player at a time). */
  | { name: 'submitMyBetChoice';   args: [string, 'high' | 'low' | 'swing'] };

/** Messages sent from a peer to the host. */
export type PeerMsg = { type: 'action'; payload: SerializedAction };

// ─── ICE / SDP helpers ───────────────────────────────────────────────────────

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

function sdpToBlob(sdp: RTCSessionDescriptionInit): string {
  return btoa(JSON.stringify(sdp));
}

function blobToSdp(blob: string): RTCSessionDescriptionInit {
  return JSON.parse(atob(blob)) as RTCSessionDescriptionInit;
}

/** Resolves once ICE gathering reaches 'complete'. */
function waitForGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    const handler = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', handler);
  });
}

// ─── HostNetwork ─────────────────────────────────────────────────────────────

interface PeerEntry {
  conn: RTCPeerConnection;
  channel: RTCDataChannel;
  connected: boolean;
}

export class HostNetwork {
  private peers = new Map<string, PeerEntry>();

  /** Fires when a peer's data channel opens (connection established). */
  onConnected: ((peerId: string) => void) | null = null;

  /** Fires when a peer sends an action message. */
  onMessage: ((peerId: string, msg: PeerMsg) => void) | null = null;

  /**
   * Create an RTCPeerConnection for `peerId`, generate an offer, wait for
   * all ICE candidates, then return the bundled offer as a base-64 blob.
   */
  async createOffer(peerId: string): Promise<string> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channel = pc.createDataChannel('game', { ordered: true });

    this.peers.set(peerId, { conn: pc, channel, connected: false });

    channel.onmessage = (e) => {
      if (this.onMessage) {
        this.onMessage(peerId, JSON.parse(e.data as string) as PeerMsg);
      }
    };
    channel.onopen = () => {
      const entry = this.peers.get(peerId);
      if (entry) entry.connected = true;
      if (this.onConnected) this.onConnected(peerId);
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitForGathering(pc);
    return sdpToBlob(pc.localDescription!);
  }

  /** Apply a peer's answer blob to complete the handshake. */
  async acceptAnswer(peerId: string, answerBlob: string): Promise<void> {
    const entry = this.peers.get(peerId);
    if (!entry) throw new Error(`Unknown peer: ${peerId}`);
    await entry.conn.setRemoteDescription(blobToSdp(answerBlob));
  }

  /** Send a message to one specific peer. */
  send(peerId: string, msg: HostMsg): void {
    const entry = this.peers.get(peerId);
    if (entry?.channel.readyState === 'open') {
      entry.channel.send(JSON.stringify(msg));
    }
  }

  /** Broadcast a message to all connected peers. */
  broadcast(msg: HostMsg): void {
    const data = JSON.stringify(msg);
    for (const { channel } of this.peers.values()) {
      if (channel.readyState === 'open') channel.send(data);
    }
  }

  getConnectedPeerIds(): string[] {
    return [...this.peers.entries()]
      .filter(([, e]) => e.connected)
      .map(([id]) => id);
  }

  getPeerIds(): string[] {
    return [...this.peers.keys()];
  }

  close(): void {
    for (const { conn } of this.peers.values()) conn.close();
    this.peers.clear();
  }
}

// ─── PeerNetwork ─────────────────────────────────────────────────────────────

export class PeerNetwork {
  private conn: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;

  /** Fires when the data channel to the host opens. */
  onConnected: (() => void) | null = null;

  /** Fires when a message arrives from the host. */
  onMessage: ((msg: HostMsg) => void) | null = null;

  /**
   * Accept the host's offer blob, generate an answer, wait for ICE gathering,
   * and return the answer as a base-64 blob to send back to the host.
   */
  async connect(offerBlob: string): Promise<string> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.conn = pc;

    pc.ondatachannel = (e) => {
      this.channel = e.channel;
      e.channel.onmessage = (me) => {
        if (this.onMessage) {
          this.onMessage(JSON.parse(me.data as string) as HostMsg);
        }
      };
      e.channel.onopen = () => {
        if (this.onConnected) this.onConnected();
      };
    };

    await pc.setRemoteDescription(blobToSdp(offerBlob));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForGathering(pc);
    return sdpToBlob(pc.localDescription!);
  }

  /** Send an action to the host. */
  send(msg: PeerMsg): void {
    if (this.channel?.readyState === 'open') {
      this.channel.send(JSON.stringify(msg));
    }
  }

  isConnected(): boolean {
    return this.channel?.readyState === 'open';
  }

  close(): void {
    this.conn?.close();
    this.conn = null;
    this.channel = null;
  }
}
