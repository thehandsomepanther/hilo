# Equation Hi-Lo — TypeScript Implementation Spec

## Overview

Equation Hi-Lo is a multiplayer card game combining poker-style betting with mental arithmetic. Players are dealt number and operator cards, construct equations targeting 1 (Low) or 20 (High), and bet on the strength of their result. The pot is always split 50/50 between the closest-to-1 and closest-to-20 results.

---

## Data Model

### Card Types

```ts
type Suit = 'Gold' | 'Silver' | 'Bronze' | 'Black';

type NumberCard = {
  kind: 'number';
  value: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  suit: Suit;
};

type OperatorCard = {
  kind: 'operator';
  operator: '+' | '-' | '÷' | '×' | '√';
};

type Card = NumberCard | OperatorCard;
```

### Deck Composition

The main deck contains 52 cards:
- 44 number cards: values 0–10 in each of four suits (Gold, Silver, Bronze, Black)
- 4 Multiplication `[×]` operator cards
- 4 Square Root `[√]` operator cards

Each player also receives (and keeps for the whole game) 3 personal operator cards:
- 1 Addition `[+]`
- 1 Subtraction `[-]`
- 1 Division `[÷]`

### Player State

```ts
type BetChoice = 'high' | 'low' | 'swing';

type Player = {
  id: string;
  name: string;
  chips: number;
  personalOperators: OperatorCard[]; // always [+, -, ÷]; may lose + or - if × acquired
  secretCard: NumberCard | null;     // face-down; only visible to owner
  faceUpCards: Card[];               // visible to all
  currentBet: number;
  folded: boolean;
  betChoice: BetChoice | null;
  lowEquation: string | null;        // equation string submitted for target 1
  highEquation: string | null;       // equation string submitted for target 20
  lowResult: number | null;
  highResult: number | null;
};
```

### Game State

```ts
type GamePhase =
  | 'setup'
  | 'forced-bet'
  | 'dealing-1'
  | 'betting-1'
  | 'dealing-2'
  | 'calculation'
  | 'betting-2'
  | 'high-low-bet'
  | 'results';

type GameState = {
  phase: GamePhase;
  players: Player[];
  deck: Card[];
  pot: number;
  currentBet: number;       // highest bet in current betting round
  forcedBetAmount: number;
  activePlayerIndex: number;
  calculationTimeLimit: number; // seconds, default 90
  round: number;
};
```

---

## Deck & Shuffle

- `buildDeck(): Card[]` — construct the 52-card main deck
- `shuffle(deck: Card[]): Card[]` — Fisher-Yates shuffle, returns new array
- `drawCard(deck: Card[]): { card: Card; remaining: Card[] }` — draw top card
- `drawNumberCard(deck: Card[]): { card: NumberCard; remaining: Card[] }` — draw, discarding and reshuffling non-number cards until a number card is found

---

## Phase Logic

### Setup

1. Build and shuffle the main deck.
2. For each player, assign personal operator cards `[+, -, ÷]`.
3. Assign 1 and 20 tokens to each player.
4. Distribute starting chip count evenly.

### Forced Bet

- Each player pays `forcedBetAmount` chips into the pot.
- `forcedBetAmount` starts at 1 and may be increased between rounds.

### Dealing Phase 1

Deal cards to each player in this order:

1. **Secret card (face-down):** Draw one card. If it is not a `NumberCard`, return it, reshuffle, and draw again. The player can see their own secret card; others cannot.

2. **Two face-up cards:** Draw cards one at a time for each player:
   - If a `√` card is drawn: keep it face-up, then also draw an additional number card face-up.
   - If a `×` card is drawn: offer the player a choice —
     - Discard their `[+]` card and keep `[×]`, **or**
     - Discard their `[-]` card and keep `[×]`, **or**
     - Decline the `[×]` card (it goes to discard).
     - In all three cases, the player also receives one additional number card face-up. The `[÷]` card can never be discarded.
   - If both of the two face-up cards drawn are operator cards, the second must be returned and replaced with a number card.

3. Continue until all players have at least two face-up cards.

### Betting Phase 1

Standard poker-style betting round:

- Play proceeds clockwise from the player left of the dealer.
- On each turn a player may:
  - **Raise:** Increase the current bet amount; all other active players must call or fold.
  - **Call:** Match the current bet.
  - **Check:** Pass (only if no raise has been made this round).
  - **Fold:** Forfeit chips already bet and exit the round.
- The round ends when all active (non-folded) players have bet the same total amount.

### Dealing Phase 2

Each active player receives one additional face-up number card, following the same `√`/`×` rules as Dealing Phase 1.

### Calculation Phase

