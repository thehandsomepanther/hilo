import { describe, it, expect } from 'vitest';
import { resolveRound, applyPayouts } from '../results';
import { ResultsState, DealtPlayer, NumberCard } from '../types';

function makePlayer(overrides: Partial<DealtPlayer> & { id: string }): DealtPlayer {
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

function numCard(value: number, suit: NumberCard['suit'] = 'Gold'): NumberCard {
  return { kind: 'number', value: value as 0, suit };
}

function baseState(players: DealtPlayer[], pot = 20): ResultsState {
  return {
    phase: 'results',
    players,
    deck: [],
    pot,
    forcedBetAmount: 1,
    calculationTimeLimit: 90,
    round: 1,
    log: [],
    dealerIndex: 0,
    bettingLocked: false,
    enforceTimeLimit: false,
    chipHistory: [],
    result: { kind: 'contested', lowWinnerId: null, highWinnerId: null, payouts: {} },
  };
}

describe('resolveRound — single survivor', () => {
  it('awards whole pot to last active player', () => {
    const players = [
      makePlayer({ id: 'a', folded: false }),
      makePlayer({ id: 'b', folded: true }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('last-player-standing');
    if (result.kind === 'last-player-standing') {
      expect(result.winnerId).toBe('a');
      expect(result.payout).toBe(20);
    }
  });
});

describe('resolveRound — high vs low', () => {
  it('splits pot 50/50 between closest high and closest low', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'low',  lowResult: 1,  secretCard: numCard(1) }),
      makePlayer({ id: 'b', betChoice: 'high', highResult: 20, secretCard: numCard(10) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') {
      expect(result.payouts['a']).toBe(10);
      expect(result.payouts['b']).toBe(10);
    }
  });

  it('closest result wins (not exact)', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'low', lowResult: 2, secretCard: numCard(2) }),
      makePlayer({ id: 'b', betChoice: 'low', lowResult: 4, secretCard: numCard(4) }),
    ];
    const result = resolveRound({ players, pot: 10 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') {
      expect(result.lowWinnerId).toBe('a');
      expect(result.payouts['a']).toBe(5);
    }
  });
});

describe('resolveRound — tie-breaking', () => {
  it('high tie: player with highest single card wins', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'high', highResult: 19, secretCard: numCard(7), faceUpCards: [numCard(5)] }),
      makePlayer({ id: 'b', betChoice: 'high', highResult: 19, secretCard: numCard(9), faceUpCards: [numCard(3)] }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') expect(result.highWinnerId).toBe('b');
  });

  it('high tie, same value: Gold suit wins over Black', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'high', highResult: 19, secretCard: numCard(10, 'Black') }),
      makePlayer({ id: 'b', betChoice: 'high', highResult: 19, secretCard: numCard(10, 'Gold') }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') expect(result.highWinnerId).toBe('b');
  });

  it('low tie: player with lowest single card wins', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'low', lowResult: 2, secretCard: numCard(3), faceUpCards: [numCard(5)] }),
      makePlayer({ id: 'b', betChoice: 'low', lowResult: 2, secretCard: numCard(1), faceUpCards: [numCard(7)] }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') expect(result.lowWinnerId).toBe('b');
  });

  it('low tie, same value: Black suit wins over Gold', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'low', lowResult: 2, secretCard: numCard(1, 'Gold') }),
      makePlayer({ id: 'b', betChoice: 'low', lowResult: 2, secretCard: numCard(1, 'Black') }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') expect(result.lowWinnerId).toBe('b');
  });
});

// ─── float noise ──────────────────────────────────────────────────────────────
//
// Every player holds a ÷, so equal-looking results are routinely unequal
// floats.  These are real evaluator outputs:
//   8÷3-5÷3 → 0.9999999999999998      0÷1+1  → 1
//   3÷5÷3×5 → 0.9999999999999999
// All three render as "1.0000" on the results screen and are the same play,
// so the card tie-break — not rounding error — has to decide between them.

