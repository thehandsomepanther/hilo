/**
 * botRunner.ts — subscribes to game state and dispatches bot actions.
 *
 * Bots run exclusively on the host tab (or in standalone mode).  They observe
 * the full unredacted GameState and call the same gameStore action functions
 * that human players use — no special code paths needed in game logic.
 *
 * Timing: actions are delayed by a short random interval (700–1100 ms) to
 * feel natural.  × card decisions use a shorter delay (200 ms) so dealing
 * doesn't feel stuck.
 */

import { get } from 'svelte/store';
import {
  gameState,
  pendingDecision,
  doBettingAction,
  submitEquation,
  resolveDecision,
  submitBotBetChoice,
} from '../gameStore';
import type {
  GameState,
  BettingState,
  CalculationState,
  HighLowBetState,
} from '../../src/types';
import { decideBet, decideMultiplication, decideBetChoice } from './strategy';
import { solveEquations } from './solver';

// ─── Scheduling helpers ───────────────────────────────────────────────────────

/**
 * Each scheduled action is keyed so the same action is never double-scheduled.
 * Keys include round + phase + enough context to distinguish each unique action
 * (e.g. the active player index for betting).
 */
const scheduledKeys = new Set<string>();
const pendingTimeouts = new Set<ReturnType<typeof setTimeout>>();

function scheduleOnce(key: string, delay: number, fn: () => void): void {
  if (scheduledKeys.has(key)) return;
  scheduledKeys.add(key);
  const t = setTimeout(() => {
    pendingTimeouts.delete(t);
    fn();
  }, delay);
  pendingTimeouts.add(t);
}

function randomDelay(): number {
  return 700 + Math.random() * 400;
}

function clearAllPending(): void {
  for (const t of pendingTimeouts) clearTimeout(t);
  pendingTimeouts.clear();
  scheduledKeys.clear();
}

// ─── Phase handlers ───────────────────────────────────────────────────────────

function handleState(state: GameState, botIds: Set<string>): void {
  switch (state.phase) {
    // ── Betting ───────────────────────────────────────────────────────────── //
    case 'betting-1':
    case 'betting-2': {
      const s = state as BettingState;
      const active = s.players[s.activePlayerIndex];
      if (!active || !botIds.has(active.id)) break;

      const key = `${s.round}-${s.phase}-${s.activePlayerIndex}`;
      scheduleOnce(key, randomDelay(), () => {
        // Re-read state at fire time — it may have changed.
        const current = get(gameState);
        if (!current || (current.phase !== 'betting-1' && current.phase !== 'betting-2')) return;
        const cs = current as BettingState;
        const player = cs.players[cs.activePlayerIndex];
        if (!player || !botIds.has(player.id)) return;
        doBettingAction(decideBet(player, cs));
      });
      break;
    }

    // ── Calculation ───────────────────────────────────────────────────────── //
    case 'calculation': {
      const s = state as CalculationState;
      // Check whether any bot still needs to submit.
      const needsAction = s.players.some(
        (p) => botIds.has(p.id) && !p.folded && (p.lowEquation === null || p.highEquation === null),
      );
      if (!needsAction) break;

      const key = `${s.round}-calculation`;
      scheduleOnce(key, randomDelay(), () => {
        for (const botId of botIds) {
          const current = get(gameState);
          if (!current || current.phase !== 'calculation') return;
          const cs = current as CalculationState;
          const player = cs.players.find((p) => p.id === botId);
          if (!player || player.folded) continue;
          if (player.lowEquation !== null && player.highEquation !== null) continue;

          const tokens = [player.secretCard, ...player.faceUpCards, ...player.personalOperators];
          const { lowExpr, highExpr } = solveEquations(tokens);

          if (player.lowEquation  === null) submitEquation(botId, 'low',  lowExpr);
          if (player.highEquation === null) submitEquation(botId, 'high', highExpr);
        }
      });
      break;
    }

    // ── High / Low bet ────────────────────────────────────────────────────── //
    case 'high-low-bet': {
      const s = state as HighLowBetState;
      const needsAction = s.players.some(
        (p) => botIds.has(p.id) && !p.folded && p.betChoice === null,
      );
      if (!needsAction) break;

      const key = `${s.round}-high-low-bet`;
      scheduleOnce(key, randomDelay(), () => {
        const current = get(gameState);
        if (!current || current.phase !== 'high-low-bet') return;
        const hs = current as HighLowBetState;
        for (const player of hs.players) {
          if (!botIds.has(player.id) || player.folded || player.betChoice !== null) continue;
          submitBotBetChoice(player.id, decideBetChoice(player));
        }
      });
      break;
    }

    default:
      break;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the bot runner for the given set of bot player IDs.
 * Returns an unsubscribe function — call it when the game ends.
 */
export function startBotRunner(botIds: Set<string>): () => void {
  clearAllPending();

  const unsubState = gameState.subscribe((state) => {
    if (!state) return;
    handleState(state, botIds);
  });

  const unsubDecision = pendingDecision.subscribe((pd) => {
    if (!pd || !botIds.has(pd.player.id)) return;
    // Short delay so the UI can render the "awaiting decision" overlay briefly.
    setTimeout(() => {
      const current = get(pendingDecision);
      if (!current || current.player.id !== pd.player.id) return;
      resolveDecision(decideMultiplication(current.player));
    }, 200);
  });

  return () => {
    unsubState();
    unsubDecision();
    clearAllPending();
  };
}
