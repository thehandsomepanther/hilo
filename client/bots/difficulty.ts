/**
 * difficulty.ts — the per-bot skill profiles.
 *
 * A bot's difficulty is chosen per seat in the lobby and rides along on
 * `LobbyPlayer`, so `initGame` can hand the bot runner a profile for every bot
 * player id.
 *
 * The dials are deliberately small in number and each one maps to something a
 * human at the table would notice:
 *
 *  - `equationSlack` — how far down the ranked list of possible equations the
 *    bot is willing to settle.  This is the dominant lever: the solver can
 *    always find the mathematically closest result to 1 and to 20, and a bot
 *    that always plays it cannot be out-calculated.
 *  - the betting fields — whether the bot's price tolerance responds to the
 *    hand it is actually holding, and whether it ever puts pressure on.
 *  - the declaration fields — how often it picks the wrong side of the pot,
 *    and whether it understands swing well enough to try it.
 *
 * Named `DifficultyProfile` rather than `BotProfile` because `src/sim/bots.ts`
 * already uses `BotProfile` for the simulation harness's fuzzing strategies.
 */

export type BotDifficulty = 'easy' | 'medium' | 'hard';

export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'medium', 'hard'];

export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'medium';

export interface DifficultyProfile {
  /**
   * How far into the ranked candidate list the bot will reach when choosing an
   * equation.  0 always takes the best result; 1 picks anywhere in the list.
   */
  equationSlack: number;
  /** Share of its remaining stack the bot will pay to call, before any read. */
  baseCallFraction: number;
  /** Does the strength of the hand it is holding move that fraction? */
  readsOwnHand: boolean;
  /** Will it raise when it is holding something strong? */
  raises: boolean;
  /** Solve the hand both ways before accepting or declining a × card. */
  evaluatesMultiplication: boolean;
  /** Chance of declaring the worse of the two sides. */
  sideMistakeChance: number;
  /** Will it declare swing when both sides are exact? */
  swings: boolean;
}

/**
 * `hard` is exactly the bot that shipped before difficulty existed as far as
 * equations go — `equationSlack: 0` is the old always-take-the-best solver —
 * with the betting and declaration play it always should have had.
 */
export const DIFFICULTY_PROFILES: Record<BotDifficulty, DifficultyProfile> = {
  easy: {
    equationSlack: 0.6,
    baseCallFraction: 0.15,
    readsOwnHand: false,
    raises: false,
    evaluatesMultiplication: false,
    sideMistakeChance: 0.2,
    swings: false,
  },
  medium: {
    equationSlack: 0.2,
    baseCallFraction: 0.25,
    readsOwnHand: true,
    raises: false,
    evaluatesMultiplication: false,
    sideMistakeChance: 0.05,
    swings: false,
  },
  hard: {
    equationSlack: 0,
    baseCallFraction: 0.35,
    readsOwnHand: true,
    raises: true,
    evaluatesMultiplication: true,
    sideMistakeChance: 0,
    swings: true,
  },
};

export function profileFor(difficulty: BotDifficulty = DEFAULT_BOT_DIFFICULTY): DifficultyProfile {
  return DIFFICULTY_PROFILES[difficulty] ?? DIFFICULTY_PROFILES[DEFAULT_BOT_DIFFICULTY];
}

/** Display label for the lobby dropdown and the in-game player table. */
export function difficultyLabel(difficulty: BotDifficulty): string {
  return difficulty.charAt(0).toUpperCase() + difficulty.slice(1);
}
