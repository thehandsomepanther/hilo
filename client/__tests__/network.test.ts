/**
 * Message-layer tests: HostNetwork / PeerNetwork over an in-memory transport.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HostNetwork, PeerNetwork, encodeMsg } from '../network';
import type { HostMsg, PeerMsg, SerializedAction } from '../network';
import { ACTION_RETRY_BASE_MS } from '../protocol';
import { InMemoryRoom } from '../testing/inMemoryTransport';

const stateMsg = (v: number): HostMsg =>
  ({ type: 'pendingDecision', v, payload: null });
const forcedBets: SerializedAction = { name: 'doForcedBets' };

describe('HostNetwork / PeerNetwork over InMemoryRoom', () => {
  let room: InMemoryRoom;
  let host: HostNetwork;
  let peer: PeerNetwork;

  beforeEach(() => {
    vi.useFakeTimers();
    room = new InMemoryRoom();
    host = new HostNetwork(room.hostTransport);
    peer = new PeerNetwork(room.addPeer('p1'));
    peer.start();
  });

  afterEach(() => {
    peer.close();
    vi.useRealTimers();
  });

  it('tracks connection state on both sides', () => {
    expect(peer.isConnected()).toBe(false);
    expect(host.getPeerIds()).toEqual([]);

    room.connectPeer('p1');
    expect(peer.isConnected()).toBe(true);
    expect(host.getPeerIds()).toEqual(['p1']);

    room.disconnectPeer('p1');
    expect(peer.isConnected()).toBe(false);
    expect(host.getPeerIds()).toEqual([]);
  });

  it('round-trips messages in both directions', () => {
    const hostReceived: PeerMsg[] = [];
    const peerReceived: HostMsg[] = [];
    host.onMessage = (_pid, msg) => hostReceived.push(msg);
    peer.onMessage = (msg) => peerReceived.push(msg);
    room.connectPeer('p1');

    host.broadcast(stateMsg(1));
    host.send('p1', stateMsg(2));
    peer.sendAction(forcedBets, 'player-1');

    expect(peerReceived.map((m) => (m.type === 'pendingDecision' ? m.v : -1))).toEqual([1, 2]);
    expect(hostReceived).toEqual([
      { type: 'action', actionId: 'p1:1', playerId: 'player-1', payload: forcedBets },
    ]);
  });

  it('acks a delivered action, and never surfaces the ack to the peer app layer', () => {
    const peerReceived: HostMsg[] = [];
    peer.onMessage = (msg) => peerReceived.push(msg);
    room.connectPeer('p1');

    peer.sendAction(forcedBets);
    expect(peer.pendingActionCount()).toBe(0); // acked synchronously
    expect(peerReceived).toEqual([]);          // the ack was consumed internally
  });

  it('silently drops host → peer sends while the link is down — the sync layer heals those', () => {
    const peerReceived: HostMsg[] = [];
    peer.onMessage = (msg) => peerReceived.push(msg);

    host.broadcast(stateMsg(1));
    room.connectPeer('p1');
    room.disconnectPeer('p1');
    host.broadcast(stateMsg(2));
    expect(peerReceived).toEqual([]);
  });

  it('queues peer → host actions while the link is down and delivers them on reconnect', () => {
    const hostReceived: PeerMsg[] = [];
    host.onMessage = (_pid, msg) => hostReceived.push(msg);

    // Never connected: queued, not dropped.
    peer.sendAction(forcedBets);
    peer.sendAction({ name: 'doNextRound' });
    expect(hostReceived).toEqual([]);
    expect(peer.pendingActionCount()).toBe(2);

    room.connectPeer('p1');
    expect(hostReceived.map((m) => m.payload.name)).toEqual(['doForcedBets', 'doNextRound']);
    expect(peer.pendingActionCount()).toBe(0);
  });

  it('retries an action the host never received until it lands', () => {
    const hostReceived: PeerMsg[] = [];
    host.onMessage = (_pid, msg) => hostReceived.push(msg);
    room.connectPeer('p1');

    room.shouldDrop = () => true;
    peer.sendAction(forcedBets);
    expect(hostReceived).toEqual([]);
    expect(peer.pendingActionCount()).toBe(1);

    room.shouldDrop = null;
    vi.advanceTimersByTime(ACTION_RETRY_BASE_MS);
    expect(hostReceived.map((m) => m.payload.name)).toEqual(['doForcedBets']);
    expect(peer.pendingActionCount()).toBe(0);
  });

  it('applies a retried action exactly once when the ack is what got lost', () => {
    const hostReceived: PeerMsg[] = [];
    host.onMessage = (_pid, msg) => hostReceived.push(msg);
    room.connectPeer('p1');

    // The action lands, the ack does not.
    room.shouldDrop = (_from, _to, msg) => (msg as HostMsg).type === 'ack';
    peer.sendAction(forcedBets);
    expect(hostReceived).toHaveLength(1);
    expect(peer.pendingActionCount()).toBe(1); // peer still believes it's unsent

    // Retries reach the host but must not be dispatched a second time.
    vi.advanceTimersByTime(ACTION_RETRY_BASE_MS * 4);
    expect(hostReceived).toHaveLength(1);

    // Once an ack gets through, the peer stops retrying.
    room.shouldDrop = null;
    vi.advanceTimersByTime(ACTION_RETRY_BASE_MS * 4);
    expect(hostReceived).toHaveLength(1);
    expect(peer.pendingActionCount()).toBe(0);
  });

  it('a peer ignores non-host mesh participants', () => {
    const t = room.addPeer('p2');
    const p2 = new PeerNetwork(t);
    const received: HostMsg[] = [];
    p2.onMessage = (msg) => received.push(msg);

    // Simulate another (non-host) participant appearing in the p2pcf mesh by
    // firing the transport callbacks directly.
    t.onPeerConnect?.('some-other-peer');
    expect(p2.isConnected()).toBe(false);
    t.onMessage?.('some-other-peer', encodeMsg(stateMsg(9)));
    expect(received).toEqual([]);
  });

  it('sending to an unknown peer id is a no-op, not a throw', () => {
    room.connectPeer('p1');
    expect(() => host.send('nonexistent', stateMsg(1))).not.toThrow();
  });
});
