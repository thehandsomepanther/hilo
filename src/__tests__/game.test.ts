import { describe, it, expect } from 'vitest';
import {
  createGame,
  startRound,
  collectForcedBets,
  applyBettingAction,
  isBettingComplete,
  advanceFromBetting,
  applyBetChoices,
  recordBetChoice,
  checkGameOver,
  recordEquationResults,
  advanceFromHighLowBet,
  advanceFromResults,
} from '../game';
import { applyPayouts } from '../results';
import {
  MultiplicationDecision, DealtPlayer, UndealPlayer, OperatorCard, Player,
  ForcedBetState, Dealing1State, Dealing2State, BettingState,
  HighLowBetState, CalculationState, ResultsState, SetupState, Card,
} from '../types';
import { startDealPhase1, startDealPhase2, DealStep } from '../../client/dealing';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Drive a DealStep to completion, supplying decisions via `decide`.
 * Defaults to always declining × cards.
 */
function driveDealing<T>(
  step: DealStep<T>,
  decide: (player: Player) => MultiplicationDecision = () => ({ accept: false }),
): T {
  let current = step;
  while (current.status === 'awaiting-decision') {
    current = current.resume(decide(current.player));
  }
  return current.state;
}

function makeUndealPlayer(overrides: Partial<UndealPlayer> & { id: string }): UndealPlayer {
  return {
    name: overrides.id,
    chips: 50,
    personalOperators: [
      { kind: 'operator', operator: '+' },
      { kind: 'operator', operator: '-' },
      { kind: 'operator', operator: '÷' },
    ],
    currentBet: 0,
    folded: false,
    secretCard: null,
    faceUpCards: [],
    ...overrides,
  };
}

function makeDealtPlayer(overrides: Partial<DealtPlayer> & { id: string }): DealtPlayer {
  return {
    name: overrides.id,
    chips: 10,
    personalOperators: [],
    secretCard: { kind: 'number', value: 5, suit: 'Gold' },
    faceUpCards: [],
    currentBet: 0,
    folded: false,
    betChoice: null,
    lowEquation: null,
    highEquation: null,
    lowResult: null,
    highResult: null,
    ...overrides,
  };
}

function makeBettingState(players: DealtPlayer[], phase: 'betting-1' | 'betting-2' = 'betting-1'): BettingState {
  return {
    phase,
    players,
    deck: [],
    pot: 10,
    forcedBetAmount: 1,
    calculationTimeLimit: 90,
    round: 1,
    log: [],
    activePlayerIndex: 0,
    currentBet: 0,
    bettingActionsThisRound: 0,
  };
}

function makeHighLowState(players: DealtPlayer[]): HighLowBetState {
  return {
    phase: 'high-low-bet',
    players,
    deck: [],
    pot: 20,
    forcedBetAmount: 1,
    calculationTimeLimit: 90,
    round: 1,
    log: [],
  };
}

// ─── createGame ───────────────────────────────────────────────────────────────

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

  it('players start as UndealPlayer (secretCard null, faceUpCards empty)', () => {
    const state = createGame(['Alice', 'Bob']);
    state.players.forEach((p) => {
      expect(p.secretCard).toBeNull();
      expect(p.faceUpCards).toHaveLength(0);
    });
  });
});

// ─── startRound ───────────────────────────────────────────────────────────────

describe('startRound', () => {
  it('increments round and returns forced-bet phase', () => {
    const state = createGame(['Alice', 'Bob']);
    const next = startRound(state);
    expect(next.round).toBe(1);
    expect(next.phase).toBe('forced-bet');
  });

  it('preserves rollover pot from applyPayouts', () => {
    const state = createGame(['Alice', 'Bob']);
    const withRollover: SetupState = { ...state, pot: 7 };
    const next = startRound(withRollover);
    expect(next.pot).toBe(7);
  });

  it('new game starts with pot 0', () => {
    const state = createGame(['Alice', 'Bob']);
    expect(startRound(state).pot).toBe(0);
  });
});

// ─── collectForcedBets ────────────────────────────────────────────────────────

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

// ─── dealing phases ───────────────────────────────────────────────────────────

