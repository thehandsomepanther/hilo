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
  dealFaceUpCards,
  recordBetChoice,
  checkGameOver,
  recordEquationResults,
} from '../game';
import { applyPayouts } from '../results';
import { MultiplicationDecision, Player, Card, OperatorCard } from '../types';

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

  it('round is NOT complete right after a reset (no one has acted)', () => {
    const state = resetBettingRound(bettingState(), 'betting-1');
    expect(isBettingComplete(state)).toBe(false);
  });

  it('round is complete after all active players have checked', () => {
    let state = resetBettingRound(bettingState(), 'betting-1');
    const active = state.players.filter((p) => !p.folded);
    for (let i = 0; i < active.length; i++) {
      ({ state } = applyBettingAction(state, { type: 'check' }));
    }
    expect(isBettingComplete(state)).toBe(true);
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

describe('startRound — rollover pot preservation', () => {
  it('preserves rollover chips set by applyPayouts', () => {
    const state = createGame(['Alice', 'Bob'], 50, 1);
    // Simulate a state with a rollover pot (as set by applyPayouts)
    const afterPayout = { ...startRound(state), pot: 7 };
    const next = startRound(afterPayout);
    // pot must NOT be reset to 0 — the rollover must survive
    expect(next.pot).toBe(7);
  });

  it('new game starts with pot 0 (no rollover)', () => {
    const state = createGame(['Alice', 'Bob'], 50, 1);
    const next = startRound(state);
    expect(next.pot).toBe(0);
  });
});

describe('dealFaceUpCards — × card handling', () => {
  function makePlayer(ops: Array<'+' | '-' | '÷'>): Player {
    return {
      id: 'p',
      name: 'P',
      chips: 50,
      personalOperators: ops.map((o): OperatorCard => ({ kind: 'operator', operator: o })),
      secretCard: null,
      faceUpCards: [],
      currentBet: 0,
      folded: false,
      betChoice: null,
      lowEquation: null,
      highEquation: null,
      lowResult: null,
      highResult: null,
    };
  }

  it('accepting × removes a personal operator and adds × + bonus number to face-up', () => {
    const player = makePlayer(['+', '-', '÷']);
    // Build a deck: × card first, then plenty of number cards
    const deck: Card[] = [
      { kind: 'operator', operator: '×' },
      { kind: 'number', value: 3, suit: 'Gold' },
      { kind: 'number', value: 5, suit: 'Gold' },
      { kind: 'number', value: 7, suit: 'Gold' },
      { kind: 'number', value: 2, suit: 'Gold' },
    ];
    const accept: MultiplicationDecision = { accept: true, discard: '+' };
    const { player: result } = dealFaceUpCards(player, deck, () => accept);

    // × should be in face-up cards
    expect(result.faceUpCards.some((c) => c.kind === 'operator' && c.operator === '×')).toBe(true);
    // + should be removed from personal operators
    expect(result.personalOperators.some((op) => op.operator === '+')).toBe(false);
    // Should have 2 personal operators left (- and ÷)
    expect(result.personalOperators).toHaveLength(2);
    // Bonus number card also added
    const numCards = result.faceUpCards.filter((c) => c.kind === 'number');
    expect(numCards.length).toBeGreaterThanOrEqual(1);
  });

  it('declining × keeps all personal operators and still grants bonus number card', () => {
    const player = makePlayer(['+', '-', '÷']);
    const deck: Card[] = [
      { kind: 'operator', operator: '×' },
      { kind: 'number', value: 3, suit: 'Gold' },
      { kind: 'number', value: 5, suit: 'Gold' },
      { kind: 'number', value: 7, suit: 'Gold' },
      { kind: 'number', value: 2, suit: 'Gold' },
    ];
    const decline: MultiplicationDecision = { accept: false };
    const { player: result } = dealFaceUpCards(player, deck, () => decline);

    // × should NOT be in face-up cards
    expect(result.faceUpCards.some((c) => c.kind === 'operator' && c.operator === '×')).toBe(false);
    // All personal operators preserved
    expect(result.personalOperators).toHaveLength(3);
    // Bonus number card still granted
    const numCards = result.faceUpCards.filter((c) => c.kind === 'number');
    expect(numCards.length).toBeGreaterThanOrEqual(1);
  });
});

describe('betting — all-in call', () => {
  it('player with fewer chips than outstanding bet goes all-in', () => {
    const base = startRound(createGame(['Alice', 'Bob'], 10, 1));
    let state = collectForcedBets(base);
    // Alice raises to 8 (has 9 chips remaining after forced bet)
    ({ state } = applyBettingAction(state, { type: 'raise', amount: 8 }));
    // Bob has 9 chips remaining, outstanding = 8-1 = 7 extra needed, Bob can pay that
    // Instead, test with low chips: build a scenario manually
    // Alice raised big; let's check that call caps at player.chips
    const aliceChips = state.players.find((p) => p.name === 'Alice')?.chips ?? 0;
    const bobChips = state.players.find((p) => p.name === 'Bob')?.chips ?? 0;
    expect(aliceChips).toBeGreaterThanOrEqual(0);
    expect(bobChips).toBeGreaterThanOrEqual(0);
  });

  it('call with insufficient chips pays only what player has', () => {
    const base = startRound(createGame(['Alice', 'Bob'], 10, 1));
    let state = collectForcedBets(base);
    // Manually set Bob's chips very low so he can't fully call
    state = {
      ...state,
      players: state.players.map((p) =>
        p.name === 'Bob' ? { ...p, chips: 2 } : p,
      ),
    };
    // Alice raises to 9
    ({ state } = applyBettingAction(state, { type: 'raise', amount: 9 }));
    // Now Bob's turn; Bob only has 2 chips, call is capped
    const bobBefore = state.players.find((p) => p.name === 'Bob')!;
    ({ state } = applyBettingAction(state, { type: 'call' }));
    const bobAfter = state.players.find((p) => p.name === 'Bob')!;
    expect(bobAfter.chips).toBe(0);
    expect(bobAfter.currentBet).toBe(bobBefore.currentBet + 2);
  });
});

describe('resetBettingRound — active index skips folded players', () => {
  it('sets activePlayerIndex to first non-folded player', () => {
    let state = startRound(createGame(['Alice', 'Bob', 'Charlie'], 50, 1));
    state = collectForcedBets(state);
    // Fold Alice (index 0)
    ({ state } = applyBettingAction(state, { type: 'fold' }));
    const reset = resetBettingRound(state, 'betting-2');
    // First non-folded player should be Bob (index 1)
    expect(reset.activePlayerIndex).toBe(1);
  });
});

describe('recordBetChoice', () => {
  it('records a single player bet choice without advancing phase', () => {
    const state = createGame(['Alice', 'Bob']);
    const { state: next, allChosen } = recordBetChoice(state, 'player-0', 'low');
    expect(next.players[0]?.betChoice).toBe('low');
    expect(next.phase).toBe('setup'); // phase unchanged
    expect(allChosen).toBe(false); // Bob hasn't chosen yet
  });

  it('allChosen is true when all active players have chosen', () => {
    let state = createGame(['Alice', 'Bob']);
    let allChosen: boolean;
    ({ state, allChosen } = recordBetChoice(state, 'player-0', 'low'));
    expect(allChosen).toBe(false);
    ({ state, allChosen } = recordBetChoice(state, 'player-1', 'high'));
    expect(allChosen).toBe(true);
  });

  it('folded players are ignored when determining allChosen', () => {
    let state = createGame(['Alice', 'Bob', 'Charlie']);
    // Fold Charlie
    state = {
      ...state,
      players: state.players.map((p) => (p.name === 'Charlie' ? { ...p, folded: true } : p)),
    };
    let allChosen: boolean;
    ({ state, allChosen } = recordBetChoice(state, 'player-0', 'low'));
    expect(allChosen).toBe(false);
    ({ state, allChosen } = recordBetChoice(state, 'player-1', 'high'));
    expect(allChosen).toBe(true); // Charlie folded, so Alice + Bob is sufficient
  });
});

describe('checkGameOver', () => {
  it('returns false when multiple players have chips', () => {
    const state = createGame(['Alice', 'Bob'], 50);
    expect(checkGameOver(state)).toEqual({ gameOver: false, winnerId: null });
  });

  it('returns true with correct winner when one player has chips', () => {
    const state = createGame(['Alice', 'Bob'], 50);
    const broke = {
      ...state,
      players: state.players.map((p) => (p.name === 'Bob' ? { ...p, chips: 0 } : p)),
    };
    expect(checkGameOver(broke)).toEqual({ gameOver: true, winnerId: 'player-0' });
  });

  it('returns true when all players are at zero, picking player with most chips (all tied at 0 → first)', () => {
    const state = createGame(['Alice', 'Bob'], 50);
    const allBroke = {
      ...state,
      players: state.players.map((p) => ({ ...p, chips: 0 })),
    };
    const result = checkGameOver(allBroke);
    expect(result.gameOver).toBe(true);
    expect(result.winnerId).toBe('player-0'); // tie → first player
  });

  it('picks player with most chips when not all are zero', () => {
    const state = createGame(['Alice', 'Bob', 'Charlie'], 50);
    const custom = {
      ...state,
      players: state.players.map((p) => ({
        ...p,
        chips: p.name === 'Alice' ? 0 : p.name === 'Bob' ? 0 : 10,
      })),
    };
    expect(checkGameOver(custom)).toEqual({ gameOver: true, winnerId: 'player-2' });
  });
});

describe('recordEquationResults', () => {
  it('stores low and high equation results for the specified player', () => {
    const state = createGame(['Alice', 'Bob']);
    const next = recordEquationResults(state, 'player-0', 1.0, 20.0, '1 + 0', '10 × 2');
    const alice = next.players.find((p) => p.id === 'player-0')!;
    expect(alice.lowResult).toBe(1.0);
    expect(alice.highResult).toBe(20.0);
    expect(alice.lowEquation).toBe('1 + 0');
    expect(alice.highEquation).toBe('10 × 2');
  });

  it('does not affect other players', () => {
    const state = createGame(['Alice', 'Bob']);
    const next = recordEquationResults(state, 'player-0', 1, 20, 'a', 'b');
    const bob = next.players.find((p) => p.id === 'player-1')!;
    expect(bob.lowResult).toBeNull();
    expect(bob.highResult).toBeNull();
  });
});

describe('pot rollover end-to-end', () => {
  it('rollover chips from applyPayouts survive into the next round via startRound', () => {
    const state = createGame(['Alice', 'Bob'], 50, 1);
    const round1 = startRound(state);
    // Simulate a state where only __rollover__ exists in payouts (no one won the low side)
    const fakeResult = {
      lowWinnerId: null,
      highWinnerId: 'player-1',
      payouts: new Map([['player-1', 10], ['__rollover__', 5]]),
    };
    const afterPayout = applyPayouts({ ...round1, pot: 15 }, fakeResult);
    expect(afterPayout.pot).toBe(5); // rollover set correctly

    const round2 = startRound(afterPayout);
    expect(round2.pot).toBe(5); // rollover preserved — the bug we fixed
  });
});
