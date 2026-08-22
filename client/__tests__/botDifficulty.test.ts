/**
 * Bot difficulty.
 *
 * The three profiles have to differ in ways a player would actually feel, and
 * the hard profile has to stay identical to the bot that shipped before
 * difficulty existed — `src/__tests__/solver.test.ts` covers that second half
 * by continuing to pass unmodified.
 *
 * The failure mode worth guarding hardest is a hard bot's raise: a raise above
 * the smallest active stack throws inside `applyBettingAction`, which kills the
 * round rather than degrading it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { rankedSolutions, pickCandidate, solveEquations } from '../bots/solver';
import { decideBet, decideBetChoice, decideMultiplication, maxRaiseAmount } from '../bots/strategy';
import { profileFor } from '../bots/difficulty';
import type { BotDifficulty } from '../bots/difficulty';
import { startBotRunner } from '../bots/botRunner';
import { gameState, _resetNetworkForTests } from '../gameStore';
import { applyBettingAction } from '../../src/game';
import type {
  BettingState, CalculationState, Card, DealtPlayer, NumberCard, OperatorCard,
} from '../../src/types';

const num = (value: NumberCard['value'], suit: NumberCard['suit'] = 'Gold'): NumberCard =>
  ({ kind: 'number', value, suit });
const op = (operator: OperatorCard['operator']): OperatorCard => ({ kind: 'operator', operator });

/** A hand with plenty of distinct reachable results, so a ranking exists to reach into. */
const HAND: Card[] = [num(5), num(3, 'Silver'), num(7, 'Bronze'), num(2, 'Black'), op('+'), op('-'), op('÷')];

function makePlayer(over: Partial<DealtPlayer> = {}): DealtPlayer {
  return {
    id: 'player-0', name: 'Bot', chips: 50,
    personalOperators: [op('+'), op('-'), op('÷')],
    secretCard: num(5),
    faceUpCards: [num(3, 'Silver'), num(7, 'Bronze'), num(2, 'Black')],
    currentBet: 0, folded: false, betChoice: null,
    lowEquation: null, highEquation: null, lowResult: null, highResult: null,
    ...over,
  };
}

const BASE = {
  deck: [], pot: 3, forcedBetAmount: 1, calculationTimeLimit: 90, round: 1,
  log: [] as string[], dealerIndex: 0, bettingLocked: false,
  enforceTimeLimit: false, chipHistory: [],
};

function bettingState(over: Partial<BettingState> = {}): BettingState {
  return {
    ...BASE, phase: 'betting-1',
    players: [makePlayer(), makePlayer({ id: 'player-1', name: 'Human' })],
    activePlayerIndex: 0, currentBet: 0, bettingActionsThisRound: 0,
    ...over,
  } as BettingState;
}

// ─── Ranking ──────────────────────────────────────────────────────────────────

describe('rankedSolutions', () => {
  it('ranks by distance to the target and holds one entry per distinct result', () => {
    const { low, high } = rankedSolutions(HAND);

    expect(low.length).toBeGreaterThan(1);
    for (let i = 1; i < low.length; i++) {
      expect(low[i]!.dist).toBeGreaterThanOrEqual(low[i - 1]!.dist);
    }
    for (let i = 1; i < high.length; i++) {
      expect(high[i]!.dist).toBeGreaterThanOrEqual(high[i - 1]!.dist);
    }

    // One candidate per result value — otherwise "the fifth-best answer" would
    // mean the fifth spelling of the best one.
    expect(new Set(low.map((c) => c.value)).size).toBe(low.length);
    expect(low.map((c) => c.dist)).toEqual(low.map((c) => Math.abs(c.value - 1)));
    expect(high.map((c) => c.dist)).toEqual(high.map((c) => Math.abs(c.value - 20)));
  });

  it('still reports the same best expressions as solveEquations', () => {
    const { low, high } = rankedSolutions(HAND);
    const { lowExpr, highExpr } = solveEquations(HAND);
    expect(lowExpr).toBe(low[0]!.expr);
    expect(highExpr).toBe(high[0]!.expr);
  });
});