describe('dealing phases', () => {
  function dealingState(): Dealing1State {
    const base = startRound(createGame(['Alice', 'Bob', 'Charlie'], 50));
    return collectForcedBets(base);
  }

  it('phase 1 gives every active player a secret card and ≥2 face-up cards', () => {
    const dealt = driveDealing(startDealPhase1(dealingState()));
    dealt.players.forEach((p) => {
      expect(p.secretCard).not.toBeNull();
      expect(p.faceUpCards.length).toBeGreaterThanOrEqual(2);
    });
    expect(dealt.phase).toBe('betting-1');
  });

  it('secret card is always a number card', () => {
    const dealt = driveDealing(startDealPhase1(dealingState()));
    dealt.players.forEach((p) => {
      expect(p.secretCard.kind).toBe('number');
    });
  });

  it('phase 2 gives one more face-up card', () => {
    const dealt1 = driveDealing(startDealPhase1(dealingState()));
    const countBefore = dealt1.players.map((p) => p.faceUpCards.length);
    const dealing2: Dealing2State = { ...dealt1, phase: 'dealing-2' };
    const dealt2 = driveDealing(startDealPhase2(dealing2));
    dealt2.players.forEach((p, i) => {
      expect(p.faceUpCards.length).toBeGreaterThanOrEqual((countBefore[i] ?? 0) + 1);
    });
  });
});

// ─── dealing — × card handling ────────────────────────────────────────────────

describe('dealing — × card handling', () => {
  /**
   * Build a Dealing1State whose deck is fully controlled so that Alice's first
   * face-up draw is guaranteed to be a × card.
   *
   * Deck layout:
   *   [0] Alice's secret (number, consumed by drawNumberCard)
   *   [1] Bob's secret   (number, consumed by drawNumberCard)
   *   [2] × card          — Alice's first face-up draw
   *   [3] bonus number    — paired with ×
   *   [4] extra number    — forced after a symbol draw (wasSymbol=true on drawCount 0)
   *   [5-6] Bob's two face-up draws
   */
  function dealingStateWithMultiplication(): Dealing1State {
    const game = startRound(createGame(['Alice', 'Bob'], 50));
    const dealing = collectForcedBets(game);
    const deck: Card[] = [
      { kind: 'number', value: 1, suit: 'Gold' },
      { kind: 'number', value: 2, suit: 'Gold' },
      { kind: 'operator', operator: '×' },
      { kind: 'number', value: 3, suit: 'Gold' },
      { kind: 'number', value: 4, suit: 'Gold' },
      { kind: 'number', value: 5, suit: 'Gold' },
      { kind: 'number', value: 6, suit: 'Gold' },
    ];
    return { ...dealing, deck };
  }

  it('step machine suspends when a × card is drawn', () => {
    const step = startDealPhase1(dealingStateWithMultiplication());
    expect(step.status).toBe('awaiting-decision');
  });

  it('accepting × removes a personal operator and adds × to face-up cards', () => {
    const step = startDealPhase1(dealingStateWithMultiplication());
    expect(step.status).toBe('awaiting-decision');
    if (step.status !== 'awaiting-decision') return;

    const accept: MultiplicationDecision = { accept: true, discard: '+' };
    const final = driveDealing(step.resume(accept));

    const alice = final.players.find((p) => p.name === 'Alice')!;
    expect(alice.faceUpCards.some((c) => c.kind === 'operator' && c.operator === '×')).toBe(true);
    expect(alice.personalOperators.some((op) => op.operator === '+')).toBe(false);
    expect(alice.personalOperators).toHaveLength(2);
  });

  it('declining × keeps all personal operators and still grants a bonus number', () => {
    const step = startDealPhase1(dealingStateWithMultiplication());
    expect(step.status).toBe('awaiting-decision');
    if (step.status !== 'awaiting-decision') return;

    const decline: MultiplicationDecision = { accept: false };
    const final = driveDealing(step.resume(decline));

    const alice = final.players.find((p) => p.name === 'Alice')!;
    expect(alice.faceUpCards.some((c) => c.kind === 'operator' && c.operator === '×')).toBe(false);
    expect(alice.personalOperators).toHaveLength(3);
    expect(alice.faceUpCards.filter((c) => c.kind === 'number').length).toBeGreaterThanOrEqual(1);
  });
});

// ─── betting ──────────────────────────────────────────────────────────────────

