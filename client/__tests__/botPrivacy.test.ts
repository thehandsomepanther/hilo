/**
 * Seat ownership in a standalone game against bots.
 *
 * Standalone has no seat assignment — pass-and-play shares one screen, so
 * `localPlayerId` stays null and every seat used to count as "ours".  With
 * bots at the table that reveals their secret cards and equations, and hands
 * their turns to the human.  `controlsSeat` is the predicate the UI uses
 * instead, and the high/low submission has to cope with only some of the
 * seats reporting in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
  gameState, lobbyState, localPlayerId, controlsSeat, botPlayerIds,
  doSubmitBetChoices, submitBotBetChoice, _resetNetworkForTests,
} from '../gameStore';
import { createGame, startRound, collectForcedBets, dealSecretCards, initBettingRound } from '../../src/game';
import type { Dealing1State, DealtPlayer, HighLowBetState, NumberCard, Card } from '../../src/types';

afterEach(() => { _resetNetworkForTests(); });

const num = (value: NumberCard['value'], suit: NumberCard['suit'] = 'Gold'): NumberCard =>
  ({ kind: 'number', value, suit });

/** Seat 0 is the human, seats 1–2 are bots — the shape of a single-player game. */
function seatOneHumanTwoBots(): void {
  lobbyState.set({
    players: [
      { name: 'Alice', isBot: false },
      { name: 'Bot 1', isBot: true },
      { name: 'Bot 2', isBot: true },
    ],
    startingChips: 50,
    enforceTimeLimit: false,
  });
}

/**
 * A high/low-bet state where every player holds `2 + 3` and has both
 * equations in, so `resolveRound` has real results to compare if the phase
 * does advance.
 */
function highLowState(): HighLowBetState {
  const dealt = dealSecretCards(collectForcedBets(startRound(
    createGame(['Alice', 'Bot 1', 'Bot 2'], 50, 90, false),
  )));
  const betting = initBettingRound(dealt as Dealing1State & { players: DealtPlayer[] }, 'betting-1');
  const players = betting.players.map((p) => ({
    ...p,
    secretCard: num(2),
    faceUpCards: [num(3, 'Silver')],
    personalOperators: [{ kind: 'operator', operator: '+' }] as Card[],
    betChoice: null,
    lowEquation: '2 + 3', lowResult: 5,
    highEquation: '2 + 3', highResult: 5,
  })) as DealtPlayer[];
  return { ...betting, phase: 'high-low-bet', players } as HighLowBetState;
}

describe('controlsSeat', () => {
  it('claims the human seats but not the bots in a standalone game', () => {
    seatOneHumanTwoBots();
    const controls = get(controlsSeat);
    expect(controls('player-0')).toBe(true);
    expect(controls('player-1')).toBe(false);
    expect(controls('player-2')).toBe(false);
    expect(get(botPlayerIds)).toEqual(new Set(['player-1', 'player-2']));
  });

  it('claims every seat when a standalone game is all human', () => {
    lobbyState.set({
      players: [{ name: 'Alice', isBot: false }, { name: 'Bob', isBot: false }],
      startingChips: 50,
      enforceTimeLimit: false,
    });
    const controls = get(controlsSeat);
    expect(controls('player-0')).toBe(true);
    expect(controls('player-1')).toBe(true);
  });

  it('claims only our own seat once the network has assigned one', () => {
    seatOneHumanTwoBots();
    localPlayerId.set('player-0');
    const controls = get(controlsSeat);
    expect(controls('player-0')).toBe(true);
    expect(controls('player-1')).toBe(false);
  });
});

describe('standalone high/low submission with bots', () => {
  it('waits for the bots rather than resolving the round without them', () => {
    seatOneHumanTwoBots();
    gameState.set(highLowState());

    // The human reveals before either bot has decided.
    doSubmitBetChoices(new Map([['player-0', 'low' as const]]));

    const state = get(gameState) as HighLowBetState;
    expect(state.phase).toBe('high-low-bet');
    expect(state.players[0]!.betChoice).toBe('low');
    // Nothing is revealed in the log while a choice is still outstanding.
    expect(state.log.join(' ')).not.toContain('chose');
  });

  it('resolves once the last bot has chosen', () => {
    seatOneHumanTwoBots();
    gameState.set(highLowState());

    doSubmitBetChoices(new Map([['player-0', 'low' as const]]));
    submitBotBetChoice('player-1', 'high');
    expect(get(gameState)!.phase).toBe('high-low-bet');

    submitBotBetChoice('player-2', 'high');
    expect(get(gameState)!.phase).toBe('results');
  });

  it('still resolves immediately when every seat reports at once', () => {
    lobbyState.set({
      players: [{ name: 'Alice', isBot: false }, { name: 'Bob', isBot: false }, { name: 'Carol', isBot: false }],
      startingChips: 50,
      enforceTimeLimit: false,
    });
    gameState.set(highLowState());

    doSubmitBetChoices(new Map([
      ['player-0', 'low' as const],
      ['player-1', 'high' as const],
      ['player-2', 'high' as const],
    ]));

    const state = get(gameState)!;
    expect(state.phase).toBe('results');
    expect(state.log.join(' ')).toContain('chose');
  });
});
