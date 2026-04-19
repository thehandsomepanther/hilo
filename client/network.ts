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
 *
 * GameState is broadcast directly (including embedded RoundResult when in the
 * results phase) — no separate roundResult message is needed.
 */

import type { GameState, Player, MultiplicationDecision } from '../src/types';
import type { BettingAction } from '../src/game';

// ─── Lobby types ─────────────────────────────────────────────────────────────

export type LobbyPlayer = { name: string; isBot: boolean };

export type LobbyState = {
  players: LobbyPlayer[];
  startingChips: number;
  forcedBetAmount: number;
};

// ─── Wire message types ───────────────────────────────────────────────────────

/** Messages sent from the host to every peer. */
export type HostMsg =
  | { type: 'state'; payload: GameState }
  | { type: 'pendingDecision'; payload: { player: Player } | null }
  | { type: 'lobby'; payload: LobbyState }
  | { type: 'slotAssignment'; payload: { playerIndex: number } };

/**
 * All game actions a peer can invoke, serialised for network transport.
 * Maps 1-to-1 with exported functions in gameStore.ts.
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
  | { name: 'updateLobbyName';     args: [number, string] }
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

  onConnected: ((peerId: string) => void) | null = null;
  onMessage: ((peerId: string, msg: PeerMsg) => void) | null = null;

  async createOffer(peerId: string): Promise<string> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const channel = pc.createDataChannel('game', { ordered: true });
    this.peers.set(peerId, { conn: pc, channel, connected: false });

    channel.onmessage = (e) => {
      if (this.onMessage) this.onMessage(peerId, JSON.parse(e.data as string) as PeerMsg);
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

  async acceptAnswer(peerId: string, answerBlob: string): Promise<void> {
    const entry = this.peers.get(peerId);
    if (!entry) throw new Error(`Unknown peer: ${peerId}`);
    await entry.conn.setRemoteDescription(blobToSdp(answerBlob));
  }

  send(peerId: string, msg: HostMsg): void {
    const entry = this.peers.get(peerId);
    if (entry?.channel.readyState === 'open') entry.channel.send(JSON.stringify(msg));
  }

  broadcast(msg: HostMsg): void {
    const data = JSON.stringify(msg);
    for (const { channel } of this.peers.values()) {
      if (channel.readyState === 'open') channel.send(data);
    }
  }

  getConnectedPeerIds(): string[] {
    return [...this.peers.entries()].filter(([, e]) => e.connected).map(([id]) => id);
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

  onConnected: (() => void) | null = null;
  onMessage: ((msg: HostMsg) => void) | null = null;

  async connect(offerBlob: string): Promise<string> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.conn = pc;

    pc.ondatachannel = (e) => {
      this.channel = e.channel;
      e.channel.onmessage = (me) => {
        if (this.onMessage) this.onMessage(JSON.parse(me.data as string) as HostMsg);
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

  send(msg: PeerMsg): void {
    if (this.channel?.readyState === 'open') this.channel.send(JSON.stringify(msg));
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
