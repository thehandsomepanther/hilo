/**
 * gameStore.ts — all cross-component state and game-action dispatchers.
 *
 * Components import from here; they never call src/ modules directly.
 * All game logic stays in src/; this file is pure orchestration.
 */

import { writable, get } from 'svelte/store';
import type { GameState, Player, MultiplicationDecision, RoundResult } from '../src/types';
import type { BettingAction } from '../src/game';
import {
  createGame,
  startRound,
  collectForcedBets,
  applyBettingAction,
  resetBettingRound,
  applyBetChoices,
  recordEquationResults,
} from '../src/game';
import { evaluateEquation } from '../src/equation';
import { resolveRound, applyPayouts } from '../src/results';
import { runDealPhase1Async, runDealPhase2Async } from './dealing';

// ─── Stores ───────────────────────────────────────────────────────────────────

export const gameState = writable<GameState | null>(null);

/** Set while an async deal is in progress — disable action buttons. */
export const isDealing = writable(false);

/** Set when the dealing async function needs the active player to choose. */
export type PendingDecision = {
  player: Player;
  resolve: (d: MultiplicationDecision) => void;
};
export const pendingDecision = writable<PendingDecision | null>(null);

/** Populated once bet choices are submitted; cleared on next round. */
export const roundResult = writable<RoundResult | null>(null);

// ─── Dealing helpers ──────────────────────────────────────────────────────────

/** Called by dealing.ts when a × card is drawn. Sets `pendingDecision` and
 *  returns a Promise that resolves once the player has chosen via `resolveDecision`. */
function makeRequestDecision(): (player: Player) => Promise<MultiplicationDecision> {
  return (player: Player) =>
    new Promise<MultiplicationDecision>((resolve) => {
      pendingDecision.set({ player, resolve });
    });
}

/** Called by the UI when the player submits their × choice. */
export function resolveDecision(decision: MultiplicationDecision): void {
  const current = get(pendingDecision);
  if (current) {
    current.resolve(decision);
    pendingDecision.set(null);
  }
}

// ─── Game lifecycle ───────────────────────────────────────────────────────────

export function initGame(
  playerNames: string[],
  startingChips: number,
  forcedBetAmount: number,
): void {
  const s = createGame(playerNames, startingChips, forcedBetAmount);
  gameState.set(startRound(s));
  roundResult.set(null);
}

export function doForcedBets(): void {
  gameState.update((s) => (s ? collectForcedBets(s) : null));
}

export async function doDeal(phase: 1 | 2): Promise<void> {
  const state = get(gameState);
  if (!state) return;
  isDealing.set(true);
  try {
    const requestDecision = makeRequestDecision();
    // onUpdate lets dealing publish intermediate state so cards appear live
    const onUpdate = (s: GameState) => gameState.set(s);
    const next =
      phase === 1
        ? await runDealPhase1Async(state, requestDecision, onUpdate)
        : await runDealPhase2Async(state, requestDecision, onUpdate);
    gameState.set(next);
  } finally {
    isDealing.set(false);
  }
}

// ─── Betting ──────────────────────────────────────────────────────────────────

export function doBettingAction(action: BettingAction): void {
  const state = get(gameState);
  if (!state) return;

  const { state: next, roundComplete } = applyBettingAction(state, action);

  if (!roundComplete) {
    gameState.set(next);
    return;
  }

  // Only one player left — skip ahead to results immediately
  const activePlayers = next.players.filter((p) => !p.folded);
  if (activePlayers.length <= 1) {
    const resultState: GameState = { ...next, phase: 'results' };
    roundResult.set(resolveRound(resultState));
    gameState.set(resultState);
    return;
  }

  // Normal round complete — advance phase
  const nextPhase = state.phase === 'betting-1' ? 'dealing-2' : 'high-low-bet';
  gameState.set(resetBettingRound(next, nextPhase));
}

// ─── Calculation ──────────────────────────────────────────────────────────────

/** Validate an equation for a player and store the result. Returns an error string or null. */
export function submitEquation(
  playerId: string,
  target: 'low' | 'high',
  expression: string,
): string | null {
  const state = get(gameState);
  if (!state) return 'No game in progress';

  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 'Player not found';

  const allCards = [
    ...(player.secretCard ? [player.secretCard] : []),
    ...player.faceUpCards,
    ...player.personalOperators,
  ];

  const result = evaluateEquation(expression, allCards);
  if (!result.ok) return result.error;

  const low = target === 'low' ? result.value : player.lowResult;
  const high = target === 'high' ? result.value : player.highResult;
  const lowEq = target === 'low' ? expression : player.lowEquation;
  const highEq = target === 'high' ? expression : player.highEquation;

  gameState.set(recordEquationResults(state, playerId, low, high, lowEq, highEq));
  return null;
}

export function doAdvanceToBetting2(): void {
  gameState.update((s) => (s ? resetBettingRound(s, 'betting-2') : null));
}

// ─── High/Low Bet ─────────────────────────────────────────────────────────────

export function doSubmitBetChoices(choices: Map<string, Player['betChoice']>): void {
  const state = get(gameState);
  if (!state) return;
  const withChoices = applyBetChoices(state, choices);
  const result = resolveRound(withChoices);
  roundResult.set(result);
  gameState.set(withChoices);
}

// ─── Next round ───────────────────────────────────────────────────────────────

export function doNextRound(): void {
  const state = get(gameState);
  if (!state) return;
  const result = get(roundResult);
  const afterPayout = result ? applyPayouts(state, result) : state;
  roundResult.set(null);
  gameState.set(startRound(afterPayout));
}
