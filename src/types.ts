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

/** Higher index = higher rank for High tie-breaking (Gold wins). */
export const SUIT_RANK_HIGH: Record<Suit, number> = {
  Black: 0,
  Bronze: 1,
  Silver: 2,
  Gold: 3,
};

/** Higher index = higher rank for Low tie-breaking (Black wins). */
export const SUIT_RANK_LOW: Record<Suit, number> = {
  Gold: 0,
  Silver: 1,
  Bronze: 2,
  Black: 3,
};

// ─── Player ───────────────────────────────────────────────────────────────────

export type BetChoice = 'high' | 'low' | 'swing';

export type Player = {
  id: string;
  name: string;
  chips: number;
  /** Personal operators kept for duration of game. Always includes ÷; may lose + or - if × acquired. */
  personalOperators: OperatorCard[];
  /** Face-down secret card; null before deal. */
  secretCard: NumberCard | null;
  /** Face-up cards visible to all. */
  faceUpCards: Card[];
  /** Chips bet in the current betting round (not cumulative across rounds). */
  currentBet: number;
  folded: boolean;
  /** Set during High/Low Bet phase. */
  betChoice: BetChoice | null;
  /** Equation string targeting 1 (used by low/swing). */
  lowEquation: string | null;
  /** Equation string targeting 20 (used by high/swing). */
  highEquation: string | null;
  lowResult: number | null;
  highResult: number | null;
};

// ─── Game phases ─────────────────────────────────────────────────────────────

export type GamePhase =
  | 'setup'
  | 'forced-bet'
  | 'dealing-1'
  | 'betting-1'
  | 'dealing-2'
  | 'calculation'
  | 'betting-2'
  | 'high-low-bet'
  | 'results';

// ─── Multiplication decision (during deal) ───────────────────────────────────

export type MultiplicationDecision =
  | { accept: true; discard: '+' | '-' }
  | { accept: false };

// ─── Game state ───────────────────────────────────────────────────────────────

export type GameState = {
  phase: GamePhase;
  players: Player[];
  deck: Card[];
  /** Total chips in the pot for the current round. */
  pot: number;
  /** The current highest bet that all active players must match. */
  currentBet: number;
  forcedBetAmount: number;
  /** Index into players[] whose turn it is during a betting round. */
  activePlayerIndex: number;
  /** Seconds allowed for the calculation phase. */
  calculationTimeLimit: number;
  round: number;
};

// ─── Results ─────────────────────────────────────────────────────────────────

export type RoundResult = {
  lowWinnerId: string | null;
  highWinnerId: string | null;
  /** Chips awarded per player this round. */
  payouts: Map<string, number>;
};
