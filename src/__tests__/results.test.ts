import { describe, it, expect } from 'vitest';
import { resolveRound, applyPayouts } from '../results';
import { GameState, Player, NumberCard } from '../types';

function makePlayer(overrides: Partial<Player> & { id: string }): Player {
  return {
    name: overrides.id,
    chips: 10,
    personalOperators: [],
    secretCard: null,
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

function numCard(value: number, suit: NumberCard['suit'] = 'Gold'): NumberCard {
  return { kind: 'number', value: value as 0, suit };
}

function baseState(players: Player[]): GameState {
  return {
    phase: 'results',
    players,
    deck: [],
    pot: 20,
    currentBet: 0,
    forcedBetAmount: 1,
    activePlayerIndex: 0,
    calculationTimeLimit: 90,
    round: 1,
  };
}

describe('resolveRound — single survivor', () => {
  it('awards whole pot to last active player', () => {
    const players = [
      makePlayer({ id: 'a', folded: false }),
      makePlayer({ id: 'b', folded: true }),
    ];
    const result = resolveRound(baseState(players));
    expect(result.payouts.get('a')).toBe(20);
  });
});

describe('resolveRound — high vs low', () => {
  it('splits pot 50/50 between closest high and closest low', () => {
    const players = [
      makePlayer({
        id: 'a',
        betChoice: 'low',
        lowResult: 1,
        secretCard: numCard(1),
      }),
      makePlayer({
        id: 'b',
        betChoice: 'high',
        highResult: 20,
        secretCard: numCard(10),
      }),
    ];
    const result = resolveRound(baseState(players));
    expect(result.payouts.get('a')).toBe(10); // lowHalf = floor(20/2)
    expect(result.payouts.get('b')).toBe(10); // highHalf = ceil(20/2)
  });

  it('closest result wins (not exact)', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'low', lowResult: 2, secretCard: numCard(2) }),
      makePlayer({ id: 'b', betChoice: 'low', lowResult: 4, secretCard: numCard(4) }),
    ];
    const result = resolveRound({ ...baseState(players), pot: 10 });
    expect(result.lowWinnerId).toBe('a'); // |2-1| = 1 < |4-1| = 3
    expect(result.payouts.get('a')).toBe(5);
  });
});

describe('resolveRound — tie-breaking', () => {
  it('high tie: player with highest single card wins', () => {
    const players = [
      makePlayer({
        id: 'a',
        betChoice: 'high',
        highResult: 19,
        secretCard: numCard(7),
        faceUpCards: [numCard(5)],
      }),
      makePlayer({
        id: 'b',
        betChoice: 'high',
        highResult: 19,
        secretCard: numCard(9),
        faceUpCards: [numCard(3)],
      }),
    ];
    const result = resolveRound(baseState(players));
    expect(result.highWinnerId).toBe('b'); // highest single card: 9 > 7
  });

  it('high tie, same value: Gold suit wins over Black', () => {
    const players = [
      makePlayer({
        id: 'a',
        betChoice: 'high',
        highResult: 19,
        secretCard: numCard(10, 'Black'),
      }),
      makePlayer({
        id: 'b',
        betChoice: 'high',
        highResult: 19,
        secretCard: numCard(10, 'Gold'),
      }),
    ];
    const result = resolveRound(baseState(players));
    expect(result.highWinnerId).toBe('b'); // Gold > Black for High
  });

  it('low tie: player with lowest single card wins', () => {
    const players = [
      makePlayer({
        id: 'a',
        betChoice: 'low',
        lowResult: 2,
        secretCard: numCard(3),
        faceUpCards: [numCard(5)],
      }),
      makePlayer({
        id: 'b',
        betChoice: 'low',
        lowResult: 2,
        secretCard: numCard(1),
        faceUpCards: [numCard(7)],
      }),
    ];
    const result = resolveRound(baseState(players));
    expect(result.lowWinnerId).toBe('b'); // lowest single card: 1 < 3
  });

  it('low tie, same value: Black suit wins over Gold', () => {
    const players = [
      makePlayer({
        id: 'a',
        betChoice: 'low',
        lowResult: 2,
        secretCard: numCard(1, 'Gold'),
      }),
      makePlayer({
        id: 'b',
        betChoice: 'low',
        lowResult: 2,
        secretCard: numCard(1, 'Black'),
      }),
    ];
    const result = resolveRound(baseState(players));
    expect(result.lowWinnerId).toBe('b'); // Black > Gold for Low
  });
});

describe('resolveRound — swing bets', () => {
  it('swing player who wins both gets the full pot', () => {
    const players = [
      makePlayer({
        id: 'swing',
        betChoice: 'swing',
        lowResult: 1,
        highResult: 20,
        secretCard: numCard(10, 'Gold'),
      }),
    ];
    const result = resolveRound({ ...baseState(players), pot: 20 });
    expect(result.payouts.get('swing')).toBe(20);
  });

  it('swing player who wins only high still wins nothing if non-swing player exists for low', () => {
    const players = [
      makePlayer({
        id: 'swing',
        betChoice: 'swing',
        lowResult: 5,   // worse low than 'low-player'
        highResult: 20, // best high
        secretCard: numCard(10),
      }),
      makePlayer({
        id: 'low-player',
        betChoice: 'low',
        lowResult: 1,
        secretCard: numCard(1),
      }),
      makePlayer({
        id: 'high-player',
        betChoice: 'high',
        highResult: 18,
        secretCard: numCard(8),
      }),
    ];
    const result = resolveRound({ ...baseState(players), pot: 20 });
    // Swing didn't win both → swing wins nothing
    expect(result.payouts.get('swing') ?? 0).toBe(0);
    // Low half goes to low-player
    expect(result.payouts.get('low-player')).toBe(10);
    // High half: swing won high but forfeited → fallback to high-player
    expect(result.payouts.get('high-player')).toBe(10);
  });

  it('rollover when no contestants for a side', () => {
    // Two players; 'b' bet high, 'a' bet low but has no lowResult (didn't submit)
    const players = [
      makePlayer({
        id: 'a',
        betChoice: 'low',
        lowResult: null, // no equation submitted — not a valid contestant
        secretCard: numCard(1),
      }),
      makePlayer({
        id: 'b',
        betChoice: 'high',
        highResult: 20,
        secretCard: numCard(10),
      }),
    ];
    const result = resolveRound({ ...baseState(players), pot: 20 });
    // No valid low contestant — low half rolls over
    expect(result.payouts.get('__rollover__')).toBe(10);
    // High half goes to the only high contestant
    expect(result.payouts.get('b')).toBe(10);
  });
});

describe('applyPayouts', () => {
  it('adds winnings to player chips', () => {
    const players = [
      makePlayer({ id: 'a', chips: 10 }),
      makePlayer({ id: 'b', chips: 10 }),
    ];
    const state = baseState(players);
    const result = {
      lowWinnerId: 'a',
      highWinnerId: 'b',
      payouts: new Map([['a', 10], ['b', 10]]),
    };
    const next = applyPayouts(state, result);
    expect(next.players[0]?.chips).toBe(20);
    expect(next.players[1]?.chips).toBe(20);
    expect(next.phase).toBe('setup');
  });

  it('carries rollover into next round pot', () => {
    const players = [makePlayer({ id: 'a', chips: 10 })];
    const state = baseState(players);
    const result = {
      lowWinnerId: null,
      highWinnerId: null,
      payouts: new Map([['__rollover__', 15]]),
    };
    const next = applyPayouts(state, result);
    expect(next.pot).toBe(15);
  });
});
