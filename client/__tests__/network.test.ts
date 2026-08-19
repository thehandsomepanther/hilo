/**
 * Message-layer tests: HostNetwork / PeerNetwork over an in-memory transport.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HostNetwork, PeerNetwork, encodeMsg } from '../network';
import type { HostMsg, PeerMsg } from '../network';
import { InMemoryRoom } from '../testing/inMemoryTransport';

const stateMsg = (v: number): HostMsg =>
  ({ type: 'pendingDecision', v, payload: null });
const actionMsg: PeerMsg = { type: 'action', payload: { name: 'doForcedBets' } };

describe('HostNetwork / PeerNetwork over InMemoryRoom', () => {
  let room: InMemoryRoom;
  let host: HostNetwork;
  let peer: PeerNetwork;

  beforeEach(() => {
    room = new InMemoryRoom();
    host = new HostNetwork(room.hostTransport);
    peer = new PeerNetwork(room.addPeer('p1'));
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
    peer.send(actionMsg);

    expect(peerReceived.map((m) => (m.type === 'pendingDecision' ? m.v : -1))).toEqual([1, 2]);
    expect(hostReceived).toEqual([actionMsg]);
  });

  it('silently drops sends while the link is down — the failure mode the sync layer must heal', () => {
    const hostReceived: PeerMsg[] = [];
    const peerReceived: HostMsg[] = [];
    host.onMessage = (_pid, msg) => hostReceived.push(msg);
    peer.onMessage = (msg) => peerReceived.push(msg);

    // Never connected: everything is dropped without error.
    host.broadcast(stateMsg(1));
    peer.send(actionMsg);
    expect(peerReceived).toEqual([]);
    expect(hostReceived).toEqual([]);

    // Connected, then dropped mid-game: same.
    room.connectPeer('p1');
    room.disconnectPeer('p1');
    host.broadcast(stateMsg(2));
    peer.send(actionMsg);
    expect(peerReceived).toEqual([]);
    expect(hostReceived).toEqual([]);
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
