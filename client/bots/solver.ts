/**
 * solver.ts — brute-force equation solver for bots.
 *
 * Given a player's full set of cards, finds the expression (using every card
 * exactly once) whose result is closest to 1 (low) and closest to 20 (high).
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

/**
 * Find expressions using every card in `cards` exactly once that are closest
 * to 1 (low target) and 20 (high target).
 *
 * Falls back to the first valid expression for any target that has no solution,
 * which should never occur with a legal hand.
 */
export function solveEquations(cards: Card[]): SolverResult {
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

  let bestLow:  { expr: string; dist: number } | null = null;
  let bestHigh: { expr: string; dist: number } | null = null;

  const numPerms  = permutations(numbers);
  const opPerms   = permutations(binaryOps);
  const masks     = sqrtMasks(numbers.length, sqrtCount);

  for (const numPerm of numPerms) {
    for (const opPerm of opPerms) {
      for (const mask of masks) {
        const expr = buildExpression(numPerm, opPerm, mask);
        const result = evaluateEquation(expr, cards);
        if (!result.ok) continue;

        const distLow  = Math.abs(result.value - 1);
        const distHigh = Math.abs(result.value - 20);

        if (bestLow  === null || distLow  < bestLow.dist)  bestLow  = { expr, dist: distLow  };
        if (bestHigh === null || distHigh < bestHigh.dist) bestHigh = { expr, dist: distHigh };

        // Early exit: perfect solutions found
        if (bestLow.dist === 0 && bestHigh.dist === 0) break;
      }
    }
  }

  const fallback = bestLow?.expr ?? bestHigh?.expr ?? numbers.join(' + ');
  return {
    lowExpr:  bestLow?.expr  ?? fallback,
    highExpr: bestHigh?.expr ?? fallback,
  };
}
