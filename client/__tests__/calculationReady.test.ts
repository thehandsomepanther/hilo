/**
 * Calculation-phase readiness, driven through gameStore in standalone mode.
 *
 * The invariant: a player counts as "ready" only while both of their equations
 * are actually submitted.  The host's "Proceed to Betting Phase 2" button is
 * gated on every active player being ready, so a stale ready flag lets the
 * phase advance while someone is still mid-edit — and they arrive at results
 * with a null equation, which forfeits that half of the pot.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { get } from 'svelte/store';
import {
  gameState, submitEquation, unsubmitEquation, setPlayerReady, _resetNetworkForTests,
} from '../gameStore';
import { createGame, startRound, collectForcedBets, dealSecretCards, initBettingRound } from '../../src/game';
import type { CalculationState, Dealing1State, DealtPlayer, Card, NumberCard } from '../../src/types';

afterEach(() => { _resetNetworkForTests(); });

const num = (value: NumberCard['value'], suit: NumberCard['suit'] = 'Gold'): NumberCard =>
  ({ kind: 'number', value, suit });

/**
 * A calculation state where every player holds exactly the cards needed for
 * the equation `2 + 3`, so submissions are predictable.
 */
function calculationState(): CalculationState {
  const dealt = dealSecretCards(collectForcedBets(startRound(
    createGame(['Alice', 'Bob'], 50, 90, false),
  )));
  const betting = initBettingRound(dealt as Dealing1State & { players: DealtPlayer[] }, 'betting-1');
  const players = betting.players.map((p) => ({
    ...p,
    secretCard: num(2),
    faceUpCards: [num(3, 'Silver')],
    personalOperators: [{ kind: 'operator', operator: '+' }] as Card[],
    lowEquation: null, highEquation: null, lowResult: null, highResult: null,
  })) as DealtPlayer[];
  return { ...betting, phase: 'calculation', players, readyPlayerIds: [] } as CalculationState;
}

const readyIds = () => (get(gameState) as CalculationState).readyPlayerIds;

/** Submit both equations for a player, the way the UI does. */
function submitBoth(playerId: string): void {
  expect(submitEquation(playerId, 'low', '2 + 3')).toBeNull();
  expect(submitEquation(playerId, 'high', '2 + 3')).toBeNull();
}

describe('calculation readiness', () => {
  it('marks a player ready once both equations are in', () => {
    gameState.set(calculationState());
    submitBoth('player-0');
    setPlayerReady('player-0');
    expect(readyIds()).toEqual(['player-0']);
  });

  it('withdraws readiness when a submitted equation is retracted', () => {
    gameState.set(calculationState());
    submitBoth('player-0');
    setPlayerReady('player-0');

    unsubmitEquation('player-0', 'low'); // the "Edit" button
    expect(readyIds()).toEqual([]);
    expect((get(gameState) as CalculationState).players[0]!.lowEquation).toBeNull();
  });

  it('leaves other players ready when one retracts', () => {
    gameState.set(calculationState());
    submitBoth('player-0');
    submitBoth('player-1');
    setPlayerReady('player-0');
    setPlayerReady('player-1');
    expect(readyIds()).toEqual(['player-0', 'player-1']);

    unsubmitEquation('player-1', 'high');
    expect(readyIds()).toEqual(['player-0']);
  });

  it('lets a player become ready again after resubmitting', () => {
    gameState.set(calculationState());
    submitBoth('player-0');
    setPlayerReady('player-0');
    unsubmitEquation('player-0', 'high');

    setPlayerReady('player-0');           // still missing an equation
    expect(readyIds()).toEqual([]);

    expect(submitEquation('player-0', 'high', '2 + 3')).toBeNull();
    setPlayerReady('player-0');
    expect(readyIds()).toEqual(['player-0']);
  });

  it('refuses readiness while an equation is missing', () => {
    gameState.set(calculationState());
    expect(submitEquation('player-0', 'low', '2 + 3')).toBeNull();

    setPlayerReady('player-0'); // only the low equation is in
    expect(readyIds()).toEqual([]);
  });
});
