import { buildDeck, buildPersonalOperators, shuffle, drawCard, drawNumberCard } from './deck';
import { GameState, Player, MultiplicationDecision, Card } from './types';

// ─── Setup ────────────────────────────────────────────────────────────────────

export function createGame(
  playerNames: string[],
  startingChips = 50,
  forcedBetAmount = 1,
  calculationTimeLimit = 90,
): GameState {
  if (playerNames.length < 2) throw new Error('At least 2 players required');

  const players: Player[] = playerNames.map((name, i) => ({
    id: `player-${i}`,
    name,
    chips: startingChips,
    personalOperators: buildPersonalOperators(),
    secretCard: null,
    faceUpCards: [],
    currentBet: 0,
    folded: false,
    betChoice: null,
    lowEquation: null,
    highEquation: null,
    lowResult: null,
    highResult: null,
  }));

  return {
    phase: 'setup',
    players,
    deck: shuffle(buildDeck()),
    pot: 0,
    currentBet: 0,
    forcedBetAmount,
    activePlayerIndex: 0,
    calculationTimeLimit,
    round: 0,
    bettingActionsThisRound: 0,
  };
}

// ─── Round initialisation ────────────────────────────────────────────────────

/** Reset per-round player fields and re-shuffle a fresh deck. */
export function startRound(state: GameState): GameState {
  const players: Player[] = state.players.map((p) => ({
    ...p,
    personalOperators: buildPersonalOperators(),
    secretCard: null,
    faceUpCards: [],
    currentBet: 0,
    folded: false,
    betChoice: null,
    lowEquation: null,
    highEquation: null,
    lowResult: null,
    highResult: null,
  }));

  return {
    ...state,
    phase: 'forced-bet',
    players,
    deck: shuffle(buildDeck()),
    pot: 0,
    currentBet: 0,
    round: state.round + 1,
    bettingActionsThisRound: 0,
  };
}

// ─── Forced Bet ──────────────────────────────────────────────────────────────

/**
 * Collect the forced bet from all players.
 * Players with fewer chips than the forced amount go all-in.
 */
export function collectForcedBets(state: GameState): GameState {
  let pot = state.pot;
  const players: Player[] = state.players.map((p) => {
    const bet = Math.min(p.chips, state.forcedBetAmount);
    pot += bet;
    return { ...p, chips: p.chips - bet, currentBet: bet };
  });

  return { ...state, phase: 'dealing-1', players, pot, currentBet: state.forcedBetAmount };
}

// ─── Dealing helpers ──────────────────────────────────────────────────────────

/**
 * Deal the secret (face-down) number card to every active player.
 * Non-number draws are discarded and re-drawn.
 */
export function dealSecretCards(state: GameState): GameState {
  let deck = [...state.deck];
  const players: Player[] = state.players.map((p) => {
    if (p.folded) return p;
    const result = drawNumberCard(deck);
    deck = result.remaining;
    return { ...p, secretCard: result.card };
  });
  return { ...state, players, deck };
}

/**
 * Deal two face-up cards to a single player, applying √/× rules.
 *
 * For × cards the caller supplies a `getMultiplicationDecision` callback so
 * the UI/engine layer can request the player's choice and pass it in.
 * This function is pure — all side-effects are in the callback.
 *
 * Returns the updated player and the remaining deck.
 */
export function dealFaceUpCards(
  player: Player,
  deck: Card[],
  getMultiplicationDecision: (player: Player, deck: Card[]) => MultiplicationDecision,
): { player: Player; deck: Card[] } {
  let currentDeck = [...deck];
  const faceUpCards: Card[] = [...player.faceUpCards];
  const personalOperators = [...player.personalOperators];

  /**
   * Draw one face-up card and apply special rules.
   * Returns true if a symbol card was placed (√ or accepted ×).
   */
  const drawOne = (): boolean => {
    const { card, remaining } = drawCard(currentDeck);
    currentDeck = remaining;

    if (card.kind === 'number') {
      faceUpCards.push(card);
      return false;
    }

    // √ card
    if (card.operator === '√') {
      faceUpCards.push(card);
      // Always accompanied by an additional number card
      const numResult = drawNumberCard(currentDeck);
      currentDeck = numResult.remaining;
      faceUpCards.push(numResult.card);
      return true;
    }

    // × card
    if (card.operator === '×') {
      const currentPlayer: Player = { ...player, faceUpCards: [...faceUpCards], personalOperators: [...personalOperators] };
      const decision = getMultiplicationDecision(currentPlayer, currentDeck);

      if (decision.accept) {
        const idx = personalOperators.findIndex((op) => op.operator === decision.discard);
        if (idx === -1) throw new Error(`Operator ${decision.discard} not found in hand`);
        personalOperators.splice(idx, 1);
        faceUpCards.push(card);
      }
      // Whether accepted or declined, player always gets an additional number card
      const numResult = drawNumberCard(currentDeck);
      currentDeck = numResult.remaining;
      faceUpCards.push(numResult.card);
      return decision.accept;
    }

    // Any other operator card in the face-up draw is treated as a number draw
    // (shouldn't occur with standard deck, but defensively skip it)
    const numResult = drawNumberCard(currentDeck);
    currentDeck = numResult.remaining;
    faceUpCards.push(numResult.card);
    return false;
  };

  // First face-up draw
  const firstWasSymbol = drawOne();

  // Second face-up draw: if first was a symbol, must force a number
  if (firstWasSymbol) {
    const numResult = drawNumberCard(currentDeck);
    currentDeck = numResult.remaining;
    faceUpCards.push(numResult.card);
  } else {
    drawOne();
  }

  return {
    player: { ...player, faceUpCards, personalOperators },
    deck: currentDeck,
  };
}

