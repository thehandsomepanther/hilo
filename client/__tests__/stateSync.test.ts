/**
 * Phase 1 state-sync integration tests, driven through gameStore with an
 * in-memory transport.
 *
 * Host side: every broadcast snapshot carries an increasing version, the
 * heartbeat rebroadcasts the current snapshot at its current version, and a
 * dropped broadcast is healed by the next heartbeat (the deadlock the plan
 * calls "lost host→peer state").
 *
 * Peer side: stale/duplicate versions are ignored, newer ones apply, and the
 * gate is per message type.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import {
  gameState, pendingDecision, lobbyState, myPlayerIndex,
  setupAsHost, setupAsPeer, initGame, doForcedBets,
  _resetNetworkForTests,
} from '../gameStore';
import { encodeMsg } from '../network';
import type { HostMsg, PeerMsg } from '../network';
import { HEARTBEAT_INTERVAL_MS } from '../protocol';
import { InMemoryRoom, collectMessages } from '../testing/inMemoryTransport';
import { createGame, startRound } from '../../src/game';
import type { GameState } from '../../src/types';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  _resetNetworkForTests();
  vi.useRealTimers();
});

type StateMsg = Extract<HostMsg, { type: 'state' }>;
const stateMsgs = (received: HostMsg[]): StateMsg[] =>
  received.filter((m): m is StateMsg => m.type === 'state');

function last<T>(arr: T[]): T {
  const item = arr[arr.length - 1];
  if (item === undefined) throw new Error('expected a non-empty array');
  return item;
}

// ─── Host side ───────────────────────────────────────────────────────────────

describe('host state sync', () => {
  let room: InMemoryRoom;
  let received: HostMsg[];

  beforeEach(async () => {
    room = new InMemoryRoom();
    await setupAsHost('TESTROOM', undefined, room.hostTransport);
    received = collectMessages<HostMsg>(room.addPeer('p1'));
    room.connectPeer('p1');
  });

  it('assigns a slot and sends current snapshots to a newly connected peer', () => {
    const slot = received.find((m) => m.type === 'slotAssignment');
    expect(slot?.payload).toEqual({ playerIndex: 1 });
    const lobbies = received.filter((m) => m.type === 'lobby');
    expect(lobbies.length).toBeGreaterThan(0);
    expect(last(lobbies).payload.players).toHaveLength(2);
  });

  it('stamps each new state broadcast with an increasing version', () => {
    initGame(['Host', 'Guest'], 50, false);
    doForcedBets();
    const states = stateMsgs(received);
    expect(states.map((m) => m.v)).toEqual([1, 2]);
    expect(states.map((m) => m.payload.phase)).toEqual(['forced-bet', 'dealing-1']);
  });

  it('does not heartbeat before a game starts', () => {
    received.length = 0;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(received).toEqual([]);
  });

  it('heartbeat rebroadcasts the current snapshot at its CURRENT version', () => {
    initGame(['Host', 'Guest'], 50, false);
    received.length = 0;

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    const states = stateMsgs(received);
    expect(states).toHaveLength(1);
    expect(states[0]!.v).toBe(1); // same version as the original broadcast — peers dedup it
    expect(states[0]!.payload.phase).toBe('forced-bet');

    // pendingDecision has never been set, so its heartbeat carries v0 and
    // every peer gate (which starts at 0) drops it.
    const pd = received.find((m) => m.type === 'pendingDecision');
    expect(pd && pd.v).toBe(0);
  });

  it('heals a dropped state broadcast within one heartbeat', () => {
    initGame(['Host', 'Guest'], 50, false);

    // Drop the broadcast triggered by the next state change.
    room.shouldDrop = (_from, _to, msg) => (msg as HostMsg).type === 'state';
    doForcedBets();
    expect(stateMsgs(received).map((m) => m.v)).toEqual([1]); // v2 was lost

    room.shouldDrop = null;
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    const states = stateMsgs(received);
    expect(last(states).v).toBe(2);
    expect(last(states).payload.phase).toBe('dealing-1');
  });

  it('resends the current state when a peer reconnects', () => {
    initGame(['Host', 'Guest'], 50, false);
    room.disconnectPeer('p1');
    doForcedBets(); // broadcast silently dropped — link is down
    expect(stateMsgs(received).map((m) => m.v)).toEqual([1]);

    room.connectPeer('p1');
    // onConnected resends the current snapshot immediately, before any heartbeat.
    const states = stateMsgs(received);
    expect(last(states).v).toBe(2);
    expect(last(states).payload.phase).toBe('dealing-1');
  });
});

// ─── Peer side ───────────────────────────────────────────────────────────────

/** Build a real engine state, tagged through the log for identification. */
function sampleState(marker: string): GameState {
  const s = startRound(createGame(['A', 'B'], 50, 90, false));
  return { ...s, log: [marker] };
}

