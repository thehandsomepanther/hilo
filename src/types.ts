// ─── Cards ───────────────────────────────────────────────────────────────────

export type Suit = 'Gold' | 'Silver' | 'Bronze' | 'Black';

export type NumberCard = {
  kind: 'number';
  value: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  suit: Suit;
};

export type Operator = '+' | '-' | '÷' | '×' | '√';

export type OperatorCard = {
  kind: 'operator';
  operator: Operator;
};

export type Card = NumberCard | OperatorCard;

// ─── Suit ordering ───────────────────────────────────────────────────────────

/** Higher index = higher rank for High (20) tie-breaking. Gold wins. */
export const SUIT_RANK_HIGH: Record<Suit, number> = {
  Black: 0, Bronze: 1, Silver: 2, Gold: 3,
};

/** Higher index = higher rank for Low (1) tie-breaking. Black wins. */
export const SUIT_RANK_LOW: Record<Suit, number> = {
  Gold: 0, Silver: 1, Bronze: 2, Black: 3,
};

// ─── Players ─────────────────────────────────────────────────────────────────

export type BetChoice = 'high' | 'low' | 'swing';

type BasePlayer = {
  id: string;
  name: string;
  chips: number;
  personalOperators: OperatorCard[];
  /** Chips bet in the current betting round; 0 between rounds. */
  currentBet: number;
  folded: boolean;
};

/** Player before any cards have been dealt this round. */
export type UndealPlayer = BasePlayer & {
  secretCard: null;
  faceUpCards: [];
};

/**
 * Player after dealing phase 1 — holds cards, may have equations and a bet
 * choice. `secretCard` is guaranteed non-null; downstream code never needs to
 * null-check it.
 */
export type DealtPlayer = BasePlayer & {
  secretCard: NumberCard;
  faceUpCards: Card[];
  betChoice: BetChoice | null;
  lowEquation: string | null;
  highEquation: string | null;
  lowResult: number | null;
  highResult: number | null;
};

/**
 * Union of both player states.  Used in `Dealing1State` where players
 * transition from UndealPlayer to DealtPlayer progressively.
 */
export type Player = UndealPlayer | DealtPlayer;

// ─── Round result ─────────────────────────────────────────────────────────────

/**
 * Outcome of a completed round.
 *
 * `last-player-standing`: all others folded; sole survivor takes the whole pot.
 *
 * `contested`: pot split between closest-to-1 and closest-to-20 results.
 *   `payouts` maps playerId → chips won.  The special key `'__rollover__'`
 *   holds chips with no valid winner that carry into the next round's pot.
 *   Uses a plain object (not Map) so it survives JSON serialization.
 */
export type RoundResult =
  | { kind: 'last-player-standing'; winnerId: string; payout: number }
  | {
      kind: 'contested';
      lowWinnerId: string | null;
      highWinnerId: string | null;
      payouts: Record<string, number>;
    };

// ─── Multiplication decision ──────────────────────────────────────────────────

export type MultiplicationDecision =
  | { accept: true; discard: '+' | '-' }
  | { accept: false };

// ─── Game state ───────────────────────────────────────────────────────────────

/**
 * Fields present in every phase.  Phase-specific types extend this.
 * `calculationTimeLimit` is configuration that never changes mid-game;
 * it lives here so the Calculation component can read it from state.
 */
type BaseState = {
  deck: Card[];
  pot: number;
  forcedBetAmount: number;
  calculationTimeLimit: number;
  round: number;
  log: string[];
  /** Index of the current dealer; first to act is the player after this index. */
  dealerIndex: number;
  /**
   * True when a player went all-in on the forced bet this round.
   * Raises are forbidden while this is set; players may only call or fold.
   */
  bettingLocked: boolean;
  /**
   * When true, players who fail to submit an equation before the time limit
   * are banned from betting on that pot.  Players with no equations are folded.
   */
  enforceTimeLimit: boolean;
};

// Phases share player-array types according to what has been dealt:
type PreDealState  = BaseState & { players: UndealPlayer[] };
type DealingState  = BaseState & { players: Player[] };    // mixed during dealing-1
type PostDealState = BaseState & { players: DealtPlayer[] };

// ── Phase-specific state types ────────────────────────────────────────────────

export type SetupState       = PreDealState  & { phase: 'setup' };
export type ForcedBetState   = PreDealState  & { phase: 'forced-bet' };

/** Intermediate phase while cards are being dealt; players array is mixed. */
export type Dealing1State    = DealingState  & { phase: 'dealing-1' };
export type Dealing2State    = PostDealState & { phase: 'dealing-2' };

export type Betting1State    = PostDealState & {
  phase: 'betting-1';
  activePlayerIndex: number;
  currentBet: number;
  bettingActionsThisRound: number;
};
export type Betting2State    = PostDealState & {
  phase: 'betting-2';
  activePlayerIndex: number;
  currentBet: number;
  bettingActionsThisRound: number;
};

export type CalculationState = PostDealState & { phase: 'calculation' };
export type HighLowBetState  = PostDealState & { phase: 'high-low-bet' };

/** Results phase embeds the round result — no separate store needed. */
export type ResultsState     = PostDealState & { phase: 'results'; result: RoundResult };

/** Game-over occurs after payouts; players are reset (UndealPlayer). */
export type GameOverState    = PreDealState  & { phase: 'game-over'; winnerId: string };

// ── Convenience union types ───────────────────────────────────────────────────

export type BettingState = Betting1State | Betting2State;

export type GameState =
  | SetupState
  | ForcedBetState
  | Dealing1State
  | Dealing2State
  | Betting1State
  | Betting2State
  | CalculationState
  | HighLowBetState
  | ResultsState
  | GameOverState;
