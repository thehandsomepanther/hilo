import { describe, it, expect } from 'vitest';
import {
  VersionCounter, VersionGate, isVersionedMsg,
  OutboundActionQueue, InboundActionFilter, parseActionId,
  ACTION_RETRY_BASE_MS, ACTION_RETRY_MAX_MS,
} from '../protocol';
import type { HostMsg, LobbyState, SerializedAction } from '../network';

const lobby: LobbyState = {
  players: [{ name: 'A', isBot: false }],
  startingChips: 50,
  enforceTimeLimit: false,
};

function lobbyMsg(v: number): HostMsg {
  return { type: 'lobby', v, payload: lobby };
}

function pendingMsg(v: number): HostMsg {
  return { type: 'pendingDecision', v, payload: null };
}

describe('VersionCounter', () => {
  it('starts at 0 and increments per call', () => {
    const c = new VersionCounter();
    expect(c.current('state')).toBe(0);
    expect(c.next('state')).toBe(1);
    expect(c.next('state')).toBe(2);
    expect(c.current('state')).toBe(2);
  });

  it('tracks each message type independently', () => {
    const c = new VersionCounter();
    c.next('state');
    c.next('state');
    c.next('lobby');
    expect(c.current('state')).toBe(2);
    expect(c.current('lobby')).toBe(1);
    expect(c.current('pendingDecision')).toBe(0);
  });
});

describe('VersionGate', () => {
  it('accepts strictly increasing versions and rejects stale/duplicate ones', () => {
    const g = new VersionGate();
    expect(g.accept(lobbyMsg(1))).toBe(true);
    expect(g.accept(lobbyMsg(1))).toBe(false); // duplicate (heartbeat redelivery)
    expect(g.accept(lobbyMsg(0))).toBe(false); // stale
    expect(g.accept(lobbyMsg(2))).toBe(true);
  });

  it('tolerates version gaps but never regresses', () => {
    const g = new VersionGate();
    expect(g.accept(lobbyMsg(5))).toBe(true);  // missed 1–4: latest snapshot still applies
    expect(g.accept(lobbyMsg(3))).toBe(false); // late arrival of an older snapshot
    expect(g.accept(lobbyMsg(6))).toBe(true);
  });

  it('gates each message type independently', () => {
    const g = new VersionGate();
    expect(g.accept(lobbyMsg(5))).toBe(true);
    // A high lobby version must not shadow a fresh pendingDecision update.
    expect(g.accept(pendingMsg(1))).toBe(true);
    expect(g.accept(pendingMsg(1))).toBe(false);
  });

  it('always passes unversioned message types', () => {
    const g = new VersionGate();
    const slot: HostMsg = { type: 'slotAssignment', payload: { playerIndex: 1 } };
    const proceed: HostMsg = { type: 'proceedToSetup' };
    expect(g.accept(slot)).toBe(true);
    expect(g.accept(slot)).toBe(true);
    expect(g.accept(proceed)).toBe(true);
    expect(g.accept(proceed)).toBe(true);
  });
});

describe('isVersionedMsg', () => {
  it('classifies message types correctly', () => {
    expect(isVersionedMsg(lobbyMsg(1))).toBe(true);
    expect(isVersionedMsg(pendingMsg(1))).toBe(true);
    expect(isVersionedMsg({ type: 'proceedToSetup' })).toBe(false);
    expect(isVersionedMsg({ type: 'slotAssignment', payload: { playerIndex: 0 } })).toBe(false);
    expect(isVersionedMsg({ type: 'ack', actionId: 'A:1' })).toBe(false);
  });
});

// ─── peer → host ─────────────────────────────────────────────────────────────

const fold: SerializedAction = { name: 'doBettingAction', args: [{ type: 'fold' }] };
const next: SerializedAction = { name: 'doNextRound' };

describe('parseActionId', () => {
  it('splits a well-formed id', () => {
    expect(parseActionId('ABCD:7')).toEqual({ clientId: 'ABCD', counter: 7 });
  });

  it('rejects malformed ids', () => {
    expect(parseActionId('ABCD')).toBeNull();
    expect(parseActionId(':7')).toBeNull();
    expect(parseActionId('ABCD:')).toBeNull();
    expect(parseActionId('ABCD:x')).toBeNull();
    expect(parseActionId('ABCD:0')).toBeNull();   // counters start at 1
    expect(parseActionId('ABCD:1.5')).toBeNull();
  });
});

