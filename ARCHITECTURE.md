# Equation Hi-Lo — Architecture

## Overview

Equation Hi-Lo is a card game for 2–N players (human or bot) built with Svelte 5 on the frontend and a pure TypeScript game engine in the backend. Players are dealt number and operator cards, construct arithmetic equations, then bet on whether their result is closer to 1 (low) or 20 (high). Multiplayer runs over WebRTC data channels with manual (out-of-band) signaling — no server required.

---

## Directory Structure

```
src/           Pure game engine — no DOM, no Svelte, no I/O
  types.ts     All TypeScript types: cards, players, GameState variants
  deck.ts      Deck construction, shuffle, draw helpers
  game.ts      State transition functions (the rules)
  equation.ts  Equation tokeniser, parser, and card-set validator
  results.ts   Round resolution and payout logic

client/        UI and orchestration layer
  main.ts          Svelte app entry point
  gameStore.ts     Central store: holds GameState, drives all transitions
  dealing.ts       Step machine for interactive dealing (× card decisions)
  network.ts       WebRTC classes: HostNetwork, PeerNetwork, wire types
  bots/
    botRunner.ts   Subscribes to game state; dispatches bot actions
    strategy.ts    Stateless decision functions for each game phase
    solver.ts      Brute-force equation solver
  components/      One Svelte component per game phase
```

---

## Core Principle: Pure Engine, Thin Orchestrator

`src/` contains zero side effects. Every function in `game.ts` and `results.ts` takes a state value and returns a new state value — no mutation, no stores, no promises. The engine can be unit-tested in Node without a browser.

`client/gameStore.ts` is the only place that calls engine functions and writes to Svelte stores. Components never import from `src/` directly; they import from `gameStore.ts`. This makes the data flow explicit: UI → store action → engine function → store write → reactive UI update.

---

## GameState as a Discriminated Union

The entire game is represented as a single `GameState` value, a TypeScript discriminated union over the `phase` field:

```
setup → forced-bet → dealing-1 → betting-1 → dealing-2
      → betting-2 → calculation → high-low-bet → results
      → (next round: forced-bet) | game-over
```

Each phase has its own type with exactly the fields that exist at that point:

- **`SetupState` / `ForcedBetState`**: players are `UndealPlayer[]` — `secretCard: null`, `faceUpCards: []`.
- **`Dealing1State`**: players are `Player[]` (mixed), transitioning one by one.
- **`Dealing2State` and later**: players are `DealtPlayer[]` — `secretCard` is guaranteed non-null.
- **`Betting1State` / `Betting2State`**: add `activePlayerIndex`, `currentBet`, `bettingActionsThisRound`.
- **`ResultsState`**: embeds `result: RoundResult` directly — no separate result store needed.

The compiler enforces that code touching `player.secretCard` can only run after dealing, and code touching `player.betChoice` can only run after phase 1. The discriminated union eliminates whole classes of null-check bugs at compile time.

---

## Player Types: UndealPlayer vs DealtPlayer

```ts
type UndealPlayer = BasePlayer & { secretCard: null; faceUpCards: [] };
type DealtPlayer  = BasePlayer & { secretCard: NumberCard; faceUpCards: Card[]; betChoice: ...; ... };
type Player       = UndealPlayer | DealtPlayer;
```

The split means downstream code never needs to null-check `secretCard`. `dealSecretCards` in `game.ts` performs the structural transition from `UndealPlayer` to `DealtPlayer`. The `Dealing1State` players array is typed as `Player[]` (the union) because players transition one at a time; by `Betting1State` every player is a `DealtPlayer`.

---

## Dealing: The Step Machine

Dealing is the only phase that can pause mid-execution (a × card requires a player decision). Rather than using async/await or callbacks through the pure engine, `client/dealing.ts` implements a synchronous step machine:

```ts
type DealStep<Final> =
  | { status: 'complete'; state: Final }
  | { status: 'awaiting-decision'; player: Player; state: ...; resume: (d: MultiplicationDecision) => DealStep<Final> };
```

`startDealPhase1` returns a `DealStep`. If dealing can proceed without interruption, it returns `{ status: 'complete' }` immediately. If a × card is drawn, it returns `{ status: 'awaiting-decision' }` along with a `resume` continuation — a closure that, when called with the player's decision, returns the next `DealStep`.

`gameStore.runDealStep` drives this machine: on `complete`, it writes the final state; on `awaiting-decision`, it writes the intermediate state and sets `pendingDecision` so the UI can display the decision overlay.

**Card dealing rules:**
- Each player receives a face-down secret number card, plus two face-up draws in phase 1 and one more in phase 2.
- If the first face-up draw is a symbol card (√ or accepted ×), it consumes both draws (a paired number is added automatically), so the player still ends up with the right number of equation tokens.
- A √ card paired with a number is always kept together as a unit in `faceUpCards`.
- A player can receive at most one √ in their hand. If a second √ would be drawn (e.g. in phase 2), it is silently replaced with a plain number card. Two √ operators with only three number slots makes a valid equation impossible.

---

## Equation Validation

The equation parser (`src/equation.ts`) implements a standard recursive-descent grammar:

```
expr    := term  (('+' | '-') term)*
term    := unary (('×' | '÷') unary)*
unary   := '√' primary | primary
primary := NUM | '(' expr ')'
```

`√` is a unary prefix that applies to exactly one primary (a number or parenthesised sub-expression). This matches the game rule: "square root applies to a single number."