- A countdown timer starts at `calculationTimeLimit` (default 90 seconds).
- Each player must arrange **all** of their cards (secret card + face-up cards + their personal operator cards that are still held) into one or two valid equations:
  - **Low bet players:** one equation targeting 1.
  - **High bet players:** one equation targeting 20.
  - **Swing bet players:** two equations — one targeting 1, one targeting 20.
- Constraints:
  - All held cards must be used.
  - `√` cards apply to a single number only (e.g. `√9 = 3`).
  - Results may be negative; closeness to target is by absolute difference.
- At the end of the timer, each player locks in their equation(s).

#### Equation Evaluation

- `parseEquation(expression: string, availableCards: Card[]): number | Error`
  - Validates that the cards used exactly match the player's available cards.
  - Evaluates the expression respecting operator precedence (`×`, `÷`, `√` before `+`, `-`).
  - Returns the numeric result or an error if cards do not match or expression is malformed.

### Betting Phase 2

Another poker-style betting round, identical in rules to Betting Phase 1.

### High/Low Bet

- All players simultaneously reveal their `BetChoice` (High, Low, or Swing).
- Players are grouped:
  - **Low group:** players who bet Low or Swing.
  - **High group:** players who bet High or Swing.
- Swing players compete in both groups but must win both to collect anything.

### Results Phase

1. Each player reveals their equation(s) and computed result(s).
2. **Low pot (50% of total pot):** Among Low-group players, find the player whose result is closest to 1 (by `|result - 1|`).
3. **High pot (50% of total pot):** Among High-group players, find the player whose result is closest to 20 (by `|result - 20|`).
4. **Swing players** who do not win both pots lose both bets.
5. Distribute winnings.

#### Tie-Breaking

If two players have identical closeness to the target:

- **High (20) tie:**
  1. Player with the single highest-value number card wins.
  2. Further tie: player with the highest-suited card wins — suit order: `Gold > Silver > Bronze > Black`.

- **Low (1) tie:**
  1. Player with the single lowest-value number card wins.
  2. Further tie: player with the lowest-suited card wins — suit order: `Black > Bronze > Silver > Gold`.

---

## Equation Validation

The expression evaluator must:

- Support operators: `+`, `-`, `×` (or `*`), `÷` (or `/`), `√`
- Apply standard operator precedence (PEMDAS without exponentiation)
- Apply `√` as a unary prefix operator on a single number
- Reject equations whose card multiset does not exactly match the player's hand
- Allow negative intermediate and final results
- Return a `number` (IEEE 754 float is acceptable; round to reasonable precision)

---

## Pot Distribution

```ts
function distributePot(state: GameState): Map<string, number>
```

- Split `pot` into `lowHalf = floor(pot / 2)` and `highHalf = pot - lowHalf`.
- Determine low winner among Low + Swing players using closeness then tie-breaking rules.
- Determine high winner among High + Swing players using closeness then tie-breaking rules.
- Swing player who wins both: add both halves. Swing player who wins only one (or neither): wins nothing.
- Return a map of `playerId → chipsWon`.

---

## Game Loop

```
startRound()
  → forcedBet()
  → dealPhase1()
  → bettingPhase1()
  → dealPhase2()
  → calculationPhase()   // with timer
  → bettingPhase2()
  → highLowBet()
  → resultsPhase()
  → nextRound() or endGame()
```

A round ends immediately if all but one player fold during a betting phase — the remaining player wins the pot without revealing cards.

---

## End-of-Game Condition

The game ends when:
- Only one player has chips remaining, **or**
- Players collectively agree to stop (configurable).

---

## Key Interfaces Summary

| Function | Description |
|---|---|
| `buildDeck()` | Create the 52-card main deck |
| `shuffle(deck)` | Return shuffled copy |
| `drawNumberCard(deck)` | Draw, skipping non-number cards |
| `dealPhase1(state)` | Deal secret + 2 face-up cards, handle `×`/`√` |
| `dealPhase2(state)` | Deal 1 additional face-up card |
| `runBettingRound(state)` | Execute one poker-style betting round |
| `parseEquation(expr, cards)` | Validate and evaluate an equation |
| `resolveHighLowBet(state)` | Group players by bet choice |
| `distributePot(state)` | Calculate and award winnings |
| `breakTie(players, target)` | Apply tie-breaking rules |

---

## Notes & Edge Cases

- **Zero division:** `n ÷ 0` should be treated as an invalid equation; the player must re-arrange.
- **Square root of negative:** Invalid; the player must re-arrange.
- **Odd pot:** When the pot is odd, the High half gets the extra chip (`highHalf = ceil(pot / 2)`), or choose another consistent rule — must be specified before implementation.
- **No Low/High contestants:** If no player bet Low/High (edge case with all-Swing players losing), that half of the pot rolls over to the next round.
- **Minimum 2 players required** to start a game.
- **Forced bet increase** is a house rule; the default implementation should support configuring `forcedBetAmount` between rounds.
