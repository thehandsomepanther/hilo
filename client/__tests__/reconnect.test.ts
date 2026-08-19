/**
 * Phase 3 tests: seat identity, reconnection, and signalling rates.
 *
 * The host runs the real gameStore over an in-memory transport.  Remote
 * players are raw transports that speak the wire protocol directly, which lets
 * a test do the one thing a PeerNetwork can't: come back under a *different*
 * transport id, the way a browser tab does when it reloads.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  gameState, lobbyState, connectedSeats, hostLinkUp, joinRejected, queuedActionCount,
  seatOnline, myPlayerIndex, networkMode,
  setupAsHost, setupAsPeer, hostProceed, addBot, removePlayer, doForcedBets, _resetNetworkForTests,
  HOST_SILENCE_TIMEOUT_MS,
} from '../gameStore';
import type { HostMsg } from '../network';
import { HEARTBEAT_INTERVAL_MS } from '../protocol';
import {
  InMemoryRoom, InMemoryTransport, collectMessages, sayHello,
} from '../testing/inMemoryTransport';
import { createGame, startRound } from '../../src/game';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { _resetNetworkForTests(); vi.useRealTimers(); });

const lobbyNames = () => get(lobbyState).players.map((p) => p.name);
const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];
const slotOf = (received: HostMsg[]): number | undefined =>
  last(received.filter((m) => m.type === 'slotAssignment'))?.payload.playerIndex;

// ─── Host: seats and reclamation ─────────────────────────────────────────────

describe('host seat assignment', () => {
  let room: InMemoryRoom;

  /** Bring up a peer connection and collect what the host sends it. */
  function join(peerId: string, token: string, name = ''): HostMsg[] {
    const transport = room.addPeer(peerId);
    const received = collectMessages<HostMsg>(transport);
    room.connectPeer(peerId);
    sayHello(transport, token, name);
    return received;
  }

  beforeEach(async () => {
    room = new InMemoryRoom();
    await setupAsHost('TESTROOM', undefined, room.hostTransport);
  });

  it('grants a seat on hello, not on connecting', () => {
    const transport = room.addPeer('p1');
    const received = collectMessages<HostMsg>(transport);
    room.connectPeer('p1');

    // A bare connection is anonymous: no seat, no lobby slot.
    expect(lobbyNames()).toHaveLength(1);
    expect(received).toEqual([]);

    sayHello(transport, 'token-ada', 'Ada');
    expect(lobbyNames()).toEqual(['', 'Ada']);
    expect(slotOf(received)).toBe(1);
  });

  it('seats each new token in its own slot', () => {
    join('p1', 'token-ada', 'Ada');
    join('p2', 'token-grace', 'Grace');
    expect(lobbyNames()).toEqual(['', 'Ada', 'Grace']);
    expect(get(connectedSeats)).toEqual([0, 1, 2]);
  });

  it('returns a reloaded player to their seat instead of appending a new one', () => {
    join('p1', 'token-ada', 'Ada');
    join('p2', 'token-grace', 'Grace');
    gameState.set(startRound(createGame(['Host', 'Ada', 'Grace'], 50, 90, false)));

    // Ada's tab reloads: same token, brand-new transport id.
    room.disconnectPeer('p1');
    const received = join('p1-reloaded', 'token-ada', 'Ada');

    expect(lobbyNames()).toEqual(['', 'Ada', 'Grace']); // no phantom fourth slot
    expect(slotOf(received)).toBe(1);
    expect(get(connectedSeats)).toEqual([0, 1, 2]);
    // And she's caught up on the game she was in the middle of.
    const state = last(received.filter((m) => m.type === 'state'));
    expect(state?.payload.phase).toBe('forced-bet');
  });

  it('does not let an abandoned connection revoke the seat it left behind', () => {
    join('p1', 'token-ada', 'Ada');
    // The reload lands before the dead link is noticed — WebRTC can take tens
    // of seconds to admit a channel is gone.
    join('p1-reloaded', 'token-ada', 'Ada');
    expect(get(connectedSeats)).toEqual([0, 1]);

    room.disconnectPeer('p1'); // the old link finally times out
    expect(get(connectedSeats)).toEqual([0, 1]); // Ada is still here, on the new one
  });

  it('turns away an unknown player once a game is underway', () => {
    join('p1', 'token-ada', 'Ada');
    gameState.set(startRound(createGame(['Host', 'Ada'], 50, 90, false)));

    const received = join('p2', 'token-latecomer', 'Late');

    // The hello is still acked — it *arrived*; it was refused a seat.  Acking
    // is what stops the peer retrying a request that can never succeed.
    expect(received).toEqual([
      { type: 'rejected', reason: 'game-in-progress' },
      { type: 'ack', actionId: 'p2:1' },
    ]);
    expect(lobbyNames()).toEqual(['', 'Ada']); // lobby untouched
    expect(get(connectedSeats)).toEqual([0, 1]);
  });

  it('keeps a returning player after a link blip without a fresh hello', () => {
    const transport = room.addPeer('p1');
    const received = collectMessages<HostMsg>(transport);
    room.connectPeer('p1');
    sayHello(transport, 'token-ada', 'Ada');
    gameState.set(startRound(createGame(['Host', 'Ada'], 50, 90, false)));

    room.disconnectPeer('p1');
    expect(get(connectedSeats)).toEqual([0]);

    received.length = 0;
    room.connectPeer('p1'); // same transport id: the peer won't re-say hello
    expect(get(connectedSeats)).toEqual([0, 1]);
    expect(slotOf(received)).toBe(1);
    expect(received.filter((m) => m.type === 'state')).toHaveLength(1);
  });

  it('renumbers seats when a lobby slot above them is removed', () => {
    addBot();                              // seat 1
    const received = join('p1', 'token-ada', 'Ada'); // seat 2
    expect(slotOf(received)).toBe(2);

    removePlayer(1);                       // the bot goes
    expect(lobbyNames()).toEqual(['', 'Ada']);
    expect(slotOf(received)).toBe(1);       // Ada is told she moved up
    expect(get(connectedSeats)).toEqual([0, 1]);
  });

  it('tells a peer that reconnects after the lobby closed to skip the lobby', () => {
    join('p1', 'token-ada', 'Ada');
    hostProceed();

    const received = join('p1-reloaded', 'token-ada', 'Ada');
    expect(received.some((m) => m.type === 'proceedToSetup')).toBe(true);
  });
});

