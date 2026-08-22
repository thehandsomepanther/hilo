/**
 * botRunner.ts — subscribes to game state and dispatches bot actions.
 *
 * Bots run exclusively on the host tab (or in standalone mode).  They observe
 * the full unredacted GameState and call the same gameStore action functions
 * that human players use — no special code paths needed in game logic.
 *
 * Each bot seat carries its own `BotDifficulty`, chosen in the lobby, which
 * resolves to the `DifficultyProfile` handed to every decision function.
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
  setPlayerReady,
} from '../gameStore';
import type {
  GameState,
  BettingState,
  CalculationState,
  HighLowBetState,
} from '../../src/types';
import { decideBet, decideMultiplication, decideBetChoice } from './strategy';
import { rankedSolutions, pickCandidate, solveEquations } from './solver';
import { profileFor } from './difficulty';
import type { BotDifficulty } from './difficulty';

/** Bot player id → the difficulty its seat was given in the lobby. */
export type BotRoster = ReadonlyMap<string, BotDifficulty>;

// ─── Scheduling helpers ───────────────────────────────────────────────────────

/**
 * Each scheduled action is keyed so the same action is never double-scheduled.
 * Keys must identify an *action slot*, not a seat: within one betting round the
 * same seat can be asked to act more than once (anyone raising re-opens the
 * betting), and a key that only named the seat would silently swallow every
 * turn after the first — leaving the round unable to complete.
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

function handleState(state: GameState, bots: BotRoster): void {
  switch (state.phase) {
    // ── Betting ───────────────────────────────────────────────────────────── //
    case 'betting-1':
    case 'betting-2': {
      const s = state as BettingState;
      const active = s.players[s.activePlayerIndex];
      if (!active || !bots.has(active.id)) break;

      // `bettingActionsThisRound` advances on every action, so it distinguishes
      // this turn from the same seat's earlier turns while still deduplicating
      // repeat renders of the turn we are already waiting on.
      const key = `${s.round}-${s.phase}-${s.activePlayerIndex}-${s.bettingActionsThisRound}`;
      scheduleOnce(key, randomDelay(), () => {
        // Re-read state at fire time — it may have changed.
        const current = get(gameState);
        if (!current || (current.phase !== 'betting-1' && current.phase !== 'betting-2')) return;
        const cs = current as BettingState;
        const player = cs.players[cs.activePlayerIndex];
        if (!player || !bots.has(player.id)) return;
        doBettingAction(decideBet(player, cs, profileFor(bots.get(player.id))));
      });
      break;
    }

    // ── Calculation ───────────────────────────────────────────────────────── //
    case 'calculation': {
      const s = state as CalculationState;
      // A bot still has work to do if either equation is missing, or if it has
      // both but has not declared itself ready.
      const needsAction = s.players.some(
        (p) => bots.has(p.id) && !p.folded
          && (p.lowEquation === null || p.highEquation === null || !s.readyPlayerIds.includes(p.id)),
      );
      if (!needsAction) break;

      const key = `${s.round}-calculation`;
      scheduleOnce(key, randomDelay(), () => {
        for (const botId of bots.keys()) {
          const current = get(gameState);
          if (!current || current.phase !== 'calculation') return;
          const cs = current as CalculationState;
          const player = cs.players.find((p) => p.id === botId);
          if (!player || player.folded) continue;
          if (player.lowEquation !== null && player.highEquation !== null) continue;

          const tokens = [player.secretCard, ...player.faceUpCards, ...player.personalOperators];
          const { equationSlack } = profileFor(bots.get(botId));

          // A hard bot (slack 0) always plays the closest result it can reach;
          // easier ones settle for something further down the ranking, which
          // is what makes them beatable on the arithmetic rather than only on
          // the cards.
          const ranked = rankedSolutions(tokens);
          const low  = pickCandidate(ranked.low,  equationSlack);
          const high = pickCandidate(ranked.high, equationSlack);
          const fallback = solveEquations(tokens);

          if (player.lowEquation  === null) submitEquation(botId, 'low',  low?.expr  ?? fallback.lowExpr);
          if (player.highEquation === null) submitEquation(botId, 'high', high?.expr ?? fallback.highExpr);
        }

        // Bots must declare themselves ready — nobody else can.  The Ready
        // button only renders for the seat this client controls, so in a
        // networked game a bot has no one to press it, and the host's
        // "Proceed to Betting Phase 2" waits on every active player being
        // ready.  Done in a second pass so it sees the submissions above.
        for (const botId of bots.keys()) {
          const current = get(gameState);
          if (!current || current.phase !== 'calculation') return;
          const player = (current as CalculationState).players.find((p) => p.id === botId);
          if (!player || player.folded) continue;
          if (player.lowEquation !== null && player.highEquation !== null) setPlayerReady(botId);
        }
      });
      break;
    }

    // ── High / Low bet ────────────────────────────────────────────────────── //
    case 'high-low-bet': {
      const s = state as HighLowBetState;
      const needsAction = s.players.some(
        (p) => bots.has(p.id) && !p.folded && p.betChoice === null,
      );
      if (!needsAction) break;

      const key = `${s.round}-high-low-bet`;
      scheduleOnce(key, randomDelay(), () => {
        const current = get(gameState);
        if (!current || current.phase !== 'high-low-bet') return;
        const hs = current as HighLowBetState;
        for (const player of hs.players) {
          if (!bots.has(player.id) || player.folded || player.betChoice !== null) continue;
          submitBotBetChoice(player.id, decideBetChoice(player, profileFor(bots.get(player.id))));
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
 * Start the bot runner for the given bot seats and their difficulties.
 * Returns an unsubscribe function — call it when the game ends.
 */
export function startBotRunner(bots: BotRoster): () => void {
  clearAllPending();

  const unsubState = gameState.subscribe((state) => {
    if (!state) return;
    handleState(state, bots);
  });

  const unsubDecision = pendingDecision.subscribe((pd) => {
    if (!pd || !bots.has(pd.player.id)) return;
    // Short delay so the UI can render the "awaiting decision" overlay briefly.
    setTimeout(() => {
      const current = get(pendingDecision);
      if (!current || current.player.id !== pd.player.id) return;
      resolveDecision(decideMultiplication(current.player, profileFor(bots.get(pd.player.id))));
    }, 200);
  });

  return () => {
    unsubState();
    unsubDecision();
    clearAllPending();
  };
}
