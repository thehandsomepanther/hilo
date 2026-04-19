# Equation Hi-Lo

A multiplayer card game combining poker-style betting with mental arithmetic. Players are dealt number and operator cards, build equations targeting 1 (Low) or 20 (High), and bet on the strength of their result. The pot is split between the closest-to-1 and closest-to-20 equations each round.

Playable in a browser — no account or installation required. Supports local (pass-and-play) and networked multiplayer over WebRTC.

**[Play on GitHub Pages](https://thehandsomepanther.github.io/hilo/)**

---

## How to Play

### The Cards

Each player holds **personal operator cards** for the entire game: `+`, `−`, and `÷`. These are never drawn from the deck — they're yours from the start.

The shared deck contains 52 cards:
- **44 number cards** — values 0–10 in four suits: Gold, Silver, Bronze, Black
- **4 multiplication cards** (`×`)
- **4 square root cards** (`√`)

### Round Structure

Each round proceeds through these phases:

**1. Forced Bet** — Every player antes a fixed amount into the pot.

**2. Deal Phase 1** — Each player receives:
- One **secret (face-down) number card** — visible only to you
- Two **face-up cards** — visible to everyone

Special rules for face-up draws:
- `√` card: kept face-up, plus you draw a bonus number card
- `×` card: you choose to accept it (giving up your `+` or `−`) or decline it — either way you also receive a bonus number card

**3. Betting Phase 1** — Poker-style betting: raise, call, check, or fold.

**4. Deal Phase 2** — Each active player draws one more face-up card (same `√`/`×` rules apply).

**5. Calculation Phase** — A 90-second timer starts. Using **all** of your cards (secret + face-up + your personal operators), build two equations:
- A **Low equation** targeting 1
- A **High equation** targeting 20

Every card must be used. Results can be negative — closeness to the target is measured by absolute difference.

**6. Betting Phase 2** — Another poker-style betting round.

**7. High/Low Bet** — Simultaneously declare your bet: **Low**, **High**, or **Swing**.
- **Low**: you compete for the half of the pot awarded to the equation closest to 1
- **High**: you compete for the half awarded to the equation closest to 20
- **Swing**: you compete in both halves simultaneously — but you must win *both* to collect anything

**8. Results** — Equations are revealed and winners are determined. The pot is split 50/50 between the best Low result and the best High result. Leftover chips from an uncontested side (no valid contestants) roll over into the next round's pot.

### Tie-Breaking

When two players are equally close to a target:

- **High (20):** Player with the highest single number card wins. Further tie: Gold > Silver > Bronze > Black.
- **Low (1):** Player with the lowest single number card wins. Further tie: Black > Bronze > Silver > Gold.

### Winning

The game ends when only one player has chips remaining.

---

## Equation Rules

- Supported operators: `+` `−` `×` `÷` `√`
- Standard operator precedence applies (`×` and `÷` before `+` and `−`)
- `√` is a unary prefix operator applied to a single number (e.g. `√9`)
- Division by zero and square roots of negative numbers are invalid
- Every card in your hand must appear in the equation exactly once
- There are no paretheticals at all (e.g. no `√(7 + 2)`)
- Equations are evaluated according to order of operations

---

## Multiplayer

The game supports two modes:

### Local (pass-and-play)
Select "Local" at the lobby screen. All players share the same browser window and take turns.

### Networked (WebRTC, no server required)
One player hosts; others join by exchanging connection blobs manually (copy/paste or out-of-band sharing). No signaling server is involved — connection data is base-64 encoded SDP/ICE and can be sent over any channel (text, QR code, etc.).

To start a networked game:
1. Host selects "Host" and shares the generated offer blob with each joining player
2. Each peer pastes the offer, generates an answer blob, and sends it back to the host
3. The host applies each answer — once connected, the game begins
4. Only the host can advance phases; peers' actions are sent to the host and applied there

---

## Development

### Prerequisites

- Node.js 18+
- [pnpm](https://pnpm.io/)

### Setup

```bash
pnpm install
```

### Run locally

```bash
pnpm dev
```

### Run tests

```bash
pnpm test
```

### Build for production

```bash
pnpm build
```

Output goes to `docs/` for GitHub Pages deployment.

### Type-check

```bash
pnpm typecheck
```

---

## Project Structure

```
src/           # Pure game logic (no UI dependencies)
  types.ts     # Card, Player, GameState type definitions
  deck.ts      # Deck construction, shuffling, drawing
  game.ts      # Phase transitions, betting, dealing
  equation.ts  # Equation parser and evaluator
  results.ts   # Round resolution and payout calculation
  __tests__/   # Vitest unit tests

client/        # Svelte 5 frontend
  App.svelte          # Root component and player table
  gameStore.ts        # Svelte store wrapping game logic
  network.ts          # WebRTC host/peer classes
  dealing.ts          # Async dealing with UI callbacks
  components/
    Setup.svelte       # Game configuration
    NetworkLobby.svelte
    ForcedBet.svelte
    Dealing.svelte
    Betting.svelte
    Calculation.svelte # Equation builder UI
    HighLowBet.svelte
    Results.svelte
    GameOver.svelte
```