describe('betting', () => {
  function bettingState() {
    const base = startRound(createGame(['Alice', 'Bob', 'Charlie'], 50, 1));
    const dealing = collectForcedBets(base);
    return driveDealing(startDealPhase1(dealing));
  }

  it('raise increases pot and currentBet', () => {
    const state = bettingState();
    const { state: next } = applyBettingAction(state, { type: 'raise', amount: 5 });
    expect(next.currentBet).toBe(5);
    expect(next.pot).toBeGreaterThan(state.pot);
  });

  it('call matches current bet', () => {
    let state: BettingState = bettingState();
    ({ state } = applyBettingAction(state, { type: 'raise', amount: 5 }));
    const callerChipsBefore = state.players[state.activePlayerIndex]?.chips ?? 0;
    ({ state } = applyBettingAction(state, { type: 'call' }));
    const prevIdx = (state.activePlayerIndex + state.players.length - 1) % state.players.length;
    const callerChipsAfter = state.players[prevIdx]?.chips ?? 0;
    expect(callerChipsAfter).toBeLessThan(callerChipsBefore);
  });

  it('check is allowed when no raise has been made', () => {
    const state = bettingState();
    const reset: BettingState = { ...state, currentBet: 0, bettingActionsThisRound: 0, players: state.players.map((p) => ({ ...p, currentBet: 0 })) };
    expect(() => applyBettingAction(reset, { type: 'check' })).not.toThrow();
  });

  it('check throws when there is an outstanding bet', () => {
    let state: BettingState = bettingState();
    ({ state } = applyBettingAction(state, { type: 'raise', amount: 5 }));
    expect(() => applyBettingAction(state, { type: 'check' })).toThrow();
  });

  it('fold removes player from active pool', () => {
    const state = bettingState();
    const { state: next } = applyBettingAction(state, { type: 'fold' });
    expect(next.players.filter((p) => p.folded)).toHaveLength(1);
  });

  it('round is NOT complete right after a reset (no one has acted)', () => {
    const state = bettingState();
    const reset: BettingState = { ...state, bettingActionsThisRound: 0 };
    expect(isBettingComplete(reset)).toBe(false);
  });

  it('round is complete after all active players have checked', () => {
    const state = bettingState();
    const reset: BettingState = { ...state, currentBet: 0, bettingActionsThisRound: 0, players: state.players.map((p) => ({ ...p, currentBet: 0 })) };
    let s: BettingState = reset;
    const active = s.players.filter((p) => !p.folded);
    for (let i = 0; i < active.length; i++) {
      ({ state: s } = applyBettingAction(s, { type: 'check' }));
    }
    expect(isBettingComplete(s)).toBe(true);
  });

  it('round is complete when only one player remains', () => {
    let state: BettingState = bettingState();
    ({ state } = applyBettingAction(state, { type: 'fold' }));
    ({ state } = applyBettingAction(state, { type: 'fold' }));
    expect(isBettingComplete(state)).toBe(true);
  });

  it('raise below current bet throws', () => {
    let state: BettingState = bettingState();
    ({ state } = applyBettingAction(state, { type: 'raise', amount: 5 }));
    expect(() => applyBettingAction(state, { type: 'raise', amount: 3 })).toThrow();
  });

  it('all-in call caps at player chips', () => {
    const players = [
      makeDealtPlayer({ id: 'a', chips: 9, currentBet: 1 }),
      makeDealtPlayer({ id: 'b', chips: 2, currentBet: 1 }),
    ];
    let state = makeBettingState(players);
    state = { ...state, currentBet: 1 };
    // A raises to 3 — the max allowed (B's effective stack is chips+currentBet = 3)
    ({ state } = applyBettingAction(state, { type: 'raise', amount: 3 }));
    // B can only pay 2 more chips (to match the raise of 3)
    const bobBefore = state.players.find((p) => p.id === 'b')!;
    ({ state } = applyBettingAction(state, { type: 'call' }));
    const bobAfter = state.players.find((p) => p.id === 'b')!;
    expect(bobAfter.chips).toBe(0);
    expect(bobAfter.currentBet).toBe(bobBefore.currentBet + 2);
  });
});

// ─── advanceFromBetting ───────────────────────────────────────────────────────

