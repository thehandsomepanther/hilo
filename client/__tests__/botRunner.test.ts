/**
 * Bot runner scheduling.
 *
 * Bots are driven by a `gameState` subscription that schedules one delayed
 * action per opportunity, deduplicated by key.  Two ways that goes wrong, both
 * of which hang the game rather than erroring:
 *
 *  - a key that names only the seat swallows every turn after the first, so a
 *    bot stops acting as soon as anyone raises;
 *  - a bot that submits equations but never declares itself ready leaves the
 *    host's "Proceed to Betting Phase 2" disabled forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { get } from 'svelte/store';
import { gameState, _resetNetworkForTests } from '../gameStore';
import { startBotRunner } from '../bots/botRunner';
import { applyBettingAction } from '../../src/game';
import type {
  BettingState, CalculationState, DealtPlayer, NumberCard, OperatorCard,
} from '../../src/types';

const num = (value: NumberCard['value'], suit: NumberCard['suit'] = 'Gold'): NumberCard =>
  ({ kind: 'number', value, suit });

function makePlayer(id: string, over: Partial<DealtPlayer> = {}): DealtPlayer {
  return {
    id, name: id, chips: 50,
    personalOperators: [{ kind: 'operator', operator: '+' }] as OperatorCard[],
    secretCard: num(2),
    faceUpCards: [num(3, 'Silver')],
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

function bettingState(activePlayerIndex: number): BettingState {
  return {
    ...BASE, phase: 'betting-1',
    players: [makePlayer('player-0'), makePlayer('player-1')],
    activePlayerIndex, currentBet: 0, bettingActionsThisRound: 0,
  };
}

function calculationState(): CalculationState {
  return {
    ...BASE, phase: 'calculation',
    players: [makePlayer('player-0'), makePlayer('player-1')],
    readyPlayerIds: [],
  };
}

const logLength = () => get(gameState)!.log.length;

describe('bot betting turns', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { stop?.(); stop = null; _resetNetworkForTests(); vi.useRealTimers(); });

  it('acts again when its seat comes round a second time in one betting round', () => {
    stop = startBotRunner(new Set(['player-0']));

    gameState.set(bettingState(0));
    vi.advanceTimersByTime(2000);
    const afterBot = get(gameState) as BettingState;
    expect(afterBot.log).toHaveLength(1);          // the bot acted
    expect(afterBot.activePlayerIndex).toBe(1);

    // The human raises, which re-opens betting and hands the turn back.
    const raised = applyBettingAction(afterBot, { type: 'raise', amount: 5 }).state;
    expect(raised.activePlayerIndex).toBe(0);
    gameState.set(raised);

    const before = logLength();
    vi.advanceTimersByTime(3000);
    expect(logLength()).toBeGreaterThan(before);
  });

  it('still acts only once for a single turn, however often the state re-renders', () => {
    stop = startBotRunner(new Set(['player-0']));

    const s = bettingState(0);
    gameState.set(s);
    gameState.set({ ...s, pot: 4 });   // an unrelated change, same action slot
    gameState.set({ ...s, pot: 5 });
    vi.advanceTimersByTime(3000);

    expect(logLength()).toBe(1);
  });

  it('does not act for a seat that is not a bot', () => {
    stop = startBotRunner(new Set(['player-1']));
    gameState.set(bettingState(0));   // human's turn
    vi.advanceTimersByTime(3000);
    expect(logLength()).toBe(0);
  });
});

describe('bot readiness in the calculation phase', () => {
  let stop: (() => void) | null = null;

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { stop?.(); stop = null; _resetNetworkForTests(); vi.useRealTimers(); });

  it('submits both equations and then declares itself ready', () => {
    stop = startBotRunner(new Set(['player-1']));
    gameState.set(calculationState());
    vi.advanceTimersByTime(2000);

    const s = get(gameState) as CalculationState;
    const bot = s.players[1]!;
    expect(bot.lowEquation).not.toBeNull();
    expect(bot.highEquation).not.toBeNull();
    // Without this the host can never leave the calculation phase.
    expect(s.readyPlayerIds).toEqual(['player-1']);
  });

  it('readies every bot, leaving human seats alone', () => {
    stop = startBotRunner(new Set(['player-0', 'player-1']));
    gameState.set({
      ...calculationState(),
      players: [makePlayer('player-0'), makePlayer('player-1'), makePlayer('player-2')],
    });
    vi.advanceTimersByTime(2000);

    const s = get(gameState) as CalculationState;
    expect(s.readyPlayerIds.sort()).toEqual(['player-0', 'player-1']);
    expect(s.players[2]!.lowEquation).toBeNull();
  });

  it('leaves a folded bot out of it', () => {
    stop = startBotRunner(new Set(['player-1']));
    gameState.set({
      ...calculationState(),
      players: [makePlayer('player-0'), makePlayer('player-1', { folded: true })],
    });
    vi.advanceTimersByTime(2000);

    const s = get(gameState) as CalculationState;
    expect(s.readyPlayerIds).toEqual([]);
    expect(s.players[1]!.lowEquation).toBeNull();
  });
});
