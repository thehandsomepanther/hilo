/**
 * strategy.ts — stateless decision functions for bot players.
 *
 * Each function takes the bot's current player state (and game state where
 * needed) plus the `DifficultyProfile` for its seat, and returns what action
 * to take.  No side effects — callers are responsible for dispatching the
 * returned action.
 *
 * `rng` is injectable on the functions that make a random choice, purely so
 * tests can pin them down; it defaults to `Math.random` the way the rest of
 * the codebase uses randomness.
 */

import type { DealtPlayer, Player, MultiplicationDecision, BettingState, Card } from '../../src/types';
import type { BettingAction } from '../../src/game';
import { closenessToTarget } from '../../src/equation';
import { rankedSolutions } from './solver';
import type { DifficultyProfile } from './difficulty';
import { profileFor } from './difficulty';

const DEFAULT_PROFILE = profileFor();

// ─── Hand strength ────────────────────────────────────────────────────────────

/**
 * How well the cards in hand can reach *either* target, as a 0–1 score: 1.0
 * means the bot can land exactly on 1 or on 20 right now.
 *
 * This is what separates a bot that bets its hand from one that bets a fixed
 * fraction of its stack regardless of what it is holding.  It is deliberately
 * "best side wins" — a hand that nails one target is worth playing even if the
 * other side is hopeless, because a player only ever declares one side.
 */
export function handStrength(player: DealtPlayer): number {
  const cards: Card[] = [player.secretCard, ...player.faceUpCards, ...player.personalOperators];
  const { low, high } = rankedSolutions(cards);
  const best = Math.min(low[0]?.dist ?? Infinity, high[0]?.dist ?? Infinity);
  if (!Number.isFinite(best)) return 0;
  return 1 / (1 + best);
}

// ─── Betting ──────────────────────────────────────────────────────────────────

/**
 * The most a player may legally raise to: `applyBettingAction` rejects any
 * raise above the smallest effective stack at the table, so a bot that ignores
 * the cap throws rather than acts.  Returns null when raising is not available
 * at all.
 */
export function maxRaiseAmount(player: DealtPlayer, state: BettingState): number | null {
  if (state.bettingLocked) return null;
  const active = state.players.filter((p) => !p.folded);
  const minStack = Math.min(...active.map((p) => p.chips + p.currentBet));
  const minRaise = state.currentBet + 1;
  const playerMax = player.chips + player.currentBet;
  if (minRaise > minStack || playerMax < minRaise) return null;
  return Math.min(minStack, playerMax);
}

/** A hand this good is worth putting chips behind. */
const RAISE_THRESHOLD = 0.66;

/**
 * Bet according to the profile:
 * - Check when possible, unless the bot raises and is holding something strong.
 * - Call while the price stays within the profile's share of the stack, which
 *   `readsOwnHand` scales by how good the hand actually is.
 * - Fold otherwise.
 */
export function decideBet(
  bot: DealtPlayer,
  state: BettingState,
  profile: DifficultyProfile = DEFAULT_PROFILE,
  strength: number = profile.readsOwnHand || profile.raises ? handStrength(bot) : 0,
): BettingAction {
  const canCheck = state.currentBet <= bot.currentBet;

  if (profile.raises && strength >= RAISE_THRESHOLD) {
    const cap = maxRaiseAmount(bot, state);
    if (cap !== null) {
      // A nudge, not a shove: enough to charge the table for staying in
      // without turning every strong hand into an all-in.
      const target = state.currentBet + Math.max(1, Math.round(bot.chips * 0.1));
      return { type: 'raise', amount: Math.min(target, cap) };
    }
  }

  if (canCheck) return { type: 'check' };

  const callCost = Math.min(state.currentBet - bot.currentBet, bot.chips);
  const tolerance = profile.readsOwnHand
    ? profile.baseCallFraction * (0.5 + strength)
    : profile.baseCallFraction;

  if (bot.chips > 0 && callCost / bot.chips <= tolerance) return { type: 'call' };

  return { type: 'fold' };
}