describe('advanceFromBetting', () => {
  it('moves to dealing-2 after betting-1 with multiple active players', () => {
    const players = [makeDealtPlayer({ id: 'a' }), makeDealtPlayer({ id: 'b' })];
    const state = makeBettingState(players, 'betting-1');
    const next = advanceFromBetting(state);
    expect(next.phase).toBe('dealing-2');
  });

  it('moves to high-low-bet after betting-2', () => {
    const players = [makeDealtPlayer({ id: 'a' }), makeDealtPlayer({ id: 'b' })];
    const state = makeBettingState(players, 'betting-2');
    const next = advanceFromBetting(state);
    expect(next.phase).toBe('high-low-bet');
  });

  it('moves to results with last-player-standing when one active player remains', () => {
    const players = [
      makeDealtPlayer({ id: 'a', folded: false }),
      makeDealtPlayer({ id: 'b', folded: true }),
    ];
    const state = makeBettingState(players, 'betting-1');
    const next = advanceFromBetting(state);
    expect(next.phase).toBe('results');
    if (next.phase === 'results') {
      expect(next.result.kind).toBe('last-player-standing');
    }
  });
});

// ─── applyBetChoices ──────────────────────────────────────────────────────────

describe('applyBetChoices', () => {
  it('records choices', () => {
    const players = [makeDealtPlayer({ id: 'player-0' }), makeDealtPlayer({ id: 'player-1' })];
    const state = makeHighLowState(players);
    const choices = new Map<string, 'high' | 'low' | 'swing'>([['player-0', 'low'], ['player-1', 'high']]);
    const next = applyBetChoices(state, choices);
    expect(next.players[0]?.betChoice).toBe('low');
    expect(next.players[1]?.betChoice).toBe('high');
  });
});

// ─── recordBetChoice ──────────────────────────────────────────────────────────

describe('recordBetChoice', () => {
  it('records a single player bet choice without advancing phase', () => {
    const players = [makeDealtPlayer({ id: 'player-0' }), makeDealtPlayer({ id: 'player-1' })];
    const state = makeHighLowState(players);
    const { state: next, allChosen } = recordBetChoice(state, 'player-0', 'low');
    expect(next.players[0]?.betChoice).toBe('low');
    expect(next.phase).toBe('high-low-bet');
    expect(allChosen).toBe(false);
  });

  it('allChosen is true when all active players have chosen', () => {
    const players = [makeDealtPlayer({ id: 'player-0' }), makeDealtPlayer({ id: 'player-1' })];
    let state = makeHighLowState(players);
    let allChosen: boolean;
    ({ state, allChosen } = recordBetChoice(state, 'player-0', 'low'));
    expect(allChosen).toBe(false);
    ({ state, allChosen } = recordBetChoice(state, 'player-1', 'high'));
    expect(allChosen).toBe(true);
  });

  it('folded players are ignored for allChosen', () => {
    const players = [
      makeDealtPlayer({ id: 'player-0' }),
      makeDealtPlayer({ id: 'player-1' }),
      makeDealtPlayer({ id: 'player-2', folded: true }),
    ];
    let state = makeHighLowState(players);
    let allChosen: boolean;
    ({ state, allChosen } = recordBetChoice(state, 'player-0', 'low'));
    expect(allChosen).toBe(false);
    ({ state, allChosen } = recordBetChoice(state, 'player-1', 'high'));
    expect(allChosen).toBe(true);
  });
});

// ─── advanceFromHighLowBet ────────────────────────────────────────────────────

describe('advanceFromHighLowBet', () => {
  it('transitions to results with a RoundResult', () => {
    const players = [
      makeDealtPlayer({ id: 'a', betChoice: 'low',  lowResult: 1,  secretCard: { kind: 'number', value: 1, suit: 'Gold' } }),
      makeDealtPlayer({ id: 'b', betChoice: 'high', highResult: 20, secretCard: { kind: 'number', value: 9, suit: 'Gold' } }),
    ];
    const state = makeHighLowState(players);
    const next = advanceFromHighLowBet(state);
    expect(next.phase).toBe('results');
    expect(next.result).toBeDefined();
  });
});

// ─── advanceFromResults ───────────────────────────────────────────────────────

