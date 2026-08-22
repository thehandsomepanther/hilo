import type { Player, DealtPlayer, MultiplicationDecision, BettingState, NumberCard } from '../types';
import type { BettingAction } from '../game';
import { decideBet, decideMultiplication, decideBetChoice } from '../../client/bots/strategy';
import { profileFor } from '../../client/bots/difficulty';
import type { BotDifficulty } from '../../client/bots/difficulty';

// ─── Strategy interface ───────────────────────────────────────────────────────

/**
 * `easy` / `medium` / `hard` drive the real game's bots; `conservative` is an
 * alias for `medium` kept so existing simulation configs still read the same.
 * `random` is not a difficulty at all — it is a fuzzer that takes legal but
 * unreasonable lines the tuned profiles never would.
 */
export type BotProfile = 'conservative' | 'random' | BotDifficulty;

export interface BotStrategy {
  decideMultiplication(player: Player): MultiplicationDecision;
  decideBet(player: DealtPlayer, state: BettingState): BettingAction;
  decideBetChoice(player: DealtPlayer): 'high' | 'low' | 'swing';
}

// ─── Difficulty-driven strategies ─────────────────────────────────────────────

/**
 * Cheap stand-in for `handStrength`, which runs the brute-force solver.  The
 * harness plays thousands of games and already substitutes numeric proxies for
 * equations (see `computeEquations` below) for exactly this reason; the
 * betting paths under test care that *a* strength arrives, not that it is the
 * true one.
 */
function proxyStrength(player: DealtPlayer): number {
  const nums = [player.secretCard, ...player.faceUpCards]
    .filter((c): c is NumberCard => c.kind === 'number')
    .map((c) => c.value as number);
  const sum = nums.reduce((s, v) => s + v, 0);
  const best = Math.min(Math.abs(sum - 1), Math.abs(sum + 10 - 20));
  return 1 / (1 + best);
}

function difficultyStrategy(difficulty: BotDifficulty): BotStrategy {
  // `evaluatesMultiplication` is forced off for the same reason as the strength
  // proxy: it is a solver call, and the harness cannot afford one per decision.
  const profile = { ...profileFor(difficulty), evaluatesMultiplication: false };
  return {
    decideMultiplication: (player) => decideMultiplication(player, profile),
    decideBet: (player, state) => decideBet(player, state, profile, proxyStrength(player)),
    decideBetChoice: (player) => decideBetChoice(player, profile),
  };
}

export const conservativeStrategy: BotStrategy = difficultyStrategy('medium');

// ─── Random strategy ──────────────────────────────────────────────────────────

function randomRaiseAmount(player: DealtPlayer, state: BettingState): number | null {
  if (state.bettingLocked) return null;
  const active = state.players.filter((p) => !p.folded);
  const minStack = Math.min(...active.map((p) => p.chips + p.currentBet));
  const minRaise = state.currentBet + 1;
  if (minRaise > minStack) return null;
  const playerMax = player.chips + player.currentBet;
  if (playerMax < minRaise) return null;
  const maxRaise = Math.min(minStack, playerMax);
  return minRaise + Math.floor(Math.random() * (maxRaise - minRaise + 1));
}

export const randomStrategy: BotStrategy = {
  decideMultiplication(player: Player): MultiplicationDecision {
    const hasPlus  = player.personalOperators.some((op) => op.operator === '+');
    const hasMinus = player.personalOperators.some((op) => op.operator === '-');
    if ((hasPlus || hasMinus) && Math.random() < 0.5) {
      if (hasPlus && hasMinus) {
        return Math.random() < 0.5
          ? { accept: true, discard: '+' }
          : { accept: true, discard: '-' };
      }
      return { accept: true, discard: hasPlus ? '+' : '-' };
    }
    return { accept: false };
  },

  decideBet(player: DealtPlayer, state: BettingState): BettingAction {
    const canCheck = state.currentBet <= player.currentBet;
    const raiseAmt = randomRaiseAmount(player, state);
    const r = Math.random();
    if (canCheck) {
      if (raiseAmt !== null && r < 0.2) return { type: 'raise', amount: raiseAmt };
      return { type: 'check' };
    } else {
      if (r < 0.3) return { type: 'fold' };
      if (raiseAmt !== null && r < 0.5) return { type: 'raise', amount: raiseAmt };
      return { type: 'call' };
    }
  },

  decideBetChoice(): 'high' | 'low' {
    return Math.random() < 0.5 ? 'high' : 'low';
  },
};

export function getStrategy(profile: BotProfile): BotStrategy {
  if (profile === 'random') return randomStrategy;
  if (profile === 'conservative') return conservativeStrategy;
  return difficultyStrategy(profile);
}

// ─── Equation stub ────────────────────────────────────────────────────────────

export interface EquationResult {
  lowResult: number | null;
  highResult: number | null;
  lowEquation: string | null;
  highEquation: string | null;
}

/**
 * Fast simulation-only equation stub.
 *
 * The brute-force solver (O(n! × m!) string evaluations) is far too slow for
 * thousands of games. Here we compute numeric proxies directly from card
 * values: the simulation harness only needs non-null results to exercise the
 * high/low bet and payout paths; equation quality is irrelevant.
 *
 * recordEquationResults stores whatever numbers we pass; resolveRound uses
 * them directly without re-validating the equation strings.
 */
export function computeEquations(player: DealtPlayer): EquationResult {
  const nums = [player.secretCard, ...player.faceUpCards]
    .filter((c): c is NumberCard => c.kind === 'number')
    .map((c) => c.value as number);
  const sum = nums.reduce((s, v) => s + v, 0);
  return {
    lowResult: sum,
    highResult: sum + 10,
    lowEquation: null,
    highEquation: null,
  };
}