// ─── × card decision ─────────────────────────────────────────────────────────

/** Stand-in for the bonus number card the × decision is made without seeing. */
const UNKNOWN_CARD_VALUE = 5;

/**
 * Accepting × costs the bot its `+` or `-` and is not always worth it: ×
 * reaches 20 easily but overshoots 1 badly.
 *
 * Without `evaluatesMultiplication` the bot uses the old static rule — accept
 * whenever it can, giving up `+` first and keeping `-` for fine-tuning.  With
 * it, the bot solves the hand both ways (padded with a placeholder for the
 * bonus card it has not seen) and takes whichever branch can get closer to a
 * target.
 */
export function decideMultiplication(
  bot: Player,
  profile: DifficultyProfile = DEFAULT_PROFILE,
): MultiplicationDecision {
  const hasPlus  = bot.personalOperators.some((op) => op.operator === '+');
  const hasMinus = bot.personalOperators.some((op) => op.operator === '-');
  if (!hasPlus && !hasMinus) return { accept: false };

  const staticChoice: MultiplicationDecision = hasPlus
    ? { accept: true, discard: '+' }
    : { accept: true, discard: '-' };

  if (!profile.evaluatesMultiplication) return staticChoice;

  const held: Card[] = [
    ...(bot.secretCard ? [bot.secretCard] : []),
    ...bot.faceUpCards,
    ...bot.personalOperators,
  ];
  const bonus: Card = { kind: 'number', value: UNKNOWN_CARD_VALUE, suit: 'Gold' };

  /** Best distance to either target for a hypothetical hand. */
  const reach = (cards: Card[]): number => {
    const { low, high } = rankedSolutions(cards);
    return Math.min(low[0]?.dist ?? Infinity, high[0]?.dist ?? Infinity);
  };

  const declined = reach([...held, bonus]);

  const options: Array<{ decision: MultiplicationDecision; reach: number }> = [];
  for (const discard of ['+', '-'] as const) {
    if (!bot.personalOperators.some((op) => op.operator === discard)) continue;
    let dropped = false;
    const swapped = held.filter((c) => {
      if (dropped || c.kind !== 'operator' || c.operator !== discard) return true;
      dropped = true;
      return false;
    });
    options.push({
      decision: { accept: true, discard },
      reach: reach([...swapped, { kind: 'operator', operator: '×' }, bonus]),
    });
  }

  const best = options.reduce<{ decision: MultiplicationDecision; reach: number } | null>(
    (acc, o) => (acc === null || o.reach < acc.reach ? o : acc),
    null,
  );
  if (best === null) return staticChoice;
  return best.reach < declined ? best.decision : { accept: false };
}

// ─── High / Low bet choice ────────────────────────────────────────────────────

/** Both sides this close makes swing a bet worth making rather than a coin flip. */
const SWING_THRESHOLD = 0.5;

/**
 * Declare the side whose equation landed closer to its target.
 *
 * `sideMistakeChance` is what a weaker bot gets wrong — it misjudges which of
 * its two results is the better bet.  `swings` is the opposite end: swing pays
 * the whole pot but only if it wins *both* halves, so it is only ever declared
 * when both results are all but exact.
 */
export function decideBetChoice(
  bot: DealtPlayer,
  profile: DifficultyProfile = DEFAULT_PROFILE,
  rng: () => number = Math.random,
): 'high' | 'low' | 'swing' {
  const lowDist  = closenessToTarget(bot.lowResult  ?? Infinity, 1);
  const highDist = closenessToTarget(bot.highResult ?? Infinity, 20);

  if (profile.swings && lowDist <= SWING_THRESHOLD && highDist <= SWING_THRESHOLD) {
    return 'swing';
  }

  const better: 'high' | 'low' = lowDist <= highDist ? 'low' : 'high';
  if (profile.sideMistakeChance > 0 && rng() < profile.sideMistakeChance) {
    return better === 'low' ? 'high' : 'low';
  }
  return better;
}