describe('advanceFromResults', () => {
  it('starts a new round when players still have chips', () => {
    const players = [makeDealtPlayer({ id: 'a', chips: 10 }), makeDealtPlayer({ id: 'b', chips: 10 })];
    const state: ResultsState = {
      phase: 'results',
      players,
      deck: [],
      pot: 20,
      forcedBetAmount: 1,
      calculationTimeLimit: 90,
      round: 1,
      log: [],
      result: { kind: 'contested', lowWinnerId: 'a', highWinnerId: 'b', payouts: { a: 10, b: 10 } },
    };
    const next = advanceFromResults(state);
    expect(next.phase).toBe('forced-bet');
    expect(next.round).toBe(2);
  });

  it('moves to game-over when one player has all chips', () => {
    const players = [makeDealtPlayer({ id: 'a', chips: 0 }), makeDealtPlayer({ id: 'b', chips: 10 })];
    const state: ResultsState = {
      phase: 'results',
      players,
      deck: [],
      pot: 20,
      forcedBetAmount: 1,
      calculationTimeLimit: 90,
      round: 1,
      log: [],
      result: { kind: 'contested', lowWinnerId: 'b', highWinnerId: 'b', payouts: { b: 20 } },
    };
    const next = advanceFromResults(state);
    expect(next.phase).toBe('game-over');
    if (next.phase === 'game-over') expect(next.winnerId).toBe('b');
  });
});

// ─── checkGameOver ────────────────────────────────────────────────────────────

describe('checkGameOver', () => {
  it('returns false when multiple players have chips', () => {
    const state = createGame(['Alice', 'Bob'], 50);
    expect(checkGameOver(state)).toEqual({ gameOver: false, winnerId: null });
  });

  it('returns true with correct winner when one player has chips', () => {
    const state = createGame(['Alice', 'Bob'], 50);
    const broke: SetupState = { ...state, players: state.players.map((p) => p.name === 'Bob' ? { ...p, chips: 0 } : p) };
    expect(checkGameOver(broke)).toEqual({ gameOver: true, winnerId: 'player-0' });
  });

  it('all at zero — picks first player', () => {
    const state = createGame(['Alice', 'Bob'], 50);
    const allBroke: SetupState = { ...state, players: state.players.map((p) => ({ ...p, chips: 0 })) };
    const result = checkGameOver(allBroke);
    expect(result.gameOver).toBe(true);
    expect(result.winnerId).toBe('player-0');
  });
});

// ─── recordEquationResults ────────────────────────────────────────────────────

describe('recordEquationResults', () => {
  function calcState(): CalculationState {
    const base = startRound(createGame(['Alice', 'Bob'], 50));
    const dealing = collectForcedBets(base);
    const bet1 = driveDealing(startDealPhase1(dealing));
    const dealing2: Dealing2State = { ...bet1, phase: 'dealing-2' };
    return driveDealing(startDealPhase2(dealing2));
  }

  it('stores low and high equation results for the specified player', () => {
    const state = calcState();
    const next = recordEquationResults(state, 'player-0', 1.0, 20.0, '1 + 0', '10 × 2');
    const alice = next.players.find((p) => p.id === 'player-0')!;
    expect(alice.lowResult).toBe(1.0);
    expect(alice.highResult).toBe(20.0);
    expect(alice.lowEquation).toBe('1 + 0');
    expect(alice.highEquation).toBe('10 × 2');
  });

  it('does not affect other players', () => {
    const state = calcState();
    const next = recordEquationResults(state, 'player-0', 1, 20, 'a', 'b');
    const bob = next.players.find((p) => p.id === 'player-1')!;
    expect(bob.lowResult).toBeNull();
    expect(bob.highResult).toBeNull();
  });
});

// ─── pot rollover end-to-end ──────────────────────────────────────────────────

describe('pot rollover end-to-end', () => {
  it('rollover chips survive from applyPayouts through startRound', () => {
    const players = [makeDealtPlayer({ id: 'a', chips: 10 }), makeDealtPlayer({ id: 'b', chips: 10 })];
    const resultsState: ResultsState = {
      phase: 'results',
      players,
      deck: [],
      pot: 15,
      forcedBetAmount: 1,
      calculationTimeLimit: 90,
      round: 1,
      log: [],
      result: { kind: 'contested', lowWinnerId: null, highWinnerId: 'b', payouts: { b: 10, __rollover__: 5 } },
    };
    const afterPayout = applyPayouts(resultsState);
    expect(afterPayout.pot).toBe(5);
    const round2 = startRound(afterPayout);
    expect(round2.pot).toBe(5); // rollover preserved — key regression test
  });
});
