import { buildDeck, buildPersonalOperators, shuffle, drawNumberCard } from './deck';
import {
  GameState, Player, DealtPlayer, UndealPlayer,
  MultiplicationDecision, Card, RoundResult,
  SetupState, ForcedBetState, Dealing1State, Dealing2State,
  Betting1State, Betting2State, BettingState,
  CalculationState, HighLowBetState, ResultsState, GameOverState,
} from './types';
import { resolveRound, applyPayouts } from './results';

// ─── Setup ────────────────────────────────────────────────────────────────────

export function createGame(
  playerNames: string[],
  startingChips = 50,
  calculationTimeLimit = 90,
): SetupState {
  if (playerNames.length < 2) throw new Error('At least 2 players required');

  const players: UndealPlayer[] = playerNames.map((name, i) => ({
    id: `player-${i}`,
    name,
    chips: startingChips,
    personalOperators: buildPersonalOperators(),
    currentBet: 0,
    folded: false,
    secretCard: null,
    faceUpCards: [],
  }));

  return {
    phase: 'setup',
    players,
    deck: shuffle(buildDeck()),
    pot: 0,
    forcedBetAmount: 1,
    calculationTimeLimit,
    round: 0,
    log: [],
    dealerIndex: players.length - 1,
    bettingLocked: false,
  };
}

// ─── Round initialisation ────────────────────────────────────────────────────

function advanceDealerIndex(players: { chips: number }[], current: number): number {
  const n = players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (current + i) % n;
    if ((players[idx]?.chips ?? 0) > 0) return idx;
  }
  return current;
}

function firstActiveAfterDealer(players: DealtPlayer[], dealerIndex: number): number {
  const n = players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (dealerIndex + i) % n;
    if (!players[idx]!.folded) return idx;
  }
  return 0;
}

/**
 * Start a new round from a SetupState (returned by `applyPayouts` or
 * `createGame`).  Players are already reset to UndealPlayer by `applyPayouts`;
 * this shuffles the deck, increments the round counter, advances the dealer,
 * and sets the forced bet equal to the new round number.
 *
 * Crucially, `pot` is NOT reset here — rollover chips from the previous round
 * (already set in SetupState by `applyPayouts`) carry into the new round.
 */
export function startRound(state: SetupState): ForcedBetState {
  const newRound = state.round + 1;
  return {
    ...state,
    phase: 'forced-bet',
    deck: shuffle(buildDeck()),
    round: newRound,
    log: [],
    dealerIndex: advanceDealerIndex(state.players, state.dealerIndex),
    forcedBetAmount: newRound,
    bettingLocked: false,
  };
}

// ─── Forced Bet ───────────────────────────────────────────────────────────────

export function collectForcedBets(state: ForcedBetState): Dealing1State {
  let pot = state.pot;
  const players: UndealPlayer[] = state.players.map((p) => {
    const bet = Math.min(p.chips, state.forcedBetAmount);
    pot += bet;
    return { ...p, chips: p.chips - bet, currentBet: bet };
  });
  const bettingLocked = players.some((p) => p.currentBet < state.forcedBetAmount);
  return { ...state, phase: 'dealing-1', players, pot, bettingLocked };
}

// ─── Dealing helpers ──────────────────────────────────────────────────────────

/** Deal the secret face-down number card to every non-folded player. */
export function dealSecretCards(state: Dealing1State): Dealing1State {
  let deck = [...state.deck];
  const players: Player[] = state.players.map((p) => {
    if (p.folded) return p;
    const result = drawNumberCard(deck);
    deck = result.remaining;
    // Transition UndealPlayer → partial DealtPlayer (faceUpCards still empty)
    const dealt: DealtPlayer = {
      id: p.id,
      name: p.name,
      chips: p.chips,
      personalOperators: p.personalOperators,
      currentBet: p.currentBet,
      folded: p.folded,
      secretCard: result.card,
      faceUpCards: [],
      betChoice: null,
      lowEquation: null,
      highEquation: null,
      lowResult: null,
      highResult: null,
    };
    return dealt;
  });
  return { ...state, players, deck };
}

