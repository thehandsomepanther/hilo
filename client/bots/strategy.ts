/**
 * strategy.ts — stateless decision functions for bot players.
 *
 * Each function takes the bot's current player state (and game state where
 * needed) and returns what action to take.  No side effects — callers are
 * responsible for dispatching the returned action.
 */

import type { DealtPlayer, Player, MultiplicationDecision, BettingState } from '../../src/types';
import type { BettingAction } from '../../src/game';
import { closenessToTarget } from '../../src/equation';

// ─── Betting ──────────────────────────────────────────────────────────────────

/**
 * Conservative betting strategy:
 * - Check when possible (free to stay in).
 * - Call if the price is ≤ 25% of the bot's remaining chips.
 * - Fold otherwise.
 *
 * Bots never raise — keeps interactions simple and avoids collisions with
 * the minimum-stack cap.
 */
export function decideBet(bot: DealtPlayer, state: BettingState): BettingAction {
  const canCheck = state.currentBet <= bot.currentBet;
  if (canCheck) return { type: 'check' };

  const callCost = Math.min(state.currentBet - bot.currentBet, bot.chips);
  if (bot.chips > 0 && callCost / bot.chips <= 0.25) return { type: 'call' };

  return { type: 'fold' };
}

// ─── × card decision ─────────────────────────────────────────────────────────

/**
 * Accept the × card if the bot can sacrifice + or - (the only valid discards).
 * Prefer to discard + and keep -, since subtraction is useful for fine-tuning
 * results toward 1 or 20.  Decline if neither + nor - is available.
 */
export function decideMultiplication(bot: Player): MultiplicationDecision {
  const hasPlus  = bot.personalOperators.some((op) => op.operator === '+');
  const hasMinus = bot.personalOperators.some((op) => op.operator === '-');
  if (hasPlus)  return { accept: true, discard: '+' };
  if (hasMinus) return { accept: true, discard: '-' };
  return { accept: false };
}

// ─── High / Low bet choice ────────────────────────────────────────────────────

/**
 * Pick the side (high or low) whose equation result is closer to the target.
 * Never chooses swing — the risk/reward calculation is non-trivial.
 */
export function decideBetChoice(bot: DealtPlayer): 'high' | 'low' {
  const lowDist  = closenessToTarget(bot.lowResult  ?? Infinity, 1);
  const highDist = closenessToTarget(bot.highResult ?? Infinity, 20);
  return lowDist <= highDist ? 'low' : 'high';
}
