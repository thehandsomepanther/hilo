/**
 * transport.ts — the raw byte-level transport abstraction under HostNetwork /
 * PeerNetwork.
 *
 * Production uses P2pcfTransport (see p2pcfTransport.ts), which wraps a p2pcf
 * mesh.  Tests use InMemoryTransport (see testing/inMemoryTransport.ts), which
 * wires host and peers together in-process with injectable message loss and
 * link failures.
 *
 * Semantics mirror p2pcf: `send`/`broadcast` are fire-and-forget and are
 * SILENTLY DROPPED when the target link is down.  The message layer above is
 * responsible for healing (versioned snapshots + heartbeat).
 */

export interface Transport {
  /** This participant's own id in the mesh (HOST_CLIENT_ID for the host). */
  readonly clientId: string;

  /** Fired when a remote peer's data channel opens. */
  onPeerConnect: ((peerId: string) => void) | null;
  /** Fired when a remote peer's data channel closes. */
  onPeerClose: ((peerId: string) => void) | null;
  /** Fired for every message received from a remote peer. */
  onMessage: ((peerId: string, data: Uint8Array) => void) | null;

  start(): void;
  /** Fire-and-forget send to one peer.  Silently dropped if the link is down. */
  send(peerId: string, data: Uint8Array): void;
  /** Fire-and-forget send to every connected peer. */
  broadcast(data: Uint8Array): void;
  /** Stop signalling-server polling (no-op for transports without polling). */
  stopPolling(): void;
  close(): void;
}
