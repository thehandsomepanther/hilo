import {
  createGame, startRound, collectForcedBets,
  applyBettingAction, isBettingComplete, advanceFromBetting,
  recordBetChoice, advanceFromHighLowBet, advanceFromResults,
  recordEquationResults, initBettingRound,
} from '../game';
import { startDealPhase1, startDealPhase2 } from '../../client/dealing';
import type { DealStep } from '../../client/dealing';
import { checkInvariants, InvariantError } from './invariants';
import { getStrategy, computeEquations } from './bots';
import type { BotProfile, BotStrategy } from './bots';
import type {
  GameState, GameOverState, BettingState, CalculationState, DealtPlayer,
  ForcedBetState, Dealing2State, HighLowBetState, ResultsState, Player,
} from '../types';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface RunOptions {
  playerCount: number;
  startingChips?: number;
  strategy?: BotProfile;
  /** Safety cap; games that run this long have a bug. Default: 500. */
  maxRounds?: number;
}

export interface Failure {
  gameIndex: number;
  label: string;
  message: string;
  /** Full game state at the point of failure — enough to write a targeted test. */
  state: GameState;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function driveDeal<T>(step: DealStep<T>, bot: BotStrategy): T {
  let current = step;
  while (current.status === 'awaiting-decision') {
    current = current.resume(bot.decideMultiplication(current.player as Player));
  }
  return current.state;
}

function driveBetting(
  initial: BettingState,
  bot: BotStrategy,
  totalChips: number,
): BettingState {
  let state = initial;
  let iterations = 0;
  while (!isBettingComplete(state)) {
    if (iterations++ > 500) {
      throw new Error('safety limit: betting round exceeded 500 actions');
    }
    const player = state.players[state.activePlayerIndex] as DealtPlayer;
    const action = bot.decideBet(player, state);
    state = applyBettingAction(state, action).state;
    checkInvariants(state, `${state.phase}.bet`, totalChips);
  }
  return state;
}

function driveCalculation(state: CalculationState): CalculationState {
  let current = state;
  for (const player of state.players.filter((p) => !p.folded)) {
    const eq = computeEquations(player);
    current = recordEquationResults(
      current, player.id,
      eq.lowResult, eq.highResult,
      eq.lowEquation, eq.highEquation,
    );
  }
  return current;
}

function driveHighLowBet(state: HighLowBetState, bot: BotStrategy): HighLowBetState {
  let current = state;
  for (const player of state.players.filter((p) => !p.folded)) {
    const choice = bot.decideBetChoice(player);
    current = recordBetChoice(current, player.id, choice).state;
  }
  return current;
}

// ─── Single-game runner ───────────────────────────────────────────────────────

/**
 * Run one complete game using bot strategies.
 * Throws `InvariantError` on the first violated invariant, with the game state
 * at the point of failure attached so a targeted regression test can be written.
 */
export function runGame(options: RunOptions, gameIndex = 0): GameOverState {
  void gameIndex; // available to callers for failure reporting

  const {
    playerCount,
    startingChips = 50,
    strategy: profile = 'conservative',
    maxRounds = 500,
  } = options;

  const bot = getStrategy(profile);
  const names = Array.from({ length: playerCount }, (_, i) => `P${i + 1}`);
  const totalChips = playerCount * startingChips;

  const setup = createGame(names, startingChips, 90, false);
  let roundState: ForcedBetState = startRound(setup);
  checkInvariants(roundState, 'startRound', totalChips);

  for (let round = 0; round < maxRounds; round++) {

    // ── Forced bets ────────────────────────────────────────────────────────
    const dealt = collectForcedBets(roundState);
    checkInvariants(dealt, 'collectForcedBets', totalChips);

    // ── Deal phase 1 → Betting1State ───────────────────────────────────────
    const betting1 = driveDeal(startDealPhase1(dealt), bot);
    checkInvariants(betting1, 'dealPhase1', totalChips);

    // ── Betting round 1 ────────────────────────────────────────────────────
    const afterBet1 = advanceFromBetting(driveBetting(betting1, bot, totalChips));
    checkInvariants(afterBet1, 'advanceFromBetting1', totalChips);

    if (afterBet1.phase === 'results') {
      const next = advanceFromResults(afterBet1 as ResultsState);
      checkInvariants(next, 'advanceFromResults(early1)', totalChips);
      if (next.phase === 'game-over') return next as GameOverState;
      roundState = next as ForcedBetState;
      continue;
    }

    // ── Deal phase 2 → CalculationState ───────────────────────────────────
    const calcRaw = driveDeal(startDealPhase2(afterBet1 as Dealing2State), bot);
    checkInvariants(calcRaw, 'dealPhase2', totalChips);

    const calcSolved = driveCalculation(calcRaw);
    checkInvariants(calcSolved, 'equations', totalChips);

    // ── Betting round 2 ────────────────────────────────────────────────────
    const betting2 = initBettingRound(calcSolved, 'betting-2');
    checkInvariants(betting2, 'initBettingRound2', totalChips);

    const afterBet2 = advanceFromBetting(driveBetting(betting2, bot, totalChips));
    checkInvariants(afterBet2, 'advanceFromBetting2', totalChips);

    if (afterBet2.phase === 'results') {
      const next = advanceFromResults(afterBet2 as ResultsState);
      checkInvariants(next, 'advanceFromResults(early2)', totalChips);
      if (next.phase === 'game-over') return next as GameOverState;
      roundState = next as ForcedBetState;
      continue;
    }

    // ── High/low bet ───────────────────────────────────────────────────────
    const hlFinal = driveHighLowBet(afterBet2 as HighLowBetState, bot);
    checkInvariants(hlFinal, 'recordBetChoices', totalChips);

    const results = advanceFromHighLowBet(hlFinal);
    checkInvariants(results, 'advanceFromHighLowBet', totalChips);

    const next = advanceFromResults(results);
    checkInvariants(next, 'advanceFromResults', totalChips);

    if (next.phase === 'game-over') return next as GameOverState;
    roundState = next as ForcedBetState;
  }

  throw new Error(`game did not complete within ${maxRounds} rounds`);
}

// ─── Batch runner ─────────────────────────────────────────────────────────────

/**
 * Run `count` independent games and collect any invariant violations.
 * Returns an empty array when all games pass.
 */
export function runBatch(count: number, options: RunOptions): Failure[] {
  const failures: Failure[] = [];
  for (let i = 0; i < count; i++) {
    try {
      runGame(options, i);
    } catch (e) {
      if (e instanceof InvariantError) {
        failures.push({
          gameIndex: i,
          label: e.label,
          message: e.message,
          state: e.state,
        });
      } else {
        failures.push({
          gameIndex: i,
          label: 'unexpected-error',
          message: (e as Error).message,
          state: {} as GameState,
        });
      }
    }
  }
  return failures;
}