describe('resolveRound — results that differ only by float noise', () => {
  const ALMOST_ONE = 8 / 3 - 5 / 3;   // 0.9999999999999998
  const NEARLY_ONE = 3 / 5 / 3 * 5;   // 0.9999999999999999

  it('treats them as tied and lets the lowest card decide', () => {
    const players = [
      makePlayer({ id: 'exact',  betChoice: 'low', lowResult: 1,          secretCard: numCard(6) }),
      makePlayer({ id: 'noisy',  betChoice: 'low', lowResult: ALMOST_ONE, secretCard: numCard(2) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind !== 'contested') return;
    // Exact-float 1 is microscopically closer, but the round is a tie.
    expect(result.lowWinnerId).toBe('noisy');
    expect(result.lowTiebreak).toMatch(/lowest card: 2 beats 6/);
  });

  it('is not sensitive to the order players sit in', () => {
    const seatOrder = (ids: string[]) => {
      const by: Record<string, DealtPlayer> = {
        exact: makePlayer({ id: 'exact', betChoice: 'low', lowResult: 1,          secretCard: numCard(6) }),
        noisy: makePlayer({ id: 'noisy', betChoice: 'low', lowResult: ALMOST_ONE, secretCard: numCard(2) }),
        other: makePlayer({ id: 'other', betChoice: 'low', lowResult: NEARLY_ONE, secretCard: numCard(4) }),
      };
      const r = resolveRound({ players: ids.map((id) => by[id]!), pot: 20 });
      return r.kind === 'contested' ? r.lowWinnerId : null;
    };
    expect(seatOrder(['exact', 'noisy', 'other'])).toBe('noisy');
    expect(seatOrder(['other', 'exact', 'noisy'])).toBe('noisy');
    expect(seatOrder(['noisy', 'other', 'exact'])).toBe('noisy');
  });

  it('two swing players tied on low: the lowest card takes the sweep', () => {
    // The reported bug: both swing, low results identical on screen, and the
    // player holding the lower card lost.
    const players = [
      makePlayer({
        id: 'lucky-float', betChoice: 'swing',
        lowResult: 1, highResult: 19, secretCard: numCard(8),
      }),
      makePlayer({
        id: 'lowest-card', betChoice: 'swing',
        lowResult: ALMOST_ONE, highResult: 20, secretCard: numCard(2),
      }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind !== 'contested') return;
    // 'lowest-card' wins low on the tie-break and high outright — a sweep.
    expect(result.lowWinnerId).toBe('lowest-card');
    expect(result.highWinnerId).toBe('lowest-card');
    expect(result.payouts['lowest-card']).toBe(20);
    expect(result.payouts['lucky-float'] ?? 0).toBe(0);
  });

  it('still separates results that genuinely differ', () => {
    // 1.1e-4 is the smallest gap between two distinct results observed across
    // 2400 equations of simulated play — the tolerance must stay well under it.
    const players = [
      makePlayer({ id: 'closer',  betChoice: 'low', lowResult: 1 + 1.1e-4, secretCard: numCard(9) }),
      makePlayer({ id: 'further', betChoice: 'low', lowResult: 1 + 2.2e-4, secretCard: numCard(1) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind !== 'contested') return;
    // A real gap is a real win — the lower card must not rescue 'further'.
    expect(result.lowWinnerId).toBe('closer');
    expect(result.lowTiebreak).toBeNull();
  });

  it('applies the same tolerance to the high side', () => {
    const players = [
      makePlayer({ id: 'exact', betChoice: 'high', highResult: 20,               secretCard: numCard(3) }),
      makePlayer({ id: 'noisy', betChoice: 'high', highResult: 20 - 2.2e-16,     secretCard: numCard(9) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind !== 'contested') return;
    expect(result.highWinnerId).toBe('noisy');
    expect(result.highTiebreak).toMatch(/highest card: 9 beats 3/);
  });
});

describe('resolveRound — swing bets', () => {
  it('swing player who wins both gets the full pot', () => {
    const players = [
      makePlayer({ id: 'swing', betChoice: 'swing', lowResult: 1, highResult: 20, secretCard: numCard(10, 'Gold') }),
      makePlayer({ id: 'other', betChoice: 'low', lowResult: 3, secretCard: numCard(3) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') {
      expect(result.payouts['swing']).toBe(20);
    }
  });

  it('swing player who wins only high forfeits; fallback to high-player', () => {
    const players = [
      makePlayer({ id: 'swing',       betChoice: 'swing', lowResult: 5,  highResult: 20, secretCard: numCard(10) }),
      makePlayer({ id: 'low-player',  betChoice: 'low',   lowResult: 1,                  secretCard: numCard(1) }),
      makePlayer({ id: 'high-player', betChoice: 'high',  highResult: 18,                secretCard: numCard(8) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') {
      expect(result.payouts['swing']       ?? 0).toBe(0);
      expect(result.payouts['low-player']     ).toBe(10);
      expect(result.payouts['high-player']    ).toBe(10);
    }
  });

  it('rollover when no contestants for a side', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'low',  lowResult: null, secretCard: numCard(1) }),
      makePlayer({ id: 'b', betChoice: 'high', highResult: 20,  secretCard: numCard(10) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') {
      expect(result.payouts['__rollover__']).toBe(10);
      expect(result.payouts['b']).toBe(10);
    }
  });

  it('swing wins only low — forfeits low, high rolls over', () => {
    const players = [
      makePlayer({ id: 'swing',       betChoice: 'swing', lowResult: 1,  highResult: 15, secretCard: numCard(5) }),
      makePlayer({ id: 'high-player', betChoice: 'high',  highResult: 20,                secretCard: numCard(8) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') {
      expect(result.payouts['swing']       ?? 0).toBe(0);
      expect(result.payouts['__rollover__']    ).toBe(10); // swing forfeited low, no fallback
      expect(result.payouts['high-player']     ).toBe(10);
    }
  });

  it('explains the tie-break that actually paid out, not the forfeited one', () => {
    // The swing player wins the low tie-break, then loses high and forfeits.
    // The low half falls to 'runner-up', so the note must describe the contest
    // among the players who were still eligible — not the swing player's win.
    const players = [
      makePlayer({ id: 'swing',     betChoice: 'swing', lowResult: 1, highResult: 5, secretCard: numCard(2) }),
      makePlayer({ id: 'runner-up', betChoice: 'low',   lowResult: 1,                secretCard: numCard(4) }),
      makePlayer({ id: 'third',     betChoice: 'low',   lowResult: 1,                secretCard: numCard(6) }),
      makePlayer({ id: 'high-guy',  betChoice: 'high',  highResult: 20,              secretCard: numCard(9) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind !== 'contested') return;

    expect(result.lowWinnerId).toBe('runner-up');
    expect(result.payouts['swing'] ?? 0).toBe(0);
    expect(result.lowTiebreak).toMatch(/lowest card: 4 beats 6/);
    expect(result.lowTiebreak).not.toContain('2 beats');
  });

  it('two swing players split the win: neither sweeps, so both forfeit', () => {
    const players = [
      makePlayer({ id: 's1', betChoice: 'swing', lowResult: 1, highResult: 10, secretCard: numCard(3) }),
      makePlayer({ id: 's2', betChoice: 'swing', lowResult: 8, highResult: 20, secretCard: numCard(5) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind !== 'contested') return;
    expect(result.payouts['s1'] ?? 0).toBe(0);
    expect(result.payouts['s2'] ?? 0).toBe(0);
    expect(result.payouts['__rollover__']).toBe(20);
  });

  it('swing wins only high — forfeits; low goes to non-swing player', () => {
    const players = [
      makePlayer({ id: 'swing',      betChoice: 'swing', lowResult: 5,  highResult: 20, secretCard: numCard(7) }),
      makePlayer({ id: 'low-player', betChoice: 'low',   lowResult: 1,                  secretCard: numCard(1) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') {
      expect(result.payouts['swing']       ?? 0).toBe(0);
      expect(result.payouts['low-player']     ).toBe(10);
      expect(result.payouts['__rollover__']   ).toBe(10); // swing forfeited high, no fallback
    }
  });
});

describe('resolveRound — odd pot split', () => {
  it('high winner gets ceil, low winner gets floor', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'low',  lowResult: 1,  secretCard: numCard(1) }),
      makePlayer({ id: 'b', betChoice: 'high', highResult: 20, secretCard: numCard(9) }),
    ];
    const result = resolveRound({ players, pot: 21 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') {
      expect(result.payouts['a']).toBe(10); // floor(21/2)
      expect(result.payouts['b']).toBe(11); // ceil(21/2)
    }
  });
});

describe('resolveRound — both sides uncontested', () => {
  it('entire pot rolls over when no valid contestants', () => {
    const players = [
      makePlayer({ id: 'a', betChoice: 'low',  lowResult: null,  secretCard: numCard(2) }),
      makePlayer({ id: 'b', betChoice: 'high', highResult: null, secretCard: numCard(8) }),
    ];
    const result = resolveRound({ players, pot: 20 });
    expect(result.kind).toBe('contested');
    if (result.kind === 'contested') {
      expect(result.payouts['__rollover__']).toBe(20);
    }
  });
});

describe('applyPayouts', () => {
  it('adds winnings to player chips', () => {
    const players = [makePlayer({ id: 'a', chips: 10 }), makePlayer({ id: 'b', chips: 10 })];
    const state = baseState(players);
    const stateWithResult: ResultsState = {
      ...state,
      result: { kind: 'contested', lowWinnerId: 'a', highWinnerId: 'b', payouts: { a: 10, b: 10 } },
    };
    const next = applyPayouts(stateWithResult);
    expect(next.players[0]?.chips).toBe(20);
    expect(next.players[1]?.chips).toBe(20);
    expect(next.phase).toBe('setup');
  });

  it('carries rollover into next round pot', () => {
    const players = [makePlayer({ id: 'a', chips: 10 })];
    const state: ResultsState = {
      ...baseState(players),
      result: { kind: 'contested', lowWinnerId: null, highWinnerId: null, payouts: { __rollover__: 15 } },
    };
    const next = applyPayouts(state);
    expect(next.pot).toBe(15);
  });

  it('last-player-standing: winner gets payout, others unchanged', () => {
    const players = [makePlayer({ id: 'a', chips: 5 }), makePlayer({ id: 'b', chips: 10 })];
    const state: ResultsState = {
      ...baseState(players),
      result: { kind: 'last-player-standing', winnerId: 'a', payout: 20 },
    };
    const next = applyPayouts(state);
    expect(next.players.find((p) => p.id === 'a')?.chips).toBe(25);
    expect(next.players.find((p) => p.id === 'b')?.chips).toBe(10);
  });

  it('players with no payouts are unchanged', () => {
    const players = [makePlayer({ id: 'a', chips: 10 }), makePlayer({ id: 'b', chips: 10 })];
    const state: ResultsState = {
      ...baseState(players),
      result: { kind: 'contested', lowWinnerId: 'a', highWinnerId: 'a', payouts: { a: 20 } },
    };
    const next = applyPayouts(state);
    expect(next.players.find((p) => p.id === 'b')?.chips).toBe(10);
    expect(next.players.find((p) => p.id === 'a')?.chips).toBe(30);
  });
});