// ─── Host: connection reporting ──────────────────────────────────────────────

describe('connection reporting', () => {
  let room: InMemoryRoom;

  beforeEach(async () => {
    room = new InMemoryRoom();
    await setupAsHost('TESTROOM', undefined, room.hostTransport);
  });

  it('tracks who is present and broadcasts it', () => {
    const received = collectMessages<HostMsg>(room.addPeer('p1'));
    room.connectPeer('p1');
    sayHello(room.peerTransport('p1'), 'token-ada', 'Ada');
    expect(get(connectedSeats)).toEqual([0, 1]);

    received.length = 0;
    room.disconnectPeer('p1');
    expect(get(connectedSeats)).toEqual([0]);

    room.connectPeer('p1');
    expect(get(connectedSeats)).toEqual([0, 1]);
    const conns = received.filter((m) => m.type === 'connections');
    expect(last(conns)?.payload).toEqual([0, 1]);
  });

  it('counts bots as present — they run on the host tab', () => {
    addBot();
    room.addPeer('p1');
    room.connectPeer('p1');
    sayHello(room.peerTransport('p1'), 'token-ada', 'Ada');
    room.disconnectPeer('p1');

    // Seats: 0 host, 1 bot, 2 the peer who just dropped.
    expect(get(seatOnline)).toEqual([true, true, false]);
  });

  it('rebroadcasts the connection list on the heartbeat', () => {
    const received = collectMessages<HostMsg>(room.addPeer('p1'));
    room.connectPeer('p1');
    sayHello(room.peerTransport('p1'), 'token-ada', 'Ada');
    gameState.set(startRound(createGame(['Host', 'Ada'], 50, 90, false)));

    received.length = 0;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(received.filter((m) => m.type === 'connections')).toHaveLength(1);
  });
});

// ─── Signalling rates ────────────────────────────────────────────────────────

