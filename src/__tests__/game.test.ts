import { describe, it, expect } from 'vitest';
import {
  createGame,
  startRound,
  collectForcedBets,
  applyBettingAction,
  isBettingComplete,
  resetBettingRound,
  applyBetChoices,
  runDealingPhase1,
  runDealingPhase2,
} from '../game';
import { MultiplicationDecision, Player, Card } from '../types';

const declineMultiplication = (): MultiplicationDecision => ({ accept: false });

describe('createGame', () => {
  it('requires at least 2 players', () => {
    expect(() => createGame(['Alice'])).toThrow();
  });

  it('creates correct initial state', () => {
    const state = createGame(['Alice', 'Bob'], 50, 1);
    expect(state.players).toHaveLength(2);
    expect(state.players[0]?.chips).toBe(50);
    expect(state.players[0]?.personalOperators).toHaveLength(3);
    expect(state.phase).toBe('setup');
    expect(state.round).toBe(0);
  });
});

describe('startRound', () => {
  it('increments round and resets player hands', () => {
    const state = createGame(['Alice', 'Bob']);
    const next = startRound(state);
    expect(next.round).toBe(1);
    expect(next.phase).toBe('forced-bet');
    next.players.forEach((p) => {
      expect(p.secretCard).toBeNull();
      expect(p.faceUpCards).toHaveLength(0);
      expect(p.folded).toBe(false);
    });
  });
});

describe('collectForcedBets', () => {
  it('deducts chips and adds to pot', () => {
    const state = startRound(createGame(['Alice', 'Bob'], 10, 2));
    const next = collectForcedBets(state);
    expect(next.pot).toBe(4);
    next.players.forEach((p) => expect(p.chips).toBe(8));
  });

  it('goes all-in when chips < forced bet', () => {
    const state = startRound(createGame(['Alice', 'Bob'], 1, 5));
    const next = collectForcedBets(state);
    next.players.forEach((p) => {
      expect(p.chips).toBe(0);
      expect(p.currentBet).toBe(1);
    });
    expect(next.pot).toBe(2);
  });
});

describe('dealing phases', () => {
  it('phase 1 gives every active player a secret card and ≥2 face-up cards', () => {
    const base = startRound(createGame(['Alice', 'Bob', 'Charlie'], 50));
    const state = collectForcedBets(base);
    const dealt = runDealingPhase1(state, declineMultiplication);
    dealt.players.forEach((p) => {
      expect(p.secretCard).not.toBeNull();
      expect(p.faceUpCards.length).toBeGreaterThanOrEqual(2);
    });
    expect(dealt.phase).toBe('betting-1');
  });

  it('secret card is always a number card', () => {
    const base = startRound(createGame(['Alice', 'Bob'], 50));
    const state = collectForcedBets(base);
    const dealt = runDealingPhase1(state, declineMultiplication);
    dealt.players.forEach((p) => {
      expect(p.secretCard?.kind).toBe('number');
    });
  });

  it('phase 2 gives one more face-up card', () => {
    const base = startRound(createGame(['Alice', 'Bob'], 50));
    let state = collectForcedBets(base);
    state = runDealingPhase1(state, declineMultiplication);
    const countBefore = state.players.map((p) => p.faceUpCards.length);
    // skip betting for test — manually advance phase
    const state2 = runDealingPhase2({ ...state, phase: 'dealing-2' }, declineMultiplication);
    state2.players.forEach((p, i) => {
      // May be more than +1 if √ was drawn, but never fewer
      expect(p.faceUpCards.length).toBeGreaterThanOrEqual((countBefore[i] ?? 0) + 1);
    });
  });
});

describe('betting', () => {
  function bettingState() {
    const base = startRound(createGame(['Alice', 'Bob', 'Charlie'], 50, 1));
    return collectForcedBets(base);
  }

  it('raise increases pot and currentBet', () => {
    const state = bettingState();
    const { state: next } = applyBettingAction(state, { type: 'raise', amount: 5 });
    expect(next.currentBet).toBe(5);
    expect(next.pot).toBeGreaterThan(state.pot);
  });

  it('call matches current bet', () => {
    let state = bettingState();
    ({ state } = applyBettingAction(state, { type: 'raise', amount: 5 }));
    const callerChipsBefore = state.players[state.activePlayerIndex]?.chips ?? 0;
    ({ state } = applyBettingAction(state, { type: 'call' }));
    const callerChipsAfter = state.players[(state.activePlayerIndex + state.players.length - 1) % state.players.length]?.chips ?? 0;
    expect(callerChipsAfter).toBeLessThan(callerChipsBefore);
  });

  it('check is allowed when no raise has been made', () => {
    const state = bettingState();
    // Reset bets to 0 to simulate no prior raises
    const noRaise = resetBettingRound(state, 'betting-1');
    expect(() => applyBettingAction(noRaise, { type: 'check' })).not.toThrow();
  });

  it('check throws when there is an outstanding bet', () => {
    let state = bettingState();
    ({ state } = applyBettingAction(state, { type: 'raise', amount: 5 }));
    expect(() => applyBettingAction(state, { type: 'check' })).toThrow();
  });

  it('fold removes player from active pool', () => {
    const state = bettingState();
    const { state: next } = applyBettingAction(state, { type: 'fold' });
    const folded = next.players.filter((p) => p.folded);
    expect(folded).toHaveLength(1);
  });

  it('round is complete when all active players match bet', () => {
    let state = resetBettingRound(bettingState(), 'betting-1');
    expect(isBettingComplete(state)).toBe(true); // all at 0
  });

  it('round is complete when only one player remains', () => {
    let state = bettingState();
    // Fold two players — only Charlie remains
    ({ state } = applyBettingAction(state, { type: 'fold' }));
    ({ state } = applyBettingAction(state, { type: 'fold' }));
    expect(isBettingComplete(state)).toBe(true);
  });

  it('raise below current bet throws', () => {
    let state = bettingState();
    ({ state } = applyBettingAction(state, { type: 'raise', amount: 5 }));
    expect(() => applyBettingAction(state, { type: 'raise', amount: 3 })).toThrow();
  });
});

describe('applyBetChoices', () => {
  it('records choices and advances phase to results', () => {
    const state = createGame(['Alice', 'Bob']);
    const choices = new Map<string, 'high' | 'low' | 'swing'>([
      ['player-0', 'low'],
      ['player-1', 'high'],
    ]);
    const next = applyBetChoices(state, choices);
    expect(next.phase).toBe('results');
    expect(next.players[0]?.betChoice).toBe('low');
    expect(next.players[1]?.betChoice).toBe('high');
  });
});