/**
 * Deal one additional face-up card per active player (Dealing Phase 2),
 * following the same √/× rules.
 */
export function dealOneMoreFaceUp(
  player: Player,
  deck: Card[],
  getMultiplicationDecision: (player: Player, deck: Card[]) => MultiplicationDecision,
): { player: Player; deck: Card[] } {
  let currentDeck = [...deck];
  const faceUpCards: Card[] = [...player.faceUpCards];
  const personalOperators = [...player.personalOperators];

  const { card, remaining } = drawCard(currentDeck);
  currentDeck = remaining;

  if (card.kind === 'number') {
    faceUpCards.push(card);
  } else if (card.operator === '√') {
    faceUpCards.push(card);
    const numResult = drawNumberCard(currentDeck);
    currentDeck = numResult.remaining;
    faceUpCards.push(numResult.card);
  } else if (card.operator === '×') {
    const currentPlayer: Player = { ...player, faceUpCards: [...faceUpCards], personalOperators: [...personalOperators] };
    const decision = getMultiplicationDecision(currentPlayer, currentDeck);
    if (decision.accept) {
      const idx = personalOperators.findIndex((op) => op.operator === decision.discard);
      if (idx === -1) throw new Error(`Operator ${decision.discard} not found in hand`);
      personalOperators.splice(idx, 1);
      faceUpCards.push(card);
    }
    const numResult = drawNumberCard(currentDeck);
    currentDeck = numResult.remaining;
    faceUpCards.push(numResult.card);
  } else {
    // Other operator — replace with a number
    const numResult = drawNumberCard(currentDeck);
    currentDeck = numResult.remaining;
    faceUpCards.push(numResult.card);
  }

  return {
    player: { ...player, faceUpCards, personalOperators },
    deck: currentDeck,
  };
}

/**
 * Run Dealing Phase 1 for all active players.
 * Deals 1 secret card + 2 face-up cards each.
 */
export function runDealingPhase1(
  state: GameState,
  getMultiplicationDecision: (player: Player, deck: Card[]) => MultiplicationDecision,
): GameState {
  let s = dealSecretCards(state);
  let deck = [...s.deck];
  const players: Player[] = s.players.map((p) => {
    if (p.folded) return p;
    const result = dealFaceUpCards(p, deck, getMultiplicationDecision);
    deck = result.deck;
    return result.player;
  });
  return { ...s, phase: 'betting-1', players, deck };
}

/**
 * Run Dealing Phase 2 for all active players.
 * Deals 1 additional face-up card each.
 */
export function runDealingPhase2(
  state: GameState,
  getMultiplicationDecision: (player: Player, deck: Card[]) => MultiplicationDecision,
): GameState {
  let deck = [...state.deck];
  const players: Player[] = state.players.map((p) => {
    if (p.folded) return p;
    const result = dealOneMoreFaceUp(p, deck, getMultiplicationDecision);
    deck = result.deck;
    return result.player;
  });
  return { ...state, phase: 'calculation', players, deck };
}

// ─── Betting ──────────────────────────────────────────────────────────────────

export type BettingAction =
  | { type: 'raise'; amount: number }
  | { type: 'call' }
  | { type: 'check' }
  | { type: 'fold' };

/**
 * Apply a single betting action for the active player.
 * Returns updated state and whether the betting round is complete.
 */
