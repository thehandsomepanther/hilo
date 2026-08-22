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
  network.ts       Message layer: HostNetwork, PeerNetwork, wire types
  protocol.ts      Delivery reliability: snapshot versioning, action queue/dedup
  identity.ts      Peer's persistent seat token (survives a reload)
  transport.ts     Byte-level Transport interface
  p2pcfTransport.ts  Production Transport (WebRTC via p2pcf)
  testing/         In-memory Transport with fault injection, for tests
  bots/
    botRunner.ts   Subscribes to game state; dispatches bot actions
    strategy.ts    Stateless decision functions for each game phase
    solver.ts      Brute-force equation solver
  components/      One Svelte component per game phase
```

---

## Table Size

`MAX_PLAYERS` (`src/deck.ts`) is derived, not chosen: dealing consumes exactly **4 number cards per player per round** — 1 secret, 2 in phase 1, 1 in phase 2 — so the deck's 44 number cards seat exactly 11. The phase-1 count holds whatever the symbols do, because a `√` or an accepted `×` eats both of that player's draw slots and pays back a bonus plus a forced extra number.

There is no slack at the cap, so the limit is enforced at three points: `createGame` throws, the lobby's add buttons disable, and the host answers a `hello` beyond the cap with `rejected: 'room-full'`. Without them, dealing throws part-way through and leaves the game half-dealt.

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

**Round-robin dealing**: phase 1 deals cards in two passes so each player receives their first card before anyone receives their second:

```
Pass 1:  player 0 draws,  player 1 draws,  player 2 draws, …
Pass 2:  player 0 draws*, player 1 draws*, player 2 draws*, …   (* only if needed)
```

Implemented as `phase1Pass1Step` + `phase1Pass2Step` in `dealing.ts`. Pass 1 records which players need a second draw in a `needPass2: number[]` array passed into pass 2. Phase 2 (the separate dealing round between betting rounds) already deals one card per player and is inherently round-robin.

**Card dealing rules:**
- Each player receives a face-down secret number card, plus two face-up draws in phase 1 and one more in phase 2.
- If the first face-up draw is a symbol card (√ or accepted ×), it consumes both draws and a forced extra number is drawn, so the player ends up with the same number of number cards as a non-symbol hand. The player is skipped in pass 2.
- A √ card paired with a number is always kept together as a unit in `faceUpCards`.
- A player can receive at most one √ in their hand. If a second √ would be drawn, it is silently replaced with a plain number card. Two √ operators with only three number slots makes a valid equation impossible.

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

## Seat Ownership

`controlsSeat` (`client/gameStore.ts`) is the single predicate the UI uses to decide whether a client acts for a seat and sees its secret card, its equations, and its bet choice. Every component asks it rather than comparing against `localPlayerId` directly.

With a network seat assigned, exactly one seat qualifies: our own. Standalone has no seat assignment, because pass-and-play shares one screen — so every *human* seat is ours. A bot is not: it acts for itself through the bot runner, and its cards stay hidden until `results` like any other opponent's. Without this, a solo game against bots dealt every hand face-up and asked the human to build the bots' equations and pick their side for them.

The consequence for the standalone high/low phase is that only some seats report in at once. `doSubmitBetChoices` therefore applies the choices it was given and advances only when every unfolded player has one — the bots submit theirs independently, and resolving the round early would drop them from both pots.

---

## Networking

The networking layer uses WebRTC data channels, with a Cloudflare Worker (p2pcf) for signalling and room discovery only — players share a 6-character room code, and no game data passes through the Worker.

**Authority model**: the host tab is the single source of truth. It runs the full game engine locally. Every `gameState` change triggers a broadcast to all connected peers. Peers never run game logic — they display state received from the host and forward their actions as serialized messages.

```
Host tab:  runs engine → broadcasts GameState → receives SerializedAction → dispatches locally
Peer tab:  displays GameState ← from host    → sends SerializedAction → to host
```

`SerializedAction` is a tagged union that maps 1-to-1 with exported `gameStore` action functions. The host-side `applyPeerAction` dispatcher routes each message to the corresponding local function. This means the host's action functions serve double duty: they are called directly for local/bot actions and re-called when serialized peer actions arrive.

**Versioned snapshots and heartbeat** (host → peer): `state`, `pendingDecision`, and `lobby` messages carry a per-type monotonic version stamped by the host (`client/protocol.ts`). Peers apply a message only if its version is newer than the last applied for that type. While a game is active, the host rebroadcasts its current snapshots every 3 seconds at their *current* versions — peers that already have them drop the duplicates, and a peer that missed a broadcast (connection blip; the transport drops sends silently when a link is down) self-heals within one heartbeat instead of freezing. The same resend happens immediately when a peer connects.

**Acked actions** (peer → host): each action goes out in an envelope carrying `actionId` (`<clientId>:<counter>`) and the sender's `playerId`, and stays in `PeerNetwork`'s `OutboundActionQueue` until the host acks it. Sends made while the link is down are queued rather than dropped, and unacked actions are retried with exponential backoff (500 ms → 4 s), the whole queue at once so the host never sees a counter gap. The host's `InboundActionFilter` admits each counter exactly once per sending connection: retries that arrive because an *ack* was lost are re-acked but not re-dispatched, which matters because a double-applied betting action would act as the next player. Acks are consumed inside `PeerNetwork` and never reach `gameStore`.

**Seats and reconnection**: a connection earns nothing on its own — a peer claims a seat by sending `hello { token, name }`, which rides the same acked queue and so always arrives before its first action. The token lives in sessionStorage keyed by room (`client/identity.ts`): it survives a reload, which is the case worth recovering, while staying per-tab so two peer tabs in one browser remain two players. The host keeps `token → seat` and hands a returning player their seat back, re-pointing the connection maps at the new transport id and re-sending every snapshot. A token it has never seen is refused (`rejected: 'game-in-progress'`) once a game is underway, rather than being appended to the lobby mid-round. A link that merely blipped comes back on the same transport id and is recognised without a fresh hello.

**Signalling rates**: p2pcf's polling loop is also its reconnection mechanism, so it is never switched off — `Transport.setPollingMode` moves between `'active'` (normal discovery) and `'idle'` (a 45 s keepalive). The host idles only once the lobby has closed *and* every seated player is connected, and returns to active the moment anyone drops; peers do the same for their own link. The cost is a trickle of Worker traffic in exchange for mid-game recovery.

**Connectivity hints**: `noteConnectivityChange()` re-derives the polling mode and calls `Transport.wake()`, which re-posts our peer info and forces an immediate poll. It runs on `online` and on `visibilitychange` (ignoring the hidden transition — a tab going away has nothing to announce). This exists for phones: a wifi → cellular switch changes our reflexive address, and without a hint the room only finds out after p2pcf's own address re-check plus a poll interval. p2pcf's address re-check is a local STUN probe, not a Worker request, so its 15 s cadence is free.

**Presence**: the host tracks which seats have a live connection and broadcasts the list as a versioned `connections` message, so every client renders the same per-player indicator (`seatOnline` folds in bots and standalone, which are always present). Peers additionally watch their own link with `hostLinkUp`, driven by `peerclose` *and* by heartbeat silence — a half-open WebRTC channel can go quiet long before it reports closing. A peer that believes it is offline shows a banner rather than disabling controls: actions taken while disconnected are queued and delivered on reconnect, so the honest message is "saved, will send", not "unavailable".

**Transport abstraction**: `HostNetwork`/`PeerNetwork` (message layer, `client/network.ts`) sit on a byte-level `Transport` interface (`client/transport.ts`). Production injects a p2pcf-backed transport (`client/p2pcfTransport.ts`, loaded via dynamic import so Node tests never touch p2pcf's browser-only dependencies); tests inject `InMemoryRoom`/`InMemoryTransport` (`client/testing/inMemoryTransport.ts`), which reproduce the silent-drop failure semantics with injectable message loss and link up/down control.

**Privacy during high-low-bet**: in the `high-low-bet` phase, each peer receives a sanitized copy of the state with all other players' `betChoice` fields nulled out. The reveal happens when all choices are recorded and the state transitions to `results`, at which point the full state is broadcast.

**Bots in networked games**: bots run exclusively on the host tab. They are indistinguishable from human players in the game engine; the distinction lives only in `lobbyState.players[i].isBot`, which `initGame` uses to build the bot roster passed to `startBotRunner`.

---

## Bot System

Bots run on the host tab (or in standalone mode) via `client/bots/botRunner.ts`, which subscribes to `gameState` and `pendingDecision` and dispatches actions on behalf of bot player IDs.

**Scheduling**: bot actions are delayed by a random 700–1100 ms interval to feel natural. The `scheduleOnce(key, delay, fn)` helper prevents the same action from being scheduled twice. Keys must identify an *action slot*, not a seat — betting keys include `bettingActionsThisRound` because a raise re-opens the betting and asks the same seat to act again, and a seat-only key would swallow every turn after the first.

**Readiness**: bots call `setPlayerReady` themselves once both equations are in. The Ready button only renders for the seat a client controls, so in a networked game nobody else can press it for them, and the host's "Proceed to Betting Phase 2" waits on every active player being ready.

**At fire time, state is re-read**: the timeout callback calls `get(gameState)` fresh rather than relying on the state that was current when the timeout was scheduled. This handles the case where the state has already advanced (e.g. another player acted first).

**Calculation phase**: since `gameState.set(...)` triggers subscribers synchronously, submitting equations for multiple bots in one callback could cause re-entrancy. The calculation handler iterates over `botIds` (not a snapshot of `cs.players`), calling `get(gameState)` before each bot to always operate on the latest state.

**Difficulty** (`client/bots/difficulty.ts`): each bot seat carries an `easy | medium | hard` setting chosen in the lobby, stored on `LobbyPlayer.difficulty` and resolved to a `DifficultyProfile` that every decision function takes as a parameter. `initGame` hands `startBotRunner` a `Map<playerId, BotDifficulty>` rather than a bare set of ids.

The dominant dial is `equationSlack`, because the solver can always find the closest reachable result and a bot that always plays it cannot be out-calculated. `hard` has slack 0 — it is exactly the bot that existed before difficulty did. The rest of the profile covers whether the bot's price tolerance responds to the hand it holds (`readsOwnHand`), whether it raises, whether it solves the × decision rather than using the static rule, how often it declares the wrong side, and whether it understands swing.

**Strategy** (`client/bots/strategy.ts`):
- Betting: check when free; call while the price stays within `baseCallFraction` of the stack, scaled by `handStrength` when the profile reads its own hand; fold otherwise. Hard bots raise on a strong hand, always capped by `maxRaiseAmount` — `applyBettingAction` throws on a raise above the smallest active stack, so the cap is not optional.
- × card: without `evaluatesMultiplication`, accept if the bot has a + operator (discard it), else accept if it has − (discard it), else decline. With it, solve the hand both ways — padded with a placeholder for the unseen bonus card — and take the better branch.
- High/low choice: compare `closenessToTarget(lowResult, 1)` vs `closenessToTarget(highResult, 20)` and pick the closer side, inverted at the profile's `sideMistakeChance`. Only hard bots declare swing, and only when both sides are all but exact — swing must win *both* halves.

**Solver** (`client/bots/solver.ts`): exhaustive search over all permutations of number cards × all permutations of binary operator cards × all placements of √ cards. Each candidate is built as a flat infix string and validated through `evaluateEquation` (which enforces the card multiset constraint). `rankedSolutions` returns every candidate ordered by distance to each target, **deduplicated by result value** so that reaching further down the list means a worse answer rather than another spelling of the best one; `pickCandidate` draws from the leading `1 + slack × (n − 1)` of them. `solveEquations` is the thin best-of wrapper. Typical hand sizes (~7–8 tokens) produce at most ~1500 candidates, and results are memoised per hand because betting now consults the solver on every decision.

---

## Svelte 5 and Store Bridging

The UI is written in Svelte 5 runes mode. Game stores are Svelte 3-style `writable` stores (from `svelte/store`) rather than `$state` runes because they need to be imported and mutated from plain TypeScript modules (`gameStore.ts`, `botRunner.ts`) that run outside Svelte component scope. Components access these stores reactively using the `$store` auto-subscription syntax.

Component-local reactive state (derived display values, error messages, UI flags) uses Svelte 5 `$state` and `$derived` runes.
