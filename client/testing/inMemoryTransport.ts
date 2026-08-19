/**
 * inMemoryTransport.ts — test-only Transport that wires a host and N peers
 * together in-process, with fault injection.
 *
 * Faithful to the production transport's failure semantics: sending while a
 * link is down is a SILENT drop (p2pcf's send() begins with
 * `if (!peer.connected) return`), and `shouldDrop` lets tests lose individual
 * messages the same way a mid-flight disconnect would.
 *
 * Delivery is synchronous and deterministic — no timers, no reordering.
 */

import type { Transport } from '../transport';
import { HOST_CLIENT_ID } from '../network';

const dec = new TextDecoder();

export class InMemoryTransport implements Transport {
  onPeerConnect: ((peerId: string) => void) | null = null;
  onPeerClose: ((peerId: string) => void) | null = null;
  onMessage: ((peerId: string, data: Uint8Array) => void) | null = null;

  constructor(private room: InMemoryRoom, readonly clientId: string) {}

  start(): void {}

  send(peerId: string, data: Uint8Array): void {
    this.room.deliver(this.clientId, peerId, data);
  }

  broadcast(data: Uint8Array): void {
    this.room.broadcastFrom(this.clientId, data);
  }

  stopPolling(): void {}

  close(): void {
    this.room.removeParticipant(this.clientId);
  }
}

/**
 * A star-topology room: one host transport, N peer transports, and a
 * host↔peer link per peer that can be taken down and brought back up.
 *
 * Tests observe traffic either through real HostNetwork/PeerNetwork instances
 * attached to the transports, or by setting `onMessage` on a raw transport
 * directly (messages arrive as JSON-encoded Uint8Arrays; use `parse`).
 */
export class InMemoryRoom {
  readonly hostTransport: InMemoryTransport;
  private peerTransports = new Map<string, InMemoryTransport>();
  private liveLinks = new Set<string>();

  /**
   * Fault injection: return true to drop this message.  `msg` is the decoded
   * JSON payload.  Applies on top of link state — a down link drops
   * everything regardless.
   */
  shouldDrop: ((from: string, to: string, msg: unknown) => boolean) | null = null;

  constructor() {
    this.hostTransport = new InMemoryTransport(this, HOST_CLIENT_ID);
  }

  /** Create a peer transport.  The link starts down; call connectPeer. */
  addPeer(peerId: string): InMemoryTransport {
    if (peerId === HOST_CLIENT_ID) throw new Error('peer id is reserved for the host');
    if (this.peerTransports.has(peerId)) throw new Error(`duplicate peer id: ${peerId}`);
    const t = new InMemoryTransport(this, peerId);
    this.peerTransports.set(peerId, t);
    return t;
  }

  /** Bring the host↔peer link up, firing peerconnect on both sides. */
  connectPeer(peerId: string): void {
    const peer = this.mustGetPeer(peerId);
    if (this.liveLinks.has(peerId)) return;
    this.liveLinks.add(peerId);
    this.hostTransport.onPeerConnect?.(peerId);
    peer.onPeerConnect?.(HOST_CLIENT_ID);
  }

  /** Take the host↔peer link down, firing peerclose on both sides. */
  disconnectPeer(peerId: string): void {
    const peer = this.mustGetPeer(peerId);
    if (!this.liveLinks.has(peerId)) return;
    this.liveLinks.delete(peerId);
    this.hostTransport.onPeerClose?.(peerId);
    peer.onPeerClose?.(HOST_CLIENT_ID);
  }

  isLinkUp(peerId: string): boolean {
    return this.liveLinks.has(peerId);
  }

  deliver(from: string, to: string, data: Uint8Array): void {
    const linkPeerId = from === HOST_CLIENT_ID ? to : from;
    // Silent drop when the link is down — mirrors p2pcf.
    if (!this.liveLinks.has(linkPeerId)) return;
    if (this.shouldDrop?.(from, to, parse(data))) return;

    const target = to === HOST_CLIENT_ID ? this.hostTransport : this.peerTransports.get(to);
    target?.onMessage?.(from, data);
  }

  broadcastFrom(from: string, data: Uint8Array): void {
    if (from === HOST_CLIENT_ID) {
      for (const peerId of this.peerTransports.keys()) {
        this.deliver(from, peerId, data);
      }
    } else {
      this.deliver(from, HOST_CLIENT_ID, data);
    }
  }

  removeParticipant(clientId: string): void {
    if (clientId === HOST_CLIENT_ID) {
      for (const peerId of [...this.liveLinks]) this.disconnectPeer(peerId);
      return;
    }
    this.disconnectPeer(clientId);
    this.peerTransports.delete(clientId);
  }

  private mustGetPeer(peerId: string): InMemoryTransport {
    const t = this.peerTransports.get(peerId);
    if (!t) throw new Error(`unknown peer id: ${peerId}`);
    return t;
  }
}

/** Decode a wire message back to JSON for assertions. */
export function parse<T = unknown>(data: Uint8Array): T {
  return JSON.parse(dec.decode(data)) as T;
}

/**
 * Convenience for tests observing host → peer traffic without a full
 * PeerNetwork: collects every decoded message a raw transport receives.
 */
export function collectMessages<T>(transport: InMemoryTransport): T[] {
  const received: T[] = [];
  transport.onMessage = (_from, data) => { received.push(parse<T>(data)); };
  return received;
}
