import { describe, it, expect } from 'vitest';
import { VersionCounter, VersionGate, isVersionedMsg } from '../protocol';
import type { HostMsg, LobbyState } from '../network';

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
  });
});
