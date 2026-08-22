/**
 * solver.ts — brute-force equation solver for bots.
 *
 * Given a player's full set of cards, ranks the expressions (each using every
 * card exactly once) by how close their result lands to 1 (low) and to 20
 * (high).  `solveEquations` returns the best of each, which is what a hard bot
 * plays; easier bots reach further down the ranking via `pickCandidate`.
 *
 * Algorithm: enumerate all permutations of numbers × all permutations of
 * binary operators × all placements of √ operators, then evaluate each
 * candidate with the existing evaluateEquation validator.
 *
 * Typical hand size is 7–8 tokens, giving at most ~1500 candidates — trivial.
 */

import type { Card } from '../../src/types';
import { evaluateEquation } from '../../src/equation';

// ─── Combinatorics helpers ────────────────────────────────────────────────────

function permutations<T>(arr: T[]): T[][] {
  if (arr.length === 0) return [[]];
  if (arr.length === 1) return [[arr[0]!]];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const head = arr[i]!;
    const tail = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const rest of permutations(tail)) result.push([head, ...rest]);
  }
  return result;
}

/**
 * All boolean masks of length `n` with exactly `trueCount` true entries.
 * Used to decide which numbers get a √ prefix.
 */
function sqrtMasks(n: number, trueCount: number): boolean[][] {
  if (trueCount === 0) return [Array<boolean>(n).fill(false)];
  if (trueCount === n) return [Array<boolean>(n).fill(true)];
  if (n === 0) return [];
  const withTrue  = sqrtMasks(n - 1, trueCount - 1).map((m) => [true,  ...m]);
  const withFalse = sqrtMasks(n - 1, trueCount    ).map((m) => [false, ...m]);
  return [...withTrue, ...withFalse];
}

// ─── Expression builder ───────────────────────────────────────────────────────

/**
 * Build a flat infix expression string from ordered numbers, binary operators,
 * and a per-number √ mask.
 *
 * Example: numbers=[3,5,2], binaryOps=['+','÷'], sqrtMask=[false,true,false]
 * → "3 + √ 5 ÷ 2"
 */
function buildExpression(
  numbers: number[],
  binaryOps: string[],
  sqrtMask: boolean[],
): string {
  const parts: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    if (i > 0) parts.push(binaryOps[i - 1]!);
    if (sqrtMask[i]) parts.push('√');
    parts.push(String(numbers[i]));
  }
  return parts.join(' ');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SolverResult {
  lowExpr: string;
  highExpr: string;
}

/** One playable expression and how far its result lands from a target. */
export interface Candidate {
  expr: string;
  value: number;
  dist: number;
}

export interface RankedSolutions {
  /** Distinct results, nearest to 1 first. */
  low: Candidate[];
  /** Distinct results, nearest to 20 first. */
  high: Candidate[];
}

/**
 * Betting now consults the solver on every decision rather than once per round,
 * and a bot's hand only changes when it draws, so the same enumeration would
 * otherwise be repeated over identical cards several times a round.  Bounded,
 * because this module lives as long as the tab does.
 */
const solutionCache = new Map<string, RankedSolutions>();
const SOLUTION_CACHE_LIMIT = 256;

/** Order-independent key for a hand: the same cards always hash the same. */
function cardSignature(cards: Card[]): string {
  return cards
    .map((c) => (c.kind === 'number' ? `n${c.value}` : `o${c.operator}`))
    .sort()
    .join(',');
}

/**
 * Every expression that uses each card in `cards` exactly once, ranked for
 * both targets.
 *
 * Candidates are deduplicated **by result value**, not by expression: a bot
 * settling for "the fifth-best answer" should land on the fifth-best number,
 * not on the fifth way of spelling the best one.
 */
export function rankedSolutions(cards: Card[]): RankedSolutions {
  const key = cardSignature(cards);
  const cached = solutionCache.get(key);
  if (cached) return cached;

  const numbers: number[] = [];
  const binaryOps: string[] = [];
  let sqrtCount = 0;

  for (const card of cards) {
    if (card.kind === 'number') {
      numbers.push(card.value);
    } else if (card.operator === '√') {
      sqrtCount++;
    } else {
      binaryOps.push(card.operator);
    }
  }

  const byValue = new Map<number, string>();

  const numPerms  = permutations(numbers);
  const opPerms   = permutations(binaryOps);
  const masks     = sqrtMasks(numbers.length, sqrtCount);

  for (const numPerm of numPerms) {
    for (const opPerm of opPerms) {
      for (const mask of masks) {
        const expr = buildExpression(numPerm, opPerm, mask);
        const result = evaluateEquation(expr, cards);
        if (!result.ok) continue;
        if (!byValue.has(result.value)) byValue.set(result.value, expr);
      }
    }
  }

  const rank = (target: number): Candidate[] =>
    [...byValue.entries()]
      .map(([value, expr]) => ({ expr, value, dist: Math.abs(value - target) }))
      .sort((a, b) => a.dist - b.dist);

  const ranked: RankedSolutions = { low: rank(1), high: rank(20) };

  if (solutionCache.size >= SOLUTION_CACHE_LIMIT) solutionCache.clear();
  solutionCache.set(key, ranked);
  return ranked;
}

/**
 * Choose from a ranking, reaching `slack` of the way down it.
 *
 * `slack: 0` always returns the best candidate — that is a hard bot, and it is
 * what the solver did before difficulty existed.  Larger values widen the
 * window the pick is drawn from, so an easy bot lands on a plausible worse
 * answer rather than on a uniformly random one.
 */
export function pickCandidate(
  ranked: Candidate[],
  slack: number,
  rng: () => number = Math.random,
): Candidate | null {
  if (ranked.length === 0) return null;
  const window = Math.max(1, Math.min(ranked.length, Math.floor(1 + slack * (ranked.length - 1))));
  const index = Math.min(window - 1, Math.floor(rng() * window));
  return ranked[index] ?? ranked[0]!;
}

/**
 * Find expressions using every card in `cards` exactly once that are closest
 * to 1 (low target) and 20 (high target).
 *
 * Falls back to the first valid expression for any target that has no solution,
 * which should never occur with a legal hand.
 */
export function solveEquations(cards: Card[]): SolverResult {
  const { low, high } = rankedSolutions(cards);
  const numbers = cards.reduce<number[]>(
    (acc, c) => (c.kind === 'number' ? [...acc, c.value] : acc),
    [],
  );
  const fallback = low[0]?.expr ?? high[0]?.expr ?? numbers.join(' + ');
  return {
    lowExpr:  low[0]?.expr  ?? fallback,
    highExpr: high[0]?.expr ?? fallback,
  };
}
