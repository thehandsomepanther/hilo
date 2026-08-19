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

function suitName(rank: number, rankTable: Record<string, number>): string {
  return Object.entries(rankTable).find(([, r]) => r === rank)![0];
}

function describeTiebreak(winner: DealtPlayer, rival: DealtPlayer, target: 1 | 20): string {
  const wCards = numberCards(winner);
  const rCards = numberCards(rival);
  if (target === 20) {
    const wMax = Math.max(...wCards.map((c) => c.value));
    const rMax = Math.max(...rCards.map((c) => c.value));
    if (wMax !== rMax) return `Tiebreak by highest card: ${wMax} beats ${rMax}`;
    const wSuitRank = Math.max(...wCards.filter((c) => c.value === wMax).map((c) => SUIT_RANK_HIGH[c.suit]));
    const rSuitRank = Math.max(...rCards.filter((c) => c.value === rMax).map((c) => SUIT_RANK_HIGH[c.suit]));
    return `Tiebreak by suit of highest card (both ${wMax}): ${suitName(wSuitRank, SUIT_RANK_HIGH)} beats ${suitName(rSuitRank, SUIT_RANK_HIGH)}`;
  } else {
    const wMin = Math.min(...wCards.map((c) => c.value));
    const rMin = Math.min(...rCards.map((c) => c.value));
    if (wMin !== rMin) return `Tiebreak by lowest card: ${wMin} beats ${rMin}`;
    const wSuitRank = Math.max(...wCards.filter((c) => c.value === wMin).map((c) => SUIT_RANK_LOW[c.suit]));
    const rSuitRank = Math.max(...rCards.filter((c) => c.value === rMin).map((c) => SUIT_RANK_LOW[c.suit]));
    return `Tiebreak by suit of lowest card (both ${wMin}): ${suitName(wSuitRank, SUIT_RANK_LOW)} beats ${suitName(rSuitRank, SUIT_RANK_LOW)}`;
  }
}

// ─── Winner selection ─────────────────────────────────────────────────────────

/**
 * Two equations that are mathematically equal rarely produce bit-identical
 * floats: every player holds a ÷, and `8÷3-5÷3` evaluates to
 * 0.9999999999999998 while `0÷1+1` gives exactly 1.  Both render as "1.0000"
 * and both are the same play, so comparing closeness exactly would hand the
 * win to whoever accumulated less rounding error and skip the card tie-break
 * entirely — which is precisely what that tie-break exists to decide.
 *
 * Exact arithmetic can't replace the tolerance: √ applies to any primary, so
 * ~10% of real equations evaluate to an irrational (measured over simulated
 * play), which no rational representation holds exactly.
 *
 * The tolerance is safe because the achievable value space is coarse.  Over
 * 2400 equations from simulated rounds, the smallest gap between two *distinct*
 * results was 1.1e-4 — five orders of magnitude above this epsilon, which in
 * turn is seven above float noise (~1e-16).
 */
const CLOSENESS_EPSILON = 1e-9;

/** Compare two closeness scores, treating float-noise differences as equal. */
function compareCloseness(a: number, b: number): number {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  if (Math.abs(a - b) <= CLOSENESS_EPSILON * scale) return 0;
  return a < b ? -1 : 1;
}

type Outcome = { winner: DealtPlayer | null; tiebreak: string | null };

function findWinner(candidates: DealtPlayer[], target: 1 | 20): Outcome {
  if (candidates.length === 0) return { winner: null, tiebreak: null };
  const getResult = (p: DealtPlayer): number =>
    target === 1 ? (p.lowResult ?? Infinity) : (p.highResult ?? Infinity);
  const closeness = (p: DealtPlayer): number => closenessToTarget(getResult(p), target);
  const tieBreak = target === 20 ? compareHighTie : compareLowTie;

  const winner = candidates.reduce<DealtPlayer>((best, p) => {
    const cmp = compareCloseness(closeness(p), closeness(best));
    if (cmp < 0) return p;
    if (cmp > 0) return best;
    return tieBreak(best, p) <= 0 ? best : p;
  }, candidates[0] as DealtPlayer);

  const rival = candidates.find((p) => p !== winner && compareCloseness(closeness(p), closeness(winner)) === 0);
  const tiebreak = rival ? describeTiebreak(winner, rival, target) : null;
  return { winner, tiebreak };
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

  const lowOutcome  = findWinner(lowCandidates,  1);
  const highOutcome = findWinner(highCandidates, 20);

  const payouts: Record<string, number> = {};
  const award = (id: string, amount: number): void => {
    payouts[id] = (payouts[id] ?? 0) + amount;
  };

  const swingWonBoth =
    lowOutcome.winner !== null &&
    highOutcome.winner !== null &&
    lowOutcome.winner.id === highOutcome.winner.id &&
    lowOutcome.winner.betChoice === 'swing';

  /**
   * A swing bet must take both halves or it takes nothing.  When the winner of
   * one side is a swing player who didn't sweep, *every* swing bet on that side
   * is void (the runners-up are swing players who didn't sweep either), and the
   * half goes to the best remaining non-swing player.  Re-deciding also
   * re-derives the tie-break note, so the explanation shown always describes
   * the contest that actually paid out.
   */
  const settle = (outcome: Outcome, candidates: DealtPlayer[], target: 1 | 20): Outcome => {
    if (outcome.winner === null || outcome.winner.betChoice !== 'swing' || swingWonBoth) return outcome;
    return findWinner(candidates.filter((p) => p.betChoice !== 'swing'), target);
  };

  const low  = settle(lowOutcome,  lowCandidates,  1);
  const high = settle(highOutcome, highCandidates, 20);

  if (low.winner)  { award(low.winner.id,   lowHalf);  } else { award('__rollover__', lowHalf);  }
  if (high.winner) { award(high.winner.id,  highHalf); } else { award('__rollover__', highHalf); }

  return {
    kind: 'contested',
    lowWinnerId:  low.winner?.id  ?? null,
    highWinnerId: high.winner?.id ?? null,
    payouts,
    lowTiebreak:  low.tiebreak,
    highTiebreak: high.tiebreak,
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

  const snapshot = Object.fromEntries(players.map((p) => [p.id, p.chips]));
  const { phase: _phase, result: _result, ...base } = state;
  return {
    ...base,
    phase: 'setup',
    players,
    pot: rollover,
    chipHistory: [...state.chipHistory, snapshot],
  };
}
