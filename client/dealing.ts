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

// ─── Phase 1 step machine (round-robin) ──────────────────────────────────────
//
// Cards are dealt in two passes so each player receives one card before anyone
// receives their second:
//
//   Pass 1: player 0 draws, player 1 draws, player 2 draws, …
//   Pass 2: player 0 draws (if needed), player 1 draws (if needed), …
//
// A symbol draw (√ or accepted ×) on the first draw consumes both draw slots —
// that player gets an extra forced number and is skipped in pass 2.  Non-symbol
// draws leave the player needing a second draw; their index is recorded in
// `needPass2` and processed after all players have completed pass 1.

/**
 * Pass 1 — deal the first face-up card to each active player in turn.
 * `needPass2` accumulates indices of players who drew a plain card and still
 * need a second draw.
 */
function phase1Pass1Step(
  baseState: Dealing1State,
  players: Player[],
  deck: Card[],
  playerIdx: number,
  needPass2: number[],
): DealStep<Betting1State> {
  while (playerIdx < players.length && players[playerIdx]?.folded) {
    playerIdx++;
  }

  if (playerIdx >= players.length) {
    return phase1Pass2Step(baseState, players, deck, needPass2);
  }

  const player = players[playerIdx]!;
  const acc: CardAccumulator = { faceUpCards: [], personalOperators: [...player.personalOperators] };
  const result = drawOneFaceUp(player, acc, deck);

  if (result.kind === 'needs-decision') {
    const snap: Dealing1State = {
      ...baseState,
      players: players.map((p, i) =>
        i === playerIdx ? { ...p, faceUpCards: [], personalOperators: acc.personalOperators } as Player : p,
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
        if (next.wasSymbol) {
          // Accepted × on first draw — draw forced extra number, player is done
          const { card: num, remaining } = drawNumberCard(next.deck);
          const committed = { ...player, faceUpCards: [...next.acc.faceUpCards, num], personalOperators: next.acc.personalOperators } as DealtPlayer;
          const updated = players.map((p, i) => (i === playerIdx ? committed : p));
          return phase1Pass1Step({ ...snap, players: updated, deck: remaining }, updated, remaining, playerIdx + 1, needPass2);
        } else {
          // Declined × on first draw — 1 card, needs second draw
          const partial = { ...player, faceUpCards: next.acc.faceUpCards, personalOperators: next.acc.personalOperators } as DealtPlayer;
          const updated = players.map((p, i) => (i === playerIdx ? partial : p));
          return phase1Pass1Step({ ...snap, players: updated, deck: next.deck }, updated, next.deck, playerIdx + 1, [...needPass2, playerIdx]);
        }
      },
    };
  }

  const { acc: newAcc, deck: newDeck, wasSymbol } = result;

  if (wasSymbol) {
    // √ (or accepted ×) on first draw — draw forced extra number, player is done
    const { card: num, remaining } = drawNumberCard(newDeck);
    const committed = { ...player, faceUpCards: [...newAcc.faceUpCards, num], personalOperators: newAcc.personalOperators } as DealtPlayer;
    const updated = players.map((p, i) => (i === playerIdx ? committed : p));
    return phase1Pass1Step({ ...baseState, players: updated, deck: remaining }, updated, remaining, playerIdx + 1, needPass2);
  } else {
    // Plain number on first draw — partial commit, needs second draw
    const partial = { ...player, faceUpCards: newAcc.faceUpCards, personalOperators: newAcc.personalOperators } as DealtPlayer;
    const updated = players.map((p, i) => (i === playerIdx ? partial : p));
    return phase1Pass1Step({ ...baseState, players: updated, deck: newDeck }, updated, newDeck, playerIdx + 1, [...needPass2, playerIdx]);
  }
}

/**
 * Pass 2 — deal the second face-up card to each player in `pass2Queue`.
 * These are the players who received a plain number card in pass 1.
 */
function phase1Pass2Step(
  baseState: Dealing1State,
  players: Player[],
  deck: Card[],
  pass2Queue: number[],
): DealStep<Betting1State> {
  if (pass2Queue.length === 0) {
    const finalState: Dealing1State & { players: DealtPlayer[] } = {
      ...baseState,
      players: players as DealtPlayer[],
      deck,
    };
    return { status: 'complete', state: initBettingRound(finalState, 'betting-1') };
  }

  const [playerIdx, ...restQueue] = pass2Queue as [number, ...number[]];
  const player = players[playerIdx]!;
  // Build acc from the player's partial state committed in pass 1 (1 face-up card)
  const acc: CardAccumulator = { faceUpCards: [...(player as DealtPlayer).faceUpCards], personalOperators: [...player.personalOperators] };
  const result = drawOneFaceUp(player, acc, deck);

  if (result.kind === 'needs-decision') {
    const snap: Dealing1State = { ...baseState, players, deck: result.deck };
    return {
      status: 'awaiting-decision',
      player: result.player,
      state: snap,
      resume: (d) => {
        const next = result.resume(d);
        if (next.kind !== 'done') throw new Error('Unexpected nested suspension');
        // Second draw: no extra-number forced regardless of wasSymbol
        const committed = { ...player, faceUpCards: next.acc.faceUpCards, personalOperators: next.acc.personalOperators } as DealtPlayer;
        const updated = players.map((p, i) => (i === playerIdx ? committed : p));
        return phase1Pass2Step({ ...snap, players: updated, deck: next.deck }, updated, next.deck, restQueue);
      },
    };
  }

  const committed = { ...player, faceUpCards: result.acc.faceUpCards, personalOperators: result.acc.personalOperators } as DealtPlayer;
  const updated = players.map((p, i) => (i === playerIdx ? committed : p));
  return phase1Pass2Step({ ...baseState, players: updated, deck: result.deck }, updated, result.deck, restQueue);
}

/**
 * Start dealing phase 1.  Returns the first step — either complete (no × cards
 * drawn) or awaiting a player decision.
 */
export function startDealPhase1(state: Dealing1State): DealStep<Betting1State> {
  const withSecrets = dealSecretCards(state);
  return phase1Pass1Step(withSecrets, [...withSecrets.players], [...withSecrets.deck], 0, []);
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
