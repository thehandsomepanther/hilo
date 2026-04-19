/**
 * dealing.ts — synchronous step machine for card dealing.
 *
 * The core dealing logic in src/game.ts is pure and synchronous.  This module
 * wraps it in a step-machine pattern so the UI can pause on × card decisions
 * and resume once the player has chosen — without any async callbacks.
 *
 * Each DealStep is either:
 *   - `complete`: dealing is done; `state` is the final post-deal GameState.
 *   - `awaiting-decision`: a × card was drawn; the UI must call `resume` with
 *     the player's MultiplicationDecision to continue.
 *
 * No I/O or Promises anywhere in this file.
 */

import { drawCard, drawNumberCard } from '../src/deck';
import { dealSecretCards, initBettingRound } from '../src/game';
import type {
  Dealing1State, Dealing2State, Betting1State, CalculationState,
  Player, DealtPlayer, Card, MultiplicationDecision,
} from '../src/types';

// ─── Public step type ─────────────────────────────────────────────────────────

export type DealStep<Final> =
  | { status: 'complete'; state: Final }
  | {
      status: 'awaiting-decision';
      /** The player who drew a × card and must decide. */
      player: Player;
      /** Intermediate game state (for live UI updates while dealing). */
      state: Dealing1State | Dealing2State;
      /** Call with the player's choice to continue dealing. */
      resume: (decision: MultiplicationDecision) => DealStep<Final>;
    };

// ─── Internal per-player dealing ──────────────────────────────────────────────

type CardAccumulator = {
  faceUpCards: Card[];
  personalOperators: { kind: 'operator'; operator: '+' | '-' | '÷' | '×' | '√' }[];
};

/**
 * Synchronously draw one face-up card for a player.
 * Returns the updated accumulator, remaining deck, and whether a symbol card
 * was placed (√ or accepted ×).
 *
 * When a × card is drawn, returns a suspension instead so the caller can
 * ask the player for their decision.
 */
type DrawOneResult =
  | { kind: 'done'; acc: CardAccumulator; deck: Card[]; wasSymbol: boolean }
  | { kind: 'needs-decision'; player: Player; deck: Card[]; acc: CardAccumulator;
      resume: (d: MultiplicationDecision) => DrawOneResult };

function drawOneFaceUp(
  basePlayer: Player,
  acc: CardAccumulator,
  deck: Card[],
): DrawOneResult {
  const { card, remaining } = drawCard(deck);

  if (card.kind === 'number') {
    return { kind: 'done', acc: { ...acc, faceUpCards: [...acc.faceUpCards, card] }, deck: remaining, wasSymbol: false };
  }

  if (card.operator === '√') {
    // Prevent a second √ in the same hand — it makes valid equations impossible.
    const alreadyHasSqrt = acc.faceUpCards.some((c) => c.kind === 'operator' && c.operator === '√');
    if (alreadyHasSqrt) {
      // Treat this √ like any other non-number card: replace with a number.
      const { card: num, remaining: rem } = drawNumberCard(remaining);
      return { kind: 'done', acc: { ...acc, faceUpCards: [...acc.faceUpCards, num] }, deck: rem, wasSymbol: false };
    }
    const { card: num, remaining: rem } = drawNumberCard(remaining);
    return {
      kind: 'done',
      acc: { ...acc, faceUpCards: [...acc.faceUpCards, card, num] },
      deck: rem,
      wasSymbol: true,
    };
  }

  if (card.operator === '×') {
    const snap = { ...basePlayer, faceUpCards: acc.faceUpCards, personalOperators: acc.personalOperators } as Player;
    return {
      kind: 'needs-decision',
      player: snap,
      deck: remaining,
      acc,
      resume: (d: MultiplicationDecision): DrawOneResult => {
        let ops = acc.personalOperators;
        let faceUp = acc.faceUpCards;
        let accepted = false;

        if (d.accept) {
          const idx = ops.findIndex((op) => op.operator === d.discard);
          if (idx !== -1) {
            ops = ops.filter((_, i) => i !== idx);
            faceUp = [...faceUp, card];
            accepted = true;
          }
        }

        const { card: num, remaining: rem } = drawNumberCard(remaining);
        return {
          kind: 'done',
          acc: { faceUpCards: [...faceUp, num], personalOperators: ops },
          deck: rem,
          wasSymbol: accepted,
        };
      },
    };
  }

  // Any other operator — replace with a number
  const { card: num, remaining: rem } = drawNumberCard(remaining);
  return { kind: 'done', acc: { ...acc, faceUpCards: [...acc.faceUpCards, num] }, deck: rem, wasSymbol: false };
}

// ─── Phase 1 step machine ─────────────────────────────────────────────────────

/**
 * Build the step machine for dealing phase 1 to all active players.
 * `playerIdx` is the index into `players[]` currently being processed;
 * `drawCount` tracks how many face-up draws the current player has had.
 */
