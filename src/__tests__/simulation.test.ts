import { describe, it, expect } from 'vitest';
import { runBatch } from '../sim/runner';
import type { Failure } from '../sim/runner';

const GAMES_PER_CONFIG = 1_000;

function formatFailures(failures: Failure[]): string {
  return failures
    .slice(0, 3)
    .map((f) => `  game ${f.gameIndex} @ "${f.label}": ${f.message}`)
    .join('\n');
}

describe('simulation', () => {
  for (const playerCount of [2, 3, 4]) {
    describe(`${playerCount} players`, () => {
      it('conservative bots — no invariant violations', { timeout: 120_000 }, () => {
        const failures = runBatch(GAMES_PER_CONFIG, { playerCount, strategy: 'conservative' });
        expect(failures, `\n${formatFailures(failures)}`).toHaveLength(0);
      });

      it('random bots — no invariant violations', { timeout: 120_000 }, () => {
        const failures = runBatch(GAMES_PER_CONFIG, { playerCount, strategy: 'random' });
        expect(failures, `\n${formatFailures(failures)}`).toHaveLength(0);
      });

      // Each difficulty takes different lines through the engine — hard bots
      // raise and declare swing, easy ones fold far more often — so each needs
      // its own fuzzing.  A raise that ignores the minimum-stack cap throws
      // inside applyBettingAction, and this is what catches it.
      for (const difficulty of ['easy', 'medium', 'hard'] as const) {
        it(`${difficulty} bots — no invariant violations`, { timeout: 120_000 }, () => {
          const failures = runBatch(GAMES_PER_CONFIG, { playerCount, strategy: difficulty });
          expect(failures, `\n${formatFailures(failures)}`).toHaveLength(0);
        });
      }
    });
  }
});