// ─── Betting ──────────────────────────────────────────────────────────────────

export type BettingAction =
  | { type: 'raise'; amount: number }
  | { type: 'call' }
  | { type: 'check' }
  | { type: 'fold' };

export function applyBettingAction(
  state: BettingState,
  action: BettingAction,
): { state: BettingState; roundComplete: boolean } {
  const players = [...state.players];
  const idx = state.activePlayerIndex;
  const player = players[idx];
  if (!player) throw new Error(`No player at index ${idx}`);

  switch (action.type) {
    case 'raise': {
      if (state.bettingLocked) throw new Error('Betting is locked — a player went all-in on the forced bet');
      if (action.amount <= state.currentBet) throw new Error('Raise must exceed current bet');
      const extra = action.amount - player.currentBet;
      if (extra > player.chips) throw new Error('Not enough chips to raise');
      const minStack = Math.min(...state.players.filter((p) => !p.folded).map((p) => p.chips + p.currentBet));
      if (action.amount > minStack) throw new Error('Raise exceeds the minimum stack of active players');
      players[idx] = { ...player, chips: player.chips - extra, currentBet: action.amount };
      const nextState: BettingState = {
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
      const paid = Math.min(extra, player.chips);
      players[idx] = { ...player, chips: player.chips - paid, currentBet: player.currentBet + paid };
      const nextState: BettingState = {
        ...state,
        players,
        pot: state.pot + paid,
        activePlayerIndex: nextActiveIndex(players, idx),
        bettingActionsThisRound: state.bettingActionsThisRound + 1,
      };
      return { state: nextState, roundComplete: isBettingComplete(nextState) };
    }
    case 'check': {
      if (state.currentBet > player.currentBet) throw new Error('Cannot check — call or fold');
      const nextState: BettingState = {
        ...state,
        players,
        activePlayerIndex: nextActiveIndex(players, idx),
        bettingActionsThisRound: state.bettingActionsThisRound + 1,
      };
      return { state: nextState, roundComplete: isBettingComplete(nextState) };
    }
    case 'fold': {
      players[idx] = { ...player, folded: true };
      const nextState: BettingState = {
        ...state,
        players,
        activePlayerIndex: nextActiveIndex(players, idx),
        bettingActionsThisRound: state.bettingActionsThisRound + 1,
      };
      return { state: nextState, roundComplete: isBettingComplete(nextState) };
    }
  }
}

export function isBettingComplete(state: BettingState): boolean {
  const active = state.players.filter((p) => !p.folded);
  if (active.length <= 1) return true;
  if (state.bettingActionsThisRound < active.length) return false;
  return active.every((p) => p.currentBet === state.currentBet);
}

function nextActiveIndex(players: DealtPlayer[], currentIdx: number): number {
  const n = players.length;
  let i = (currentIdx + 1) % n;
  let iterations = 0;
  while (players[i]?.folded) {
    i = (i + 1) % n;
    if (++iterations > n) break;
  }
  return i;
}

// ─── Phase transitions ────────────────────────────────────────────────────────

/**
 * Advance past a completed betting round.
 *
 * - If only one player remains (all others folded), transitions directly to
 *   `results` with a `last-player-standing` result.
 * - Otherwise resets per-round bets and advances to `dealing-2` (after
 *   betting-1) or `high-low-bet` (after betting-2).
 */
export function advanceFromBetting(state: BettingState): Dealing2State | HighLowBetState | ResultsState {
  const active = state.players.filter((p) => !p.folded);

  if (active.length <= 1) {
    const winner = active[0];
    const result: RoundResult = winner
      ? { kind: 'last-player-standing', winnerId: winner.id, payout: state.pot }
      : { kind: 'contested', lowWinnerId: null, highWinnerId: null, payouts: { __rollover__: state.pot } };
    const { activePlayerIndex: _, currentBet: __, bettingActionsThisRound: ___, ...base } = state;
    return { ...base, phase: 'results', result } as ResultsState;
  }

  // Reset per-betting-round player bets and counters.
  const players = state.players.map((p) => ({ ...p, currentBet: 0 }));
  const firstActive = players.findIndex((p) => !p.folded);
  const { activePlayerIndex: _, currentBet: __, bettingActionsThisRound: ___, ...base } = state;

  if (state.phase === 'betting-1') {
    return { ...base, phase: 'dealing-2', players } satisfies Dealing2State;
  } else {
    return { ...base, phase: 'high-low-bet', players } satisfies HighLowBetState;
  }
}

/**
 * Advance from high-low-bet to results by computing the round outcome.
 */
export function advanceFromHighLowBet(state: HighLowBetState): ResultsState {
  const result = resolveRound(state);
  return { ...state, phase: 'results', result };
}

/**
 * Advance from results: apply payouts, then either start the next round
 * or end the game if only one player still has chips.
 */
export function advanceFromResults(state: ResultsState): ForcedBetState | GameOverState {
  const after = applyPayouts(state); // SetupState
  const { gameOver, winnerId } = checkGameOver(after);
  if (gameOver) {
    return { ...after, phase: 'game-over', winnerId: winnerId! };
  }
  return startRound(after);
}

// ─── High/Low Bet ─────────────────────────────────────────────────────────────

export function applyBetChoices(
  state: HighLowBetState,
  choices: Map<string, DealtPlayer['betChoice']>,
): HighLowBetState {
  const players: DealtPlayer[] = state.players.map((p) => ({
    ...p,
    betChoice: choices.get(p.id) ?? p.betChoice,
  }));
  return { ...state, players };
}

export function recordBetChoice(
  state: HighLowBetState,
  playerId: string,
  choice: 'high' | 'low' | 'swing',
): { state: HighLowBetState; allChosen: boolean } {
  const target = state.players.find((p) => p.id === playerId);
  if (target?.folded) throw new Error(`Folded player ${playerId} cannot make a high/low bet`);
  const players: DealtPlayer[] = state.players.map((p) =>
    p.id === playerId ? { ...p, betChoice: choice } : p,
  );
  const allChosen = players.filter((p) => !p.folded).every((p) => p.betChoice !== null);
  return { state: { ...state, players }, allChosen };
}

// ─── Game-over detection ──────────────────────────────────────────────────────

export function checkGameOver(state: SetupState): { gameOver: boolean; winnerId: string | null } {
  const solvent = state.players.filter((p) => p.chips > 0);
  if (solvent.length > 1) return { gameOver: false, winnerId: null };
  if (solvent.length === 1) return { gameOver: true, winnerId: solvent[0]!.id };
  const best = state.players.reduce<UndealPlayer | null>(
    (acc, p) => (acc === null || p.chips > acc.chips ? p : acc),
    null,
  );
  return { gameOver: true, winnerId: best?.id ?? null };
}

// ─── Equation results ─────────────────────────────────────────────────────────

export function recordEquationResults(
  state: CalculationState,
  playerId: string,
  lowResult: number | null,
  highResult: number | null,
  lowEquation: string | null,
  highEquation: string | null,
): CalculationState {
  const players: DealtPlayer[] = state.players.map((p) =>
    p.id === playerId ? { ...p, lowResult, highResult, lowEquation, highEquation } : p,
  );
  return { ...state, players };
}

// ─── Betting round reset (used by dealing.ts) ─────────────────────────────────

/**
 * Reset per-betting-round state when starting a new betting phase.
 * Used only by the dealing step machine (client/dealing.ts).
 */
export function initBettingRound(state: Dealing1State & { players: DealtPlayer[] }, phase: 'betting-1'): Betting1State;
export function initBettingRound(state: CalculationState, phase: 'betting-2'): Betting2State;
export function initBettingRound(
  state: (Dealing1State & { players: DealtPlayer[] }) | CalculationState,
  phase: 'betting-1' | 'betting-2',
): Betting1State | Betting2State {
  const players = state.players.map((p) => ({ ...p, currentBet: 0 }));
  return {
    ...state,
    phase,
    players,
    currentBet: 0,
    activePlayerIndex: firstActiveAfterDealer(players, state.dealerIndex),
    bettingActionsThisRound: 0,
  } as Betting1State | Betting2State;
}
