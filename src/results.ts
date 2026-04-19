import { buildPersonalOperators } from './deck';
import {
  GameState, DealtPlayer, UndealPlayer, Player,
  RoundResult, ResultsState, SetupState,
  SUIT_RANK_HIGH, SUIT_RANK_LOW, NumberCard,
} from './types';
import { closenessToTarget } from './equation';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function numberCards(player: DealtPlayer): NumberCard[] {
  const cards: NumberCard[] = [];
  cards.push(player.secretCard);
  for (const c of player.faceUpCards) {
    if (c.kind === 'number') cards.push(c);
  }
  return cards;
}

// ─── Tie-breaking ─────────────────────────────────────────────────────────────

function compareHighTie(a: DealtPlayer, b: DealtPlayer): number {
  const aCards = numberCards(a);
  const bCards = numberCards(b);
  const aMax = Math.max(...aCards.map((c) => c.value));
  const bMax = Math.max(...bCards.map((c) => c.value));
  if (aMax !== bMax) return bMax - aMax;
  const aMaxSuitRank = Math.max(...aCards.filter((c) => c.value === aMax).map((c) => SUIT_RANK_HIGH[c.suit]));
  const bMaxSuitRank = Math.max(...bCards.filter((c) => c.value === bMax).map((c) => SUIT_RANK_HIGH[c.suit]));
  return bMaxSuitRank - aMaxSuitRank;
}

function compareLowTie(a: DealtPlayer, b: DealtPlayer): number {
  const aCards = numberCards(a);
  const bCards = numberCards(b);
  const aMin = Math.min(...aCards.map((c) => c.value));
  const bMin = Math.min(...bCards.map((c) => c.value));
  if (aMin !== bMin) return aMin - bMin;
  const aMinSuitRank = Math.max(...aCards.filter((c) => c.value === aMin).map((c) => SUIT_RANK_LOW[c.suit]));
  const bMinSuitRank = Math.max(...bCards.filter((c) => c.value === bMin).map((c) => SUIT_RANK_LOW[c.suit]));
  return bMinSuitRank - aMinSuitRank;
}

// ─── Winner selection ─────────────────────────────────────────────────────────

function findWinner(candidates: DealtPlayer[], target: 1 | 20): DealtPlayer | null {
  if (candidates.length === 0) return null;
  const getResult = (p: DealtPlayer): number =>
    target === 1 ? (p.lowResult ?? Infinity) : (p.highResult ?? Infinity);
  const tieBreak = target === 20 ? compareHighTie : compareLowTie;
  return candidates.reduce<DealtPlayer>((best, p) => {
    const bestClose = closenessToTarget(getResult(best), target);
    const pClose = closenessToTarget(getResult(p), target);
    if (pClose < bestClose) return p;
    if (pClose > bestClose) return best;
    return tieBreak(best, p) <= 0 ? best : p;
  }, candidates[0] as DealtPlayer);
}

// ─── Round resolution ─────────────────────────────────────────────────────────

/**
 * Compute round results and payouts from the current high-low-bet state.
 * Called by `advanceFromHighLowBet` in game.ts.
 */
export function resolveRound(state: { players: DealtPlayer[]; pot: number }): RoundResult {
  const active = state.players.filter((p) => !p.folded);

  // Last player standing — whole pot to them, no equation reveal needed.
  if (active.length === 1) {
    return { kind: 'last-player-standing', winnerId: active[0]!.id, payout: state.pot };
  }
  // Edge case: everyone folded somehow (shouldn't happen in normal play).
  if (active.length === 0) {
    return { kind: 'contested', lowWinnerId: null, highWinnerId: null, payouts: { __rollover__: state.pot } };
  }

  const highHalf = Math.ceil(state.pot / 2);
  const lowHalf  = Math.floor(state.pot / 2);

  const lowCandidates  = active.filter((p) => (p.betChoice === 'low'  || p.betChoice === 'swing') && p.lowResult  !== null);
  const highCandidates = active.filter((p) => (p.betChoice === 'high' || p.betChoice === 'swing') && p.highResult !== null);

  const lowWinner  = findWinner(lowCandidates,  1);
  const highWinner = findWinner(highCandidates, 20);

  const payouts: Record<string, number> = {};
  const award = (id: string, amount: number): void => {
    payouts[id] = (payouts[id] ?? 0) + amount;
  };

  const swingWonBoth =
    lowWinner !== null &&
    highWinner !== null &&
    lowWinner.id === highWinner.id &&
    lowWinner.betChoice === 'swing';

  const effectiveLowWinner: DealtPlayer | null = (() => {
    if (lowWinner === null) return null;
    if (lowWinner.betChoice !== 'swing') return lowWinner;
    if (swingWonBoth) return lowWinner;
    return findWinner(lowCandidates.filter((p) => p.betChoice !== 'swing'), 1);
  })();

  const effectiveHighWinner: DealtPlayer | null = (() => {
    if (highWinner === null) return null;
    if (highWinner.betChoice !== 'swing') return highWinner;
    if (swingWonBoth) return highWinner;
    return findWinner(highCandidates.filter((p) => p.betChoice !== 'swing'), 20);
  })();

  if (effectiveLowWinner)  { award(effectiveLowWinner.id,  lowHalf);  }
  else                     { award('__rollover__',          lowHalf);  }
  if (effectiveHighWinner) { award(effectiveHighWinner.id,  highHalf); }
  else                     { award('__rollover__',          highHalf); }

  return {
    kind: 'contested',
    lowWinnerId:  effectiveLowWinner?.id  ?? null,
    highWinnerId: effectiveHighWinner?.id ?? null,
    payouts,
  };
}

// ─── Payout application ───────────────────────────────────────────────────────

/**
 * Apply payouts from `state.result` to player chip counts and return a
 * `SetupState` ready to be passed to `startRound` or `checkGameOver`.
 *
 * Rollover chips (key `'__rollover__'`) carry into the next round's pot.
 * Personal operators are rebuilt fresh so each round starts with [+, −, ÷].
 */
export function applyPayouts(state: ResultsState): SetupState {
  const result = state.result;

  const rollover =
    result.kind === 'contested' ? (result.payouts['__rollover__'] ?? 0) : 0;

  const payoutFor = (id: string): number => {
    if (result.kind === 'last-player-standing') {
      return result.winnerId === id ? result.payout : 0;
    }
    return result.payouts[id] ?? 0;
  };

  const players: UndealPlayer[] = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    chips: p.chips + payoutFor(p.id),
    personalOperators: buildPersonalOperators(),
    currentBet: 0,
    folded: false,
    secretCard: null,
    faceUpCards: [],
  }));

  // Strip phase-specific fields from state spread, then set 'setup' phase.
  const { phase: _phase, result: _result, ...base } = state;
  return { ...base, phase: 'setup', players, pot: rollover };
}
