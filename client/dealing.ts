/**
 * dealing.ts — async dealing orchestration for the UI layer.
 *
 * The core dealing functions in src/game.ts are synchronous (pure).
 * This module wraps them with async/await so the UI can pause on × card
 * decisions and resume once the player has chosen.
 *
 * Uses only the low-level primitives from src/deck.ts and the
 * dealSecretCards helper from src/game.ts — no business-rule duplication.
 */

import { drawCard, drawNumberCard } from '../src/deck';
import { dealSecretCards, resetBettingRound } from '../src/game';
import type { GameState, Player, Card, MultiplicationDecision } from '../src/types';

// ─── Single-player face-up deal (2 cards) ────────────────────────────────────

async function dealFaceUpCardsAsync(
  player: Player,
  deck: Card[],
  requestDecision: (player: Player) => Promise<MultiplicationDecision>,
): Promise<{ player: Player; deck: Card[] }> {
  let currentDeck = [...deck];
  const faceUpCards: Card[] = [...player.faceUpCards];
  const personalOperators = [...player.personalOperators];

  /** Draw one face-up card, apply √/× rules. Returns true if a symbol card was placed. */
  const drawOne = async (): Promise<boolean> => {
    const { card, remaining } = drawCard(currentDeck);
    currentDeck = remaining;

    if (card.kind === 'number') {
      faceUpCards.push(card);
      return false;
    }

    if (card.operator === '√') {
      faceUpCards.push(card);
      const { card: num, remaining: rem } = drawNumberCard(currentDeck);
      currentDeck = rem;
      faceUpCards.push(num);
      return true;
    }

    if (card.operator === '×') {
      const snap: Player = { ...player, faceUpCards: [...faceUpCards], personalOperators: [...personalOperators] };
      const decision = await requestDecision(snap);
      if (decision.accept) {
        const idx = personalOperators.findIndex((op) => op.operator === decision.discard);
        if (idx !== -1) personalOperators.splice(idx, 1);
        faceUpCards.push(card);
      }
      // Player always receives an additional number card regardless of decision
      const { card: num, remaining: rem } = drawNumberCard(currentDeck);
      currentDeck = rem;
      faceUpCards.push(num);
      return decision.accept;
    }

    // Any other operator — replace with a number
    const { card: num, remaining: rem } = drawNumberCard(currentDeck);
    currentDeck = rem;
    faceUpCards.push(num);
    return false;
  };

  const firstWasSymbol = await drawOne();

  if (firstWasSymbol) {
    // Rule: if both drawn cards are symbols, second must be a number
    const { card: num, remaining: rem } = drawNumberCard(currentDeck);
    currentDeck = rem;
    faceUpCards.push(num);
  } else {
    await drawOne();
  }

  return { player: { ...player, faceUpCards, personalOperators }, deck: currentDeck };
}

// ─── Single-player one-card deal (phase 2) ───────────────────────────────────

async function dealOneMoreAsync(
  player: Player,
  deck: Card[],
  requestDecision: (player: Player) => Promise<MultiplicationDecision>,
): Promise<{ player: Player; deck: Card[] }> {
  let currentDeck = [...deck];
  const faceUpCards: Card[] = [...player.faceUpCards];
  const personalOperators = [...player.personalOperators];

  const { card, remaining } = drawCard(currentDeck);
  currentDeck = remaining;

  if (card.kind === 'number') {
    faceUpCards.push(card);
  } else if (card.operator === '√') {
    faceUpCards.push(card);
    const { card: num, remaining: rem } = drawNumberCard(currentDeck);
    currentDeck = rem;
    faceUpCards.push(num);
  } else if (card.operator === '×') {
    const snap: Player = { ...player, faceUpCards: [...faceUpCards], personalOperators: [...personalOperators] };
    const decision = await requestDecision(snap);
    if (decision.accept) {
      const idx = personalOperators.findIndex((op) => op.operator === decision.discard);
      if (idx !== -1) personalOperators.splice(idx, 1);
      faceUpCards.push(card);
    }
    const { card: num, remaining: rem } = drawNumberCard(currentDeck);
    currentDeck = rem;
    faceUpCards.push(num);
  } else {
    const { card: num, remaining: rem } = drawNumberCard(currentDeck);
    currentDeck = rem;
    faceUpCards.push(num);
  }

  return { player: { ...player, faceUpCards, personalOperators }, deck: currentDeck };
}

// ─── Full phase runners ───────────────────────────────────────────────────────

/**
 * Dealing Phase 1: deal secret card + 2 face-up cards to each active player.
 * Calls `onUpdate` after each player is dealt so the UI updates live.
 * Returns state with phase='betting-1' and a fresh betting round counter.
 */
export async function runDealPhase1Async(
  state: GameState,
  requestDecision: (player: Player) => Promise<MultiplicationDecision>,
  onUpdate: (s: GameState) => void,
): Promise<GameState> {
  const withSecrets = dealSecretCards(state);
  let deck = [...withSecrets.deck];
  const players: Player[] = [...withSecrets.players];

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || p.folded) continue;
    const result = await dealFaceUpCardsAsync(p, deck, requestDecision);
    players[i] = result.player;
    deck = result.deck;
    onUpdate({ ...withSecrets, players: [...players], deck });
  }

  // Reset bets so betting-1 starts from 0 (forced bet money is already in pot)
  return resetBettingRound({ ...withSecrets, players, deck }, 'betting-1');
}

/**
 * Dealing Phase 2: deal one additional face-up card to each active player.
 * Returns state with phase='calculation'.
 */
export async function runDealPhase2Async(
  state: GameState,
  requestDecision: (player: Player) => Promise<MultiplicationDecision>,
  onUpdate: (s: GameState) => void,
): Promise<GameState> {
  let deck = [...state.deck];
  const players: Player[] = [...state.players];

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    if (!p || p.folded) continue;
    const result = await dealOneMoreAsync(p, deck, requestDecision);
    players[i] = result.player;
    deck = result.deck;
    onUpdate({ ...state, players: [...players], deck });
  }

  return { ...state, phase: 'calculation', players, deck };
}