describe('pickCandidate', () => {
  const ranked = rankedSolutions(HAND).low;

  it('always takes the best when there is no slack — this is the hard bot', () => {
    for (const r of [0, 0.4, 0.99]) {
      expect(pickCandidate(ranked, 0, () => r)!.expr).toBe(ranked[0]!.expr);
    }
  });

  it('reaches the far end of the window at full slack', () => {
    // rng just below 1 lands on the last entry of the window.
    expect(pickCandidate(ranked, 1, () => 0.999)).toBe(ranked[ranked.length - 1]);
    expect(pickCandidate(ranked, 1, () => 0)).toBe(ranked[0]);
  });

  it('keeps an easy bot inside its slice rather than anywhere in the list', () => {
    const worst = pickCandidate(ranked, 0.6, () => 0.999)!;
    const window = Math.floor(1 + 0.6 * (ranked.length - 1));
    expect(ranked.indexOf(worst)).toBe(window - 1);
    expect(ranked.indexOf(worst)).toBeLessThan(ranked.length - 1);
  });

  it('returns null for a hand with no valid expression', () => {
    expect(pickCandidate([], 0.5)).toBeNull();
  });
});

// ─── Betting ──────────────────────────────────────────────────────────────────

describe('decideBet', () => {
  it('folds a price an easy bot will not pay but a hard one will', () => {
    // 10 to call out of a 50 stack: 20% — over easy's flat 15%, under hard's
    // tolerance.  Strength is held below the raise threshold so this exercises
    // the call/fold branch rather than turning into a raise.
    const state = bettingState({ currentBet: 10 });
    const bot = state.players[0] as DealtPlayer;

    expect(decideBet(bot, state, profileFor('easy'), 0.5).type).toBe('fold');
    expect(decideBet(bot, state, profileFor('hard'), 0.5).type).toBe('call');
  });

  it('lets hand strength move the price a reading bot will pay', () => {
    const state = bettingState({ currentBet: 12 });
    const bot = state.players[0] as DealtPlayer;
    const medium = profileFor('medium');

    expect(decideBet(bot, state, medium, 1).type).toBe('call');    // can hit a target exactly
    expect(decideBet(bot, state, medium, 0).type).toBe('fold');    // hopeless hand, same price
  });

  it('checks rather than folding when staying in is free', () => {
    const state = bettingState({ currentBet: 0 });
    const bot = state.players[0] as DealtPlayer;
    expect(decideBet(bot, state, profileFor('easy'), 0).type).toBe('check');
  });

  it('raises on a strong hand only at hard, and never above the short stack', () => {
    const state = bettingState({
      players: [makePlayer({ chips: 50 }), makePlayer({ id: 'player-1', chips: 4 })],
    });
    const bot = state.players[0] as DealtPlayer;

    expect(decideBet(bot, state, profileFor('medium'), 1).type).toBe('check');

    const action = decideBet(bot, state, profileFor('hard'), 1);
    expect(action.type).toBe('raise');
    // The short stack can only ever cover 4 — anything more throws in the engine.
    if (action.type === 'raise') {
      expect(action.amount).toBeLessThanOrEqual(maxRaiseAmount(bot, state)!);
      expect(() => applyBettingAction(state, action)).not.toThrow();
    }
  });

  it('does not try to raise while betting is locked', () => {
    const state = bettingState({ bettingLocked: true, currentBet: 0 });
    const bot = state.players[0] as DealtPlayer;
    expect(maxRaiseAmount(bot, state)).toBeNull();
    expect(decideBet(bot, state, profileFor('hard'), 1).type).toBe('check');
  });
});

// ─── Declaration ──────────────────────────────────────────────────────────────

