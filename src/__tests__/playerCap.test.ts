/**
 * Table-size limit.
 *
 * Dealing consumes exactly 4 number cards per player per round — 1 secret, 2 in
 * phase 1, 1 in phase 2 — regardless of how the symbols fall, because a √ or an
 * accepted × eats both of that player's phase-1 draw slots.  With 44 number
 * cards that puts the ceiling at 11, with no slack at all: 11 players use every
 * single one.  Past it the deck runs dry and dealing throws part-way through.
 */
import { describe, it, expect } from 'vitest';
import { createGame, startRound, collectForcedBets } from '../game';
import { MAX_PLAYERS, MIN_PLAYERS } from '../deck';
import { startDealPhase1, startDealPhase2 } from '../../client/dealing';
import type { DealStep } from '../../client/dealing';
import type { Dealing2State, MultiplicationDecision, Player } from '../types';

const names = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`);

/** Accept every × — the branch that consumes the most cards. */
const accept = (p: Player): MultiplicationDecision =>
  p.personalOperators.some((o) => o.operator === '+')
    ? { accept: true, discard: '+' }
    : { accept: false };

function drive<T>(step: DealStep<T>): T {
  let cur = step;
  while (cur.status === 'awaiting-decision') cur = cur.resume(accept(cur.player));
  return cur.state;
}

function dealFullRound(playerCount: number): void {
  const betting1 = drive(startDealPhase1(collectForcedBets(startRound(createGame(names(playerCount))))));
  drive(startDealPhase2({ ...betting1, phase: 'dealing-2' } as Dealing2State));
}

describe('player cap', () => {
  it('is 11 — the deck holds 44 number cards and each player uses 4', () => {
    expect(MAX_PLAYERS).toBe(11);
    expect(MIN_PLAYERS).toBe(2);
  });

  it('createGame rejects a table that cannot be dealt', () => {
    expect(() => createGame(names(MAX_PLAYERS))).not.toThrow();
    expect(() => createGame(names(MAX_PLAYERS + 1))).toThrow(/At most 11/);
    expect(() => createGame(names(MIN_PLAYERS - 1))).toThrow(/At least 2/);
  });

  it('deals a full round at the cap, every time', () => {
    // No slack at 11, so this would surface any miscount immediately.
    for (let t = 0; t < 300; t++) {
      expect(() => dealFullRound(MAX_PLAYERS)).not.toThrow();
    }
  });

  it('every player ends the round with the same four number cards', () => {
    for (let t = 0; t < 50; t++) {
      const betting1 = drive(startDealPhase1(collectForcedBets(startRound(createGame(names(MAX_PLAYERS))))));
      const calc = drive(startDealPhase2({ ...betting1, phase: 'dealing-2' } as Dealing2State));
      for (const p of calc.players) {
        const numbers = [p.secretCard, ...p.faceUpCards].filter((c) => c.kind === 'number');
        expect(numbers).toHaveLength(4);
      }
    }
  });

  it('one seat past the cap exhausts the deck — the failure the cap prevents', () => {
    // Guards the derivation: if this ever stops throwing, MAX_PLAYERS is stale.
    expect(() => {
      const over = names(MAX_PLAYERS + 1);
      const betting1 = drive(startDealPhase1(collectForcedBets(startRound({
        ...createGame(names(MAX_PLAYERS)),
        players: over.map((name, i) => ({
          id: `player-${i}`, name, chips: 50,
          personalOperators: [], currentBet: 0, folded: false,
          secretCard: null, faceUpCards: [],
        })),
      }))));
      drive(startDealPhase2({ ...betting1, phase: 'dealing-2' } as Dealing2State));
    }).toThrow(/[Dd]eck|number cards/);
  });
});