export function applyBettingAction(
  state: GameState,
  action: BettingAction,
): { state: GameState; roundComplete: boolean } {
  const players: Player[] = [...state.players];
  const idx = state.activePlayerIndex;
  const player = players[idx];
  if (!player) throw new Error(`No player at index ${idx}`);

  switch (action.type) {
    case 'raise': {
      if (action.amount <= state.currentBet) {
        throw new Error('Raise amount must exceed current bet');
      }
      const extra = action.amount - player.currentBet;
      if (extra > player.chips) throw new Error('Not enough chips to raise');
      const updated: Player = {
        ...player,
        chips: player.chips - extra,
        currentBet: action.amount,
      };
      players[idx] = updated;
      const nextState: GameState = {
        ...state,
        players,
        pot: state.pot + extra,
        currentBet: action.amount,
        activePlayerIndex: nextActiveIndex(players, idx),
        bettingActionsThisRound: state.bettingActionsThisRound + 1,
      };
      return { state: nextState, roundComplete: isBettingComplete(nextState) };
    }

    case 'call': {
      const extra = state.currentBet - player.currentBet;
      const paid = Math.min(extra, player.chips); // allow all-in
      const updated: Player = {
        ...player,
        chips: player.chips - paid,
        currentBet: player.currentBet + paid,
      };
      players[idx] = updated;
      const nextState: GameState = {
        ...state,
        players,
        pot: state.pot + paid,
        activePlayerIndex: nextActiveIndex(players, idx),
        bettingActionsThisRound: state.bettingActionsThisRound + 1,
      };
      return { state: nextState, roundComplete: isBettingComplete(nextState) };
    }

    case 'check': {
      if (state.currentBet > player.currentBet) {
        throw new Error('Cannot check when there is an outstanding bet — call or fold');
      }
      const nextState: GameState = {
        ...state,
        players,
        activePlayerIndex: nextActiveIndex(players, idx),
        bettingActionsThisRound: state.bettingActionsThisRound + 1,
      };
      return { state: nextState, roundComplete: isBettingComplete(nextState) };
    }

    case 'fold': {
      const updated: Player = { ...player, folded: true };
      players[idx] = updated;
      const nextState: GameState = {
        ...state,
        players,
        activePlayerIndex: nextActiveIndex(players, idx),
        bettingActionsThisRound: state.bettingActionsThisRound + 1,
      };
      const activePlayers = nextState.players.filter((p) => !p.folded);
      if (activePlayers.length === 1) {
        return { state: nextState, roundComplete: true };
      }
      return { state: nextState, roundComplete: isBettingComplete(nextState) };
    }
  }
}

/**
 * Returns true when all active (non-folded) players have matched the current
 * bet AND every active player has taken at least one action this round.
 * The second condition prevents the round from ending before anyone acts
 * (e.g. right after a resetBettingRound where all bets are 0).
 */
export function isBettingComplete(state: GameState): boolean {
  const active = state.players.filter((p) => !p.folded);
  if (active.length <= 1) return true;
  if (state.bettingActionsThisRound < active.length) return false;
  return active.every((p) => p.currentBet === state.currentBet);
}

/** Index of the next non-folded player after `currentIdx`. */
function nextActiveIndex(players: Player[], currentIdx: number): number {
  const n = players.length;
  let i = (currentIdx + 1) % n;
  let iterations = 0;
  while (players[i]?.folded) {
    i = (i + 1) % n;
    if (++iterations > n) break; // safety — shouldn't happen
  }
  return i;
}

/**
 * Reset per-betting-round `currentBet` fields before starting a new betting
 * round (the pot accumulates across rounds; only the per-player bet resets).
 */
export function resetBettingRound(state: GameState, nextPhase: GameState['phase']): GameState {
  const players: Player[] = state.players.map((p) => ({ ...p, currentBet: 0 }));
  return { ...state, phase: nextPhase, players, currentBet: 0, bettingActionsThisRound: 0 };
}

// ─── High/Low Bet ─────────────────────────────────────────────────────────────

/** Apply all players' bet choices simultaneously and advance to results. */
export function applyBetChoices(
  state: GameState,
  choices: Map<string, Player['betChoice']>,
): GameState {
  const players: Player[] = state.players.map((p) => ({
    ...p,
    betChoice: choices.get(p.id) ?? p.betChoice,
  }));
  return { ...state, phase: 'results', players };
}

/** Store computed equation results for a player. */
export function recordEquationResults(
  state: GameState,
  playerId: string,
  lowResult: number | null,
  highResult: number | null,
  lowEquation: string | null,
  highEquation: string | null,
): GameState {
  const players: Player[] = state.players.map((p) =>
    p.id === playerId
      ? { ...p, lowResult, highResult, lowEquation, highEquation }
      : p,
  );
  return { ...state, players };
}
