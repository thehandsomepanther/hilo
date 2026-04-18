import { GameState, Player, RoundResult, SUIT_RANK_HIGH, SUIT_RANK_LOW, NumberCard } from './types';
import { closenessToTarget } from './equation';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function numberCards(player: Player): NumberCard[] {
  const cards: NumberCard[] = [];
  if (player.secretCard) cards.push(player.secretCard);
  for (const c of player.faceUpCards) {
    if (c.kind === 'number') cards.push(c);
  }
  return cards;
}

// ─── Tie-breaking ─────────────────────────────────────────────────────────────

/**
 * Break a High (20) tie between two players.
 * Returns negative if `a` wins, positive if `b` wins, 0 if truly equal.
 */
function compareHighTie(a: Player, b: Player): number {
  const aCards = numberCards(a);
  const bCards = numberCards(b);

  const aMax = Math.max(...aCards.map((c) => c.value));
  const bMax = Math.max(...bCards.map((c) => c.value));
  if (aMax !== bMax) return bMax - aMax; // higher value wins → negative means a wins

  // Same value: compare suit rank (Gold > Silver > Bronze > Black)
  const aMaxSuitRank = Math.max(
    ...aCards.filter((c) => c.value === aMax).map((c) => SUIT_RANK_HIGH[c.suit]),
  );
  const bMaxSuitRank = Math.max(
    ...bCards.filter((c) => c.value === bMax).map((c) => SUIT_RANK_HIGH[c.suit]),
  );
  return bMaxSuitRank - aMaxSuitRank;
}

/**
 * Break a Low (1) tie between two players.
 * Returns negative if `a` wins, positive if `b` wins, 0 if truly equal.
 */
function compareLowTie(a: Player, b: Player): number {
  const aCards = numberCards(a);
  const bCards = numberCards(b);

  const aMin = Math.min(...aCards.map((c) => c.value));
  const bMin = Math.min(...bCards.map((c) => c.value));
  if (aMin !== bMin) return aMin - bMin; // lower value wins → negative means a wins

  // Same value: compare suit rank for Low (Black > Bronze > Silver > Gold)
  const aMinSuitRank = Math.max(
    ...aCards.filter((c) => c.value === aMin).map((c) => SUIT_RANK_LOW[c.suit]),
  );
  const bMinSuitRank = Math.max(
    ...bCards.filter((c) => c.value === bMin).map((c) => SUIT_RANK_LOW[c.suit]),
  );
  return bMinSuitRank - aMinSuitRank;
}

// ─── Winner selection ─────────────────────────────────────────────────────────

/**
 * Find the winner among `candidates` for the given target (1 or 20).
 * Returns null if the candidates list is empty.
 */
function findWinner(candidates: Player[], target: 1 | 20): Player | null {
  if (candidates.length === 0) return null;

  const getResult = (p: Player): number =>
    target === 1 ? (p.lowResult ?? Infinity) : (p.highResult ?? Infinity);

  const tieBreak = target === 20 ? compareHighTie : compareLowTie;

  return candidates.reduce<Player>((best, p) => {
    const bestClose = closenessToTarget(getResult(best), target);
    const pClose = closenessToTarget(getResult(p), target);
    if (pClose < bestClose) return p;
    if (pClose > bestClose) return best;
    return tieBreak(best, p) <= 0 ? best : p;
  }, candidates[0] as Player);
}

// ─── Pot distribution ─────────────────────────────────────────────────────────

/**
 * Compute round results and payouts.
 *
 * Pot split: highHalf = ceil(pot / 2), lowHalf = floor(pot / 2).
 *
 * Swing players must win BOTH pots; losing either means winning neither.
 * If no contestant exists for a side, that half rolls over to the next round
 * (credited to the special key '__rollover__' in payouts).
 *
 * When a swing player loses one side, the fallback winner for that side is the
 * best non-swing player in that group. If none exists the half rolls over.
 */
export function resolveRound(state: GameState): RoundResult {
  const activePlayers = state.players.filter((p) => !p.folded);

  // Early exit: everyone else folded — last player wins the whole pot
  if (activePlayers.length === 1) {
    const winner = activePlayers[0] as Player;
    const payouts = new Map<string, number>([[winner.id, state.pot]]);
    return { lowWinnerId: null, highWinnerId: null, payouts };
  }

  const highHalf = Math.ceil(state.pot / 2);
  const lowHalf = Math.floor(state.pot / 2);

  const lowCandidates = activePlayers.filter(
    (p) => (p.betChoice === 'low' || p.betChoice === 'swing') && p.lowResult !== null,
  );
  const highCandidates = activePlayers.filter(
    (p) => (p.betChoice === 'high' || p.betChoice === 'swing') && p.highResult !== null,
  );

  const lowWinner = findWinner(lowCandidates, 1);
  const highWinner = findWinner(highCandidates, 20);

  const payouts = new Map<string, number>();
  const award = (id: string, amount: number): void => {
    payouts.set(id, (payouts.get(id) ?? 0) + amount);
  };

  // Determine effective winners, accounting for swing-must-win-both rule
  const swingWonBoth =
    lowWinner !== null &&
    highWinner !== null &&
    lowWinner.id === highWinner.id &&
    lowWinner.betChoice === 'swing';

  const effectiveLowWinner: Player | null = (() => {
    if (lowWinner === null) return null;
    if (lowWinner.betChoice !== 'swing') return lowWinner;
    if (swingWonBoth) return lowWinner;
    // Swing player didn't win both — fall back to best non-swing low player
    return findWinner(lowCandidates.filter((p) => p.betChoice !== 'swing'), 1);
  })();

  const effectiveHighWinner: Player | null = (() => {
    if (highWinner === null) return null;
    if (highWinner.betChoice !== 'swing') return highWinner;
    if (swingWonBoth) return highWinner;
    return findWinner(highCandidates.filter((p) => p.betChoice !== 'swing'), 20);
  })();

  if (effectiveLowWinner) {
    award(effectiveLowWinner.id, lowHalf);
  } else {
    award('__rollover__', lowHalf);
  }

  if (effectiveHighWinner) {
    award(effectiveHighWinner.id, highHalf);
  } else {
    award('__rollover__', highHalf);
  }

  return {
    lowWinnerId: effectiveLowWinner?.id ?? null,
    highWinnerId: effectiveHighWinner?.id ?? null,
    payouts,
  };
}

/**
 * Apply payouts to player chip counts and return updated state.
 * Rollover chips (key '__rollover__') carry into the next round's pot.
 */
export function applyPayouts(state: GameState, result: RoundResult): GameState {
  const rollover = result.payouts.get('__rollover__') ?? 0;
  const players: Player[] = state.players.map((p) => ({
    ...p,
    chips: p.chips + (result.payouts.get(p.id) ?? 0),
  }));
  return {
    ...state,
    phase: 'setup',
    players,
    pot: rollover,
  };
}