describe('peer state sync', () => {
  const PEER_ID = 'PEERAAAA';
  let room: InMemoryRoom;
  let hostReceived: PeerMsg[];

  const sendToPeer = (msg: HostMsg) => room.hostTransport.send(PEER_ID, encodeMsg(msg));
  const currentMarker = () => get(gameState)?.log[0];

  beforeEach(async () => {
    room = new InMemoryRoom();
    const transport = room.addPeer(PEER_ID);
    hostReceived = collectMessages<PeerMsg>(room.hostTransport);
    await setupAsPeer('TESTROOM', undefined, transport);
    room.connectPeer(PEER_ID);
  });

  it('applies state snapshots with increasing versions', () => {
    sendToPeer({ type: 'state', v: 1, payload: sampleState('one') });
    expect(currentMarker()).toBe('one');
    sendToPeer({ type: 'state', v: 2, payload: sampleState('two') });
    expect(currentMarker()).toBe('two');
  });

  it('ignores duplicate and stale state versions', () => {
    const applied: (GameState | null)[] = [];
    const unsub = gameState.subscribe((s) => applied.push(s));

    sendToPeer({ type: 'state', v: 2, payload: sampleState('two') });
    sendToPeer({ type: 'state', v: 2, payload: sampleState('dup') });   // heartbeat redelivery
    sendToPeer({ type: 'state', v: 1, payload: sampleState('stale') }); // late arrival
    unsub();

    expect(currentMarker()).toBe('two');
    // Initial null + exactly one application — duplicates caused no store writes.
    expect(applied).toHaveLength(2);
  });

  it('tolerates version gaps (missed broadcasts) but never regresses', () => {
    sendToPeer({ type: 'state', v: 5, payload: sampleState('five') });
    expect(currentMarker()).toBe('five');
    sendToPeer({ type: 'state', v: 3, payload: sampleState('three') });
    expect(currentMarker()).toBe('five');
  });

  it('gates each message type independently', () => {
    sendToPeer({ type: 'state', v: 5, payload: sampleState('five') });
    sendToPeer({
      type: 'lobby',
      v: 1,
      payload: { players: [{ name: 'Zed', isBot: false }], startingChips: 75, enforceTimeLimit: false },
    });
    // A high state version must not shadow the first lobby update.
    expect(get(lobbyState).startingChips).toBe(75);
  });

  it('applies pendingDecision updates and version-gated clears', () => {
    const state = sampleState('ctx');
    const player = state.players[0]!;
    sendToPeer({ type: 'pendingDecision', v: 1, payload: { player } });
    expect(get(pendingDecision)?.player.id).toBe(player.id);

    sendToPeer({ type: 'pendingDecision', v: 2, payload: null });
    expect(get(pendingDecision)).toBeNull();

    // A late redelivery of the older decision must not resurrect it.
    sendToPeer({ type: 'pendingDecision', v: 1, payload: { player } });
    expect(get(pendingDecision)).toBeNull();
  });

  it('applies unversioned messages unconditionally', () => {
    sendToPeer({ type: 'state', v: 9, payload: sampleState('nine') });
    sendToPeer({ type: 'slotAssignment', payload: { playerIndex: 1 } });
    expect(get(myPlayerIndex)).toBe(1);
  });

  it('forwards actions to the host, and silently drops them while disconnected', () => {
    doForcedBets(); // networkMode is 'peer' → serialized and sent to the host
    expect(hostReceived).toEqual([{ type: 'action', payload: { name: 'doForcedBets' } }]);

    room.disconnectPeer(PEER_ID);
    doForcedBets();
    // Still just one message: the silent-drop gap that Phase 2 (acked actions)
    // will close.  Phase 1 only guarantees host→peer healing.
    expect(hostReceived).toHaveLength(1);
  });
});