describe('decideBetChoice', () => {
  it('takes the closer side', () => {
    const bot = makePlayer({ lowResult: 1, highResult: 3 });
    expect(decideBetChoice(bot, profileFor('medium'), () => 0.99)).toBe('low');
    expect(decideBetChoice(makePlayer({ lowResult: 15, highResult: 19 }), profileFor('medium'), () => 0.99))
      .toBe('high');
  });

  it('declares swing at hard only when both sides are all but exact', () => {
    const exact = makePlayer({ lowResult: 1, highResult: 20 });
    expect(decideBetChoice(exact, profileFor('hard'))).toBe('swing');

    // Strong on one side only — swing has to win both halves, so it is a losing bet.
    const lopsided = makePlayer({ lowResult: 1, highResult: 12 });
    expect(decideBetChoice(lopsided, profileFor('hard'))).toBe('low');
  });

  it('never swings below hard, however good the hand', () => {
    const exact = makePlayer({ lowResult: 1, highResult: 20 });
    expect(decideBetChoice(exact, profileFor('easy'), () => 0.99)).not.toBe('swing');
    expect(decideBetChoice(exact, profileFor('medium'), () => 0.99)).not.toBe('swing');
  });

  it('misreads the better side at the profile rate', () => {
    const bot = makePlayer({ lowResult: 1, highResult: 12 });
    expect(decideBetChoice(bot, profileFor('easy'), () => 0.1)).toBe('high');  // under 0.2 → mistake
    expect(decideBetChoice(bot, profileFor('easy'), () => 0.5)).toBe('low');   // over  0.2 → correct
    expect(decideBetChoice(bot, profileFor('hard'), () => 0)).toBe('low');     // hard never misreads
  });
});

// ─── × card ───────────────────────────────────────────────────────────────────

describe('decideMultiplication', () => {
  it('gives up + before - without evaluation', () => {
    const bot = makePlayer();
    expect(decideMultiplication(bot, profileFor('easy'))).toEqual({ accept: true, discard: '+' });
    expect(decideMultiplication(bot, profileFor('medium'))).toEqual({ accept: true, discard: '+' });
  });

  it('declines when it holds neither + nor -', () => {
    const bot = makePlayer({ personalOperators: [op('÷')] });
    for (const level of ['easy', 'medium', 'hard'] as const) {
      expect(decideMultiplication(bot, profileFor(level))).toEqual({ accept: false });
    }
  });

  it('returns a legal decision at hard, where the choice is solved out', () => {
    const bot = makePlayer();
    const decision = decideMultiplication(bot, profileFor('hard'));
    // Whatever it concludes, it may only ever discard an operator it holds.
    if (decision.accept) {
      expect(bot.personalOperators.some((o) => o.operator === decision.discard)).toBe(true);
    }
  });
});

// ─── End to end through the bot runner ────────────────────────────────────────

describe('difficulty reaches the equations bots actually submit', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.(); stop = null;
    _resetNetworkForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('has the easy bot submit a worse answer than the hard bot from the same hand', () => {
    vi.useFakeTimers();
    // Pin the draw to the far end of each bot's window: hard's window is one
    // entry wide whatever the roll, easy's is 60% of the ranking.
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const players = [
      makePlayer({ id: 'player-0', name: 'Easy bot' }),
      makePlayer({ id: 'player-1', name: 'Hard bot' }),
    ];
    stop = startBotRunner(new Map<string, BotDifficulty>([
      ['player-0', 'easy'],
      ['player-1', 'hard'],
    ]));

    gameState.set({
      ...BASE, phase: 'calculation', players, readyPlayerIds: [],
    } as CalculationState);
    vi.advanceTimersByTime(2000);

    const [easy, hard] = (get(gameState) as CalculationState).players as DealtPlayer[];
    for (const bot of [easy!, hard!]) {
      expect(bot.lowEquation).not.toBeNull();
      expect(bot.highEquation).not.toBeNull();
    }

    // Same cards, so the hard bot's results are the best reachable and the easy
    // bot's are strictly further out.
    const best = rankedSolutions([
      players[0]!.secretCard, ...players[0]!.faceUpCards, ...players[0]!.personalOperators,
    ]);
    expect(hard!.lowResult).toBe(best.low[0]!.value);
    expect(hard!.highResult).toBe(best.high[0]!.value);

    expect(Math.abs(easy!.lowResult! - 1)).toBeGreaterThan(Math.abs(hard!.lowResult! - 1));
    expect(Math.abs(easy!.highResult! - 20)).toBeGreaterThan(Math.abs(hard!.highResult! - 20));
  });
});