describe('OutboundActionQueue', () => {
  it('stamps actions with monotonic ids scoped to the client', () => {
    const q = new OutboundActionQueue('ABCD');
    expect(q.enqueue({ type: 'action', playerId: 'player-1', payload: fold })).toEqual({
      type: 'action', actionId: 'ABCD:1', playerId: 'player-1', payload: fold,
    });
    expect(q.enqueue({ type: 'action', playerId: 'player-1', payload: next }).actionId).toBe('ABCD:2');
  });

  it('holds actions until acked, oldest first', () => {
    const q = new OutboundActionQueue('ABCD');
    q.enqueue({ type: 'action', playerId: null, payload: fold });
    q.enqueue({ type: 'action', playerId: null, payload: next });
    expect(q.due(0).map((m) => m.actionId)).toEqual(['ABCD:1', 'ABCD:2']);

    expect(q.ack('ABCD:1')).toBe(true);
    expect(q.ack('ABCD:1')).toBe(false); // already retired
    expect(q.size).toBe(1);
    expect(q.due(10_000).map((m) => m.actionId)).toEqual(['ABCD:2']);
  });

  it('resends the whole queue on each retry so the host never sees a gap', () => {
    const q = new OutboundActionQueue('ABCD');
    q.enqueue({ type: 'action', playerId: null, payload: fold });
    q.due(0);
    q.enqueue({ type: 'action', playerId: null, payload: next }); // arrives mid-backoff
    // The new action makes everything due again — the unacked head rides along.
    expect(q.due(0).map((m) => m.actionId)).toEqual(['ABCD:1', 'ABCD:2']);
  });

  it('backs off exponentially, capped at ACTION_RETRY_MAX_MS', () => {
    const q = new OutboundActionQueue('ABCD');
    q.enqueue({ type: 'action', playerId: null, payload: fold });

    expect(q.due(0)).toHaveLength(1);
    expect(q.due(ACTION_RETRY_BASE_MS - 1)).toEqual([]);
    expect(q.due(ACTION_RETRY_BASE_MS)).toHaveLength(1);
    // The second failed round waits twice as long.
    expect(q.due(ACTION_RETRY_BASE_MS * 3 - 1)).toEqual([]);

    // Keep failing, always waiting exactly the cap: once the ramp saturates,
    // every round still fires — the wait never grows past the cap.
    let t = ACTION_RETRY_BASE_MS * 3;
    for (let i = 0; i < 10; i++) {
      expect(q.due(t)).toHaveLength(1);
      t += ACTION_RETRY_MAX_MS;
    }
  });

  it('restarts the backoff ramp when an ack proves the link works', () => {
    const q = new OutboundActionQueue('ABCD');
    q.enqueue({ type: 'action', playerId: null, payload: fold });
    q.enqueue({ type: 'action', playerId: null, payload: next });

    q.due(0);                      // round 1 → next retry one base interval out
    q.due(ACTION_RETRY_BASE_MS);   // round 2 → next retry two intervals out

    q.ack('ABCD:1');
    q.due(ACTION_RETRY_BASE_MS * 3);
    // Back to a base-interval wait; without the ack this round would be 4×.
    expect(q.due(ACTION_RETRY_BASE_MS * 4)).toHaveLength(1);
  });

  it('has nothing due when the queue is empty', () => {
    const q = new OutboundActionQueue('ABCD');
    expect(q.due(0)).toEqual([]);
    q.enqueue({ type: 'action', playerId: null, payload: fold });
    q.ack('ABCD:1');
    expect(q.due(10_000)).toEqual([]);
    expect(q.pendingIds()).toEqual([]);
  });

  it('makes everything due immediately after a reconnect', () => {
    const q = new OutboundActionQueue('ABCD');
    q.enqueue({ type: 'action', playerId: null, payload: fold });
    q.due(0);
    expect(q.due(1)).toEqual([]); // mid-backoff
    q.resetBackoff();
    expect(q.due(1)).toHaveLength(1);
  });
});

describe('InboundActionFilter', () => {
  it('applies each counter once and re-acks duplicates without applying', () => {
    const f = new InboundActionFilter();
    expect(f.admit('p1', 'p1:1')).toBe('apply');
    expect(f.admit('p1', 'p1:1')).toBe('duplicate'); // retry after a lost ack
    expect(f.admit('p1', 'p1:2')).toBe('apply');
    expect(f.admit('p1', 'p1:1')).toBe('duplicate'); // late redelivery
  });

  it('defers an action whose predecessor is still missing', () => {
    const f = new InboundActionFilter();
    expect(f.admit('p1', 'p1:2')).toBe('gap');
    // The peer retries the whole queue, so the gap fills and both apply.
    expect(f.admit('p1', 'p1:1')).toBe('apply');
    expect(f.admit('p1', 'p1:2')).toBe('apply');
  });

  it('tracks each sender independently', () => {
    const f = new InboundActionFilter();
    expect(f.admit('p1', 'p1:1')).toBe('apply');
    expect(f.admit('p2', 'p2:1')).toBe('apply');
    expect(f.admit('p2', 'p2:2')).toBe('apply');
    expect(f.admit('p1', 'p1:2')).toBe('apply');
  });

  it('keys on the sending connection, not the id prefix', () => {
    const f = new InboundActionFilter();
    // A peer that lies about its client id cannot replay another peer's slot.
    expect(f.admit('p1', 'p2:1')).toBe('apply');
    expect(f.admit('p2', 'p2:1')).toBe('apply');
  });

  it('rejects malformed action ids', () => {
    const f = new InboundActionFilter();
    expect(f.admit('p1', 'garbage')).toBe('invalid');
    expect(f.admit('p1', 'p1:1')).toBe('apply'); // sequence untouched
  });
});