function phase1Step(
  baseState: Dealing1State,
  players: Player[],
  deck: Card[],
  playerIdx: number,
  acc: CardAccumulator,
  drawCount: number,   // 0 = first draw, 1 = second draw
): DealStep<Betting1State> {
  // Skip folded players
  while (playerIdx < players.length && players[playerIdx]?.folded) {
    playerIdx++;
  }

  // All players dealt — transition to betting-1
  if (playerIdx >= players.length) {
    const finalState: Dealing1State & { players: DealtPlayer[] } = {
      ...baseState,
      players: players as DealtPlayer[],
      deck,
    };
    return { status: 'complete', state: initBettingRound(finalState, 'betting-1') };
  }

  const player = players[playerIdx]!;

  // When starting a new player (drawCount === 0), seed operators from the player's actual
  // personal operators so they carry through dealing and aren't lost.
  if (drawCount === 0) {
    acc = { faceUpCards: [], personalOperators: [...player.personalOperators] };
  }

  // This player already has 2 face-up draws — commit and move to next player
  if (drawCount >= 2) {
    const finishedPlayer: Player = {
      ...player,
      faceUpCards: acc.faceUpCards,
      personalOperators: acc.personalOperators,
    } as DealtPlayer;
    const updatedPlayers = players.map((p, i) => (i === playerIdx ? finishedPlayer : p));
    const intermediateState: Dealing1State = { ...baseState, players: updatedPlayers, deck };
    return phase1Step(intermediateState, updatedPlayers, deck, playerIdx + 1, { faceUpCards: [], personalOperators: [] }, 0);
  }

  const result = drawOneFaceUp(player, acc, deck);

  if (result.kind === 'needs-decision') {
    const snap = {
      ...baseState,
      players: players.map((p, i) =>
        i === playerIdx ? { ...p, faceUpCards: acc.faceUpCards, personalOperators: acc.personalOperators } as Player : p,
      ),
      deck: result.deck,
    };
    return {
      status: 'awaiting-decision',
      player: result.player,
      state: snap,
      resume: (d) => {
        const next = result.resume(d);
        if (next.kind !== 'done') throw new Error('Unexpected nested suspension');
        const newAcc = next.acc;
        const newDeck = next.deck;
        const wasSymbol = next.wasSymbol;
        // If first draw was a symbol, second draw must be a forced number
        if (drawCount === 0 && wasSymbol) {
          const { card: num, remaining } = drawNumberCard(newDeck);
          const finalAcc = { ...newAcc, faceUpCards: [...newAcc.faceUpCards, num] };
          return phase1Step(snap, players, remaining, playerIdx, finalAcc, 2);
        }
        return phase1Step(snap, players, newDeck, playerIdx, newAcc, drawCount + 1);
      },
    };
  }

  const { acc: newAcc, deck: newDeck, wasSymbol } = result;

  // If the first draw was a symbol, draw one forced extra number so the player
  // ends up with the same count of number cards as a non-symbol hand.
  // (Mirrors the explicit extra-draw in src/game.ts dealFaceUpCards, and the
  // identical logic in the needs-decision branch above for × cards.)
  if (drawCount === 0 && wasSymbol) {
    const { card: num, remaining } = drawNumberCard(newDeck);
    const finalAcc = { ...newAcc, faceUpCards: [...newAcc.faceUpCards, num] };
    return phase1Step(baseState, players, remaining, playerIdx, finalAcc, 2);
  }

  return phase1Step(baseState, players, newDeck, playerIdx, newAcc, drawCount + 1);
}

/**
 * Start dealing phase 1.  Returns the first step — either complete (no × cards
 * drawn) or awaiting a player decision.
 */
export function startDealPhase1(state: Dealing1State): DealStep<Betting1State> {
  const withSecrets = dealSecretCards(state);
  const initialAcc: CardAccumulator = { faceUpCards: [], personalOperators: [] };
  return phase1Step(withSecrets, [...withSecrets.players], [...withSecrets.deck], 0, initialAcc, 0);
}

// ─── Phase 2 step machine ─────────────────────────────────────────────────────

function phase2Step(
  baseState: Dealing2State,
  players: DealtPlayer[],
  deck: Card[],
  playerIdx: number,
): DealStep<CalculationState> {
  while (playerIdx < players.length && players[playerIdx]?.folded) {
    playerIdx++;
  }

  if (playerIdx >= players.length) {
    return { status: 'complete', state: { ...baseState, phase: 'calculation', players, deck } };
  }

  const player = players[playerIdx]!;
  const acc: CardAccumulator = { faceUpCards: [...player.faceUpCards], personalOperators: [...player.personalOperators] };
  const result = drawOneFaceUp(player, acc, deck);

  if (result.kind === 'needs-decision') {
    const snap: Dealing2State = {
      ...baseState,
      players,
      deck: result.deck,
    };
    return {
      status: 'awaiting-decision',
      player: result.player,
      state: snap,
      resume: (d) => {
        const next = result.resume(d);
        if (next.kind !== 'done') throw new Error('Unexpected nested suspension');
        const finished: DealtPlayer = { ...player, faceUpCards: next.acc.faceUpCards, personalOperators: next.acc.personalOperators };
        const updatedPlayers = players.map((p, i) => (i === playerIdx ? finished : p));
        return phase2Step({ ...baseState, players: updatedPlayers, deck: next.deck }, updatedPlayers, next.deck, playerIdx + 1);
      },
    };
  }

  const finished: DealtPlayer = { ...player, faceUpCards: result.acc.faceUpCards, personalOperators: result.acc.personalOperators };
  const updatedPlayers = players.map((p, i) => (i === playerIdx ? finished : p));
  return phase2Step({ ...baseState, players: updatedPlayers, deck: result.deck }, updatedPlayers, result.deck, playerIdx + 1);
}

export function startDealPhase2(state: Dealing2State): DealStep<CalculationState> {
  return phase2Step(state, [...state.players], [...state.deck], 0);
}