describe('signalling polling mode', () => {
  let room: InMemoryRoom;
  const hostMode = () => room.hostTransport.pollingMode;

  beforeEach(async () => {
    room = new InMemoryRoom();
    await setupAsHost('TESTROOM', undefined, room.hostTransport);
    room.addPeer('p1');
    room.connectPeer('p1');
    sayHello(room.peerTransport('p1'), 'token-ada', 'Ada');
  });

  it('polls actively throughout the lobby', () => {
    expect(hostMode()).toBe('active');
  });

  it('idles once the lobby closes with everyone present', () => {
    hostProceed();
    expect(hostMode()).toBe('idle');
  });

  it('resumes active polling when a player drops, and idles again when they return', () => {
    hostProceed();
    room.disconnectPeer('p1');
    // Polling IS the reconnection mechanism — this is what Phase 3 fixes.
    expect(hostMode()).toBe('active');

    room.connectPeer('p1');
    expect(hostMode()).toBe('idle');
  });

  it('stays active while any seated player is still missing', () => {
    room.addPeer('p2');
    room.connectPeer('p2');
    sayHello(room.peerTransport('p2'), 'token-grace', 'Grace');
    hostProceed();
    expect(hostMode()).toBe('idle');

    room.disconnectPeer('p1');
    room.disconnectPeer('p2');
    room.connectPeer('p1'); // only one of the two is back
    expect(hostMode()).toBe('active');

    room.connectPeer('p2');
    expect(hostMode()).toBe('idle');
  });
});

// ─── Peer: liveness ──────────────────────────────────────────────────────────

describe('peer link health', () => {
  const PEER_ID = 'PEERAAAA';
  let room: InMemoryRoom;
  let transport: InMemoryTransport;

  const sendToPeer = (msg: HostMsg) => room.hostTransport.send(PEER_ID, encodeHostMsg(msg));
  const encodeHostMsg = (msg: HostMsg) => new TextEncoder().encode(JSON.stringify(msg));

  beforeEach(async () => {
    room = new InMemoryRoom();
    transport = room.addPeer(PEER_ID);
    await setupAsPeer('TESTROOM', undefined, transport);
    room.connectPeer(PEER_ID);
  });

  it('does not count its own hello as a pending move', () => {
    // setupAsPeer enqueues an unacked hello, but the player hasn't done
    // anything — the banner must not claim a move is waiting to be sent.
    expect(get(networkMode)).toBe('peer');
    expect(get(queuedActionCount)).toBe(0);
  });

  it('reports a move made while the link was down, so the UI can say it is saved', () => {
    room.disconnectPeer(PEER_ID);
    doForcedBets(); // networkMode is 'peer' → queued, not dropped
    expect(get(queuedActionCount)).toBe(1);
    expect(get(hostLinkUp)).toBe(false);
  });

  it('reports the link down when peerclose fires', () => {
    expect(get(hostLinkUp)).toBe(true);
    room.disconnectPeer(PEER_ID);
    expect(get(hostLinkUp)).toBe(false);
    expect(transport.pollingMode).toBe('active');

    room.connectPeer(PEER_ID);
    expect(get(hostLinkUp)).toBe(true);
  });

  it('reports the link down when the heartbeat stops, even with the channel open', () => {
    sendToPeer({ type: 'state', v: 1, payload: startRound(createGame(['A', 'B'], 50, 90, false)) });
    sendToPeer({ type: 'proceedToSetup' });
    expect(get(hostLinkUp)).toBe(true);
    expect(transport.pollingMode).toBe('idle');

    // The channel never closes; the host simply goes quiet.
    vi.advanceTimersByTime(HOST_SILENCE_TIMEOUT_MS + 1000);
    expect(get(hostLinkUp)).toBe(false);
    // …and we start looking for a way back.
    expect(transport.pollingMode).toBe('active');

    // One heartbeat is enough to recover.
    sendToPeer({ type: 'state', v: 2, payload: startRound(createGame(['A', 'B'], 50, 90, false)) });
    expect(get(hostLinkUp)).toBe(true);
    expect(transport.pollingMode).toBe('idle');
  });

  it('does not cry disconnect while the lobby is quiet by design', () => {
    // No game yet, so the host isn't heartbeating and silence means nothing.
    vi.advanceTimersByTime(HOST_SILENCE_TIMEOUT_MS * 3);
    expect(get(hostLinkUp)).toBe(true);
  });

  it('applies the host connection list and slot assignment', () => {
    sendToPeer({ type: 'slotAssignment', payload: { playerIndex: 2 } });
    sendToPeer({ type: 'connections', v: 1, payload: [0, 2] });
    expect(get(myPlayerIndex)).toBe(2);
    expect(get(connectedSeats)).toEqual([0, 2]);
  });

  it('surfaces a rejection from the host', () => {
    expect(get(joinRejected)).toBeNull();
    sendToPeer({ type: 'rejected', reason: 'game-in-progress' });
    expect(get(joinRejected)).toBe('game-in-progress');
  });
});
