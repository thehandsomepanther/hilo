/**
 * Phase 2 integration tests: peer actions are queued, retried and acked, and
 * the host applies each one exactly once.
 *
 * The host runs the real gameStore over an in-memory transport; the remote
 * player is a bare PeerNetwork sending real SerializedActions, which is all a
 * peer tab does on the wire.
 *
 * The target is deadlock #1 from plans/network-hardening.md: a peer's action
 * is lost while the link is down, the host waits forever for that player to
 * act, and — because nothing changes state — nothing ever heals it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameState, lobbyState, setupAsHost, _resetNetworkForTests } from '../gameStore';
import { PeerNetwork } from '../network';
import type { HostMsg, SerializedAction } from '../network';
import { ACTION_RETRY_BASE_MS } from '../protocol';
import { InMemoryRoom } from '../testing/inMemoryTransport';
import {
  createGame, startRound, collectForcedBets, dealSecretCards, initBettingRound,
} from '../../src/game';
import type { BettingState, Dealing1State, DealtPlayer } from '../../src/types';

const PEER_ID = 'PEERAAAA';
const check: SerializedAction = { name: 'doBettingAction', args: [{ type: 'check' }] };

/** A deterministic betting-1 state: three players, nobody has bet, all may check. */
function bettingState(): BettingState {
  const dealt = dealSecretCards(collectForcedBets(startRound(
    createGame(['Host', 'Guest', 'Third'], 50, 90, false),
  )));
  return initBettingRound(dealt as Dealing1State & { players: DealtPlayer[] }, 'betting-1');
}

const activeIndex = () => (get(gameState) as BettingState).activePlayerIndex;
const checksApplied = () => get(gameState)!.log.filter((l) => l.endsWith('checked')).length;

describe('reliable peer actions', () => {
  let room: InMemoryRoom;
  let peer: PeerNetwork;

  beforeEach(async () => {
    vi.useFakeTimers();
    room = new InMemoryRoom();
    await setupAsHost('TESTROOM', undefined, room.hostTransport);
    peer = new PeerNetwork(room.addPeer(PEER_ID));
    peer.start();
    room.connectPeer(PEER_ID);
    gameState.set(bettingState());
  });

  afterEach(() => {
    peer.close();
    _resetNetworkForTests();
    vi.useRealTimers();
  });

  it('applies a delivered action once and stops retrying it', () => {
    const seat = activeIndex();
    peer.sendAction(check, `player-${seat}`);

    expect(checksApplied()).toBe(1);
    expect(activeIndex()).not.toBe(seat);
    expect(peer.pendingActionCount()).toBe(0);

    vi.advanceTimersByTime(ACTION_RETRY_BASE_MS * 10);
    expect(checksApplied()).toBe(1);
  });

  it('delivers an action taken while disconnected once the link returns', () => {
    room.disconnectPeer(PEER_ID);

    const seat = activeIndex();
    peer.sendAction(check, `player-${seat}`);
    // Deadlock #1 without Phase 2: the host is still waiting on this player.
    expect(checksApplied()).toBe(0);
    expect(activeIndex()).toBe(seat);
    expect(peer.pendingActionCount()).toBe(1);

    // Retries while down are no-ops, not lost sends.
    vi.advanceTimersByTime(ACTION_RETRY_BASE_MS * 10);
    expect(peer.pendingActionCount()).toBe(1);

    room.connectPeer(PEER_ID);
    expect(checksApplied()).toBe(1);
    expect(activeIndex()).not.toBe(seat);
    expect(peer.pendingActionCount()).toBe(0);
  });

  it('retries a lost action until the host receives it', () => {
    room.shouldDrop = (_from, _to, msg) => (msg as { type: string }).type === 'action';

    const seat = activeIndex();
    peer.sendAction(check, `player-${seat}`);
    vi.advanceTimersByTime(ACTION_RETRY_BASE_MS * 4);
    expect(checksApplied()).toBe(0);

    room.shouldDrop = null;
    vi.advanceTimersByTime(ACTION_RETRY_BASE_MS * 8);
    expect(checksApplied()).toBe(1);
    expect(peer.pendingActionCount()).toBe(0);
  });

  it('never double-applies when the ack is lost — a retried check must not act for the next player', () => {
    room.shouldDrop = (_from, _to, msg) => (msg as HostMsg).type === 'ack';

    const seat = activeIndex();
    peer.sendAction(check, `player-${seat}`);
    const afterFirst = activeIndex();
    expect(checksApplied()).toBe(1);

    // Several retries arrive; each is a duplicate the host must refuse.
    vi.advanceTimersByTime(ACTION_RETRY_BASE_MS * 8);
    expect(checksApplied()).toBe(1);
    expect(activeIndex()).toBe(afterFirst);
    expect(peer.pendingActionCount()).toBe(1);

    room.shouldDrop = null;
    vi.advanceTimersByTime(ACTION_RETRY_BASE_MS * 8);
    expect(checksApplied()).toBe(1);
    expect(peer.pendingActionCount()).toBe(0);
  });

  it('applies a queued batch in the order it was issued', () => {
    room.disconnectPeer(PEER_ID);
    peer.sendAction({ name: 'updateLobbyName', args: [1, 'Ada'] });
    peer.sendAction({ name: 'updateLobbyName', args: [1, 'Grace'] });

    const seen: string[] = [];
    const unsub = lobbyState.subscribe((ls) => seen.push(ls.players[1]?.name ?? ''));
    room.connectPeer(PEER_ID);
    unsub();

    expect(seen.slice(-2)).toEqual(['Ada', 'Grace']);
    expect(peer.pendingActionCount()).toBe(0);
  });
});
