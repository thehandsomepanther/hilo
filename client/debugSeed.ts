/**
 * Debug-only helpers for seeding the game store with pre-built states.
 * Only imported by testMain.ts — never by production code.
 */

import { gameState } from './gameStore';
import { buildPersonalOperators } from '../src/deck';
import type { GameOverState, UndealPlayer } from '../src/types';

function undeal(id: string, name: string, chips: number): UndealPlayer {
  return {
    id,
    name,
    chips,
    personalOperators: buildPersonalOperators(),
    currentBet: 0,
    folded: false,
    secretCard: null,
    faceUpCards: [],
  };
}

/**
 * Seeds the store with a finished 3-player game so the game-over screen
 * (including the chip history chart) renders immediately without playing.
 *
 * All chip totals sum to 60 each round (3 players × 20 starting chips).
 */
export function seedGameOver(): void {
  // prettier-ignore
  const chipHistory: Array<Record<string, number>> = [
    { 'player-0': 20, 'player-1': 20, 'player-2': 20 }, // start
    { 'player-0': 25, 'player-1': 15, 'player-2': 20 }, // round 1
    { 'player-0': 22, 'player-1': 18, 'player-2': 20 }, // round 2
    { 'player-0': 30, 'player-1': 10, 'player-2': 20 }, // round 3
    { 'player-0': 27, 'player-1': 10, 'player-2': 23 }, // round 4
    { 'player-0': 33, 'player-1':  8, 'player-2': 19 }, // round 5
    { 'player-0': 40, 'player-1':  5, 'player-2': 15 }, // round 6
    { 'player-0': 47, 'player-1':  5, 'player-2':  8 }, // round 7
    { 'player-0': 52, 'player-1':  5, 'player-2':  3 }, // round 8
    { 'player-0': 55, 'player-1':  5, 'player-2':  0 }, // round 9  — Charlie out
    { 'player-0': 60, 'player-1':  0, 'player-2':  0 }, // round 10 — game over
  ];

  const final = chipHistory[chipHistory.length - 1]!;

  const state: GameOverState = {
    phase: 'game-over',
    winnerId: 'player-0',
    players: [
      undeal('player-0', 'Alice',   final['player-0']!),
      undeal('player-1', 'Bob',     final['player-1']!),
      undeal('player-2', 'Charlie', final['player-2']!),
    ],
    deck: [],
    pot: 0,
    forcedBetAmount: 10,
    calculationTimeLimit: 90,
    round: 10,
    log: ['[seeded state — debug only]'],
    dealerIndex: 0,
    bettingLocked: false,
    enforceTimeLimit: false,
    chipHistory,
  };

  gameState.set(state);
}