**Card-set validation** is built into the evaluator. The parser records every number and operator consumed during evaluation. `evaluateEquation` then compares these multisets against the player's available cards. An equation is valid only if it uses every card exactly once — no cards left over, no cards used twice.

---

## Betting

Betting state tracks three key values per betting round:

- `currentBet`: the highest bet any player has placed this round.
- `player.currentBet`: what this individual player has contributed.
- `bettingActionsThisRound`: a counter used to detect when everyone has acted.

A betting round is complete when all active (non-folded) players have acted at least once **and** all their `currentBet` values equal `currentBet`. This handles the case where a raise forces all previous actors to call again.

**All-in handling**: calls are capped at `player.chips` so a player can go all-in without error. Raises are capped at the minimum stack of all active players (preventing a raise that a short-stacked player cannot even call).

**Automatic fold on last player**: if `advanceFromBetting` detects only one active player, it transitions directly to `results` with a `last-player-standing` result — skipping the remaining phases.

---

## Round Resolution

At the end of the `high-low-bet` phase, `resolveRound` (in `src/results.ts`) awards half the pot to the player closest to 1 (among those who chose "low" or "swing") and half to the player closest to 20 (among those who chose "high" or "swing").

**Swing**: a player who bets "swing" competes for both halves. If a swing player wins both sides, they take the full pot. If they win only one side, they are excluded from the other side and the best non-swing player wins it instead.

**Tie-breaking**: when two players are equally close to a target, the player with the highest single number card (for high) or lowest single number card (for low) wins, using suit rank as a tiebreaker (Gold wins for high, Black wins for low).

**Rollover**: if a half-pot has no valid winner (e.g. no one chose "low"), those chips are stored under the key `__rollover__` and added to the next round's pot.

---

## Networking

The networking layer uses WebRTC data channels. No signaling server is involved — connection establishment is handled out-of-band by copying base-64 encoded SDP blobs between players (e.g. by text or QR code).

**Authority model**: the host tab is the single source of truth. It runs the full game engine locally. Every `gameState` change triggers a broadcast to all connected peers. Peers never run game logic — they display state received from the host and forward their actions as serialized messages.

```
Host tab:  runs engine → broadcasts GameState → receives SerializedAction → dispatches locally
Peer tab:  displays GameState ← from host    → sends SerializedAction → to host
```

`SerializedAction` is a tagged union that maps 1-to-1 with exported `gameStore` action functions. The host-side `applyPeerAction` dispatcher routes each message to the corresponding local function. This means the host's action functions serve double duty: they are called directly for local/bot actions and re-called when serialized peer actions arrive.

**Privacy during high-low-bet**: in the `high-low-bet` phase, each peer receives a sanitized copy of the state with all other players' `betChoice` fields nulled out. The reveal happens when all choices are recorded and the state transitions to `results`, at which point the full state is broadcast.

**Bots in networked games**: bots run exclusively on the host tab. They are indistinguishable from human players in the game engine; the distinction lives only in `lobbyState.players[i].isBot`, which `initGame` uses to build the `botIds` set passed to `startBotRunner`.

---

## Bot System

Bots run on the host tab (or in standalone mode) via `client/bots/botRunner.ts`, which subscribes to `gameState` and `pendingDecision` and dispatches actions on behalf of bot player IDs.

**Scheduling**: bot actions are delayed by a random 700–1100 ms interval to feel natural. The `scheduleOnce(key, delay, fn)` helper prevents the same action from being scheduled twice. Keys encode round + phase + enough context (e.g. `activePlayerIndex` for betting) to be unique per action slot.

**At fire time, state is re-read**: the timeout callback calls `get(gameState)` fresh rather than relying on the state that was current when the timeout was scheduled. This handles the case where the state has already advanced (e.g. another player acted first).

**Calculation phase**: since `gameState.set(...)` triggers subscribers synchronously, submitting equations for multiple bots in one callback could cause re-entrancy. The calculation handler iterates over `botIds` (not a snapshot of `cs.players`), calling `get(gameState)` before each bot to always operate on the latest state.

**Strategy** (`client/bots/strategy.ts`):
- Betting: check when free; call if the cost is ≤ 25% of remaining chips; fold otherwise. Bots never raise.
- × card: accept if the bot has a + operator (discard it); else accept if it has − (discard it); else decline.
- High/low choice: compare `closenessToTarget(lowResult, 1)` vs `closenessToTarget(highResult, 20)` and pick the closer side. Bots never choose swing.

**Solver** (`client/bots/solver.ts`): exhaustive search over all permutations of number cards × all permutations of binary operator cards × all placements of √ cards. Each candidate is built as a flat infix string and validated through `evaluateEquation` (which enforces the card multiset constraint). The best expression closest to 1 and closest to 20 are returned. Typical hand sizes (~7–8 tokens) produce at most ~1500 candidates.

---

## Svelte 5 and Store Bridging

The UI is written in Svelte 5 runes mode. Game stores are Svelte 3-style `writable` stores (from `svelte/store`) rather than `$state` runes because they need to be imported and mutated from plain TypeScript modules (`gameStore.ts`, `botRunner.ts`) that run outside Svelte component scope. Components access these stores reactively using the `$store` auto-subscription syntax.

Component-local reactive state (derived display values, error messages, UI flags) uses Svelte 5 `$state` and `$derived` runes.
