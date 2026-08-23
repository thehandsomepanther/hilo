# Equation Hi-Lo

A multiplayer card game combining poker-style betting with mental arithmetic. Players are dealt number and operator cards, build equations targeting 1 (Low) or 20 (High), and bet on the strength of their result. The pot is split between the closest-to-1 and closest-to-20 equations each round.

Playable in a browser — no account or installation required. Supports local (pass-and-play) and networked multiplayer over WebRTC.

**[Play on GitHub Pages](https://thehandsomepanther.github.io/hilo/)**

### Install it / play offline

The site is a PWA, so your browser will offer to install it (on iOS, Share →
Add to Home Screen). Once installed it runs with no connection at all: the whole
app is cached on first visit, and **Play solo vs bots** and **Pass and play on
this device** both work entirely offline.

Hosting and joining over the internet still need a connection — that's how
players find each other — so the lobby leads with the local options when you're
offline. Note that a game in progress currently lives only in memory: closing
the app loses it.

**Play over local wifi (QR)** connects two or more devices on the same network
with no internet at all — a hotspot, a plane, a hotel with a captive portal.
With no signalling server to introduce them, the devices do it by camera: the
host shows a QR code, the player scans it and shows one back, and the host scans
that. One exchange per player. Both devices need a camera, and the page must be
served over HTTPS for the camera to work. Because there's no signalling channel
afterwards, a reload means redoing the scan — the seat and chips survive, but
the connection has to be rebuilt.

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
- `√` is a unary prefix operator applied to a single number (e.g. `√9`) — never to a running total, so `√7 + 2` is `(√7) + 2`
- **No parentheses.** Precedence alone decides the order, so `2 + 3 × 4` is 14 and there is no way to make it 20
- Division by zero is invalid
- Every card in your hand must appear in the equation exactly once

---

## Multiplayer

Up to **11 players** — the deck holds 44 number cards and each player uses exactly 4 per round.

### Local (pass-and-play)

Choose "Play without networking" at the lobby screen. All players share one browser window and take turns. You can add bots here too.

### Networked

One player hosts and gets a six-character room code plus an invite link; everyone else joins with either. Gameplay runs over WebRTC data channels directly between browsers — a Cloudflare Worker is used only to help peers find each other, and no card, bet, or game state ever passes through it.

The host tab is authoritative: it runs the game engine and broadcasts state, while peers forward their actions to it. That means **the host must stay open** for the game to continue.

The connection is designed to survive interruptions. Missed updates are re-sent on a heartbeat, actions taken while offline are queued and delivered on reconnect, and refreshing a tab rejoins the same room and reclaims the same seat, chips and cards.

---

## Self-hosting the signalling worker

By default the app uses [p2pcf](https://github.com/gfodor/p2pcf)'s shared public signalling worker and **no TURN relay**, which is usually fine on home wifi but often fails on mobile networks, where carrier-grade NAT blocks direct peer-to-peer connections. Running your own worker gives you private signalling and optional TURN. Cloudflare's free tier is ample: a four-player game mid-round makes roughly 320 requests an hour, against a free limit of 100,000 a day.

The worker does two things, neither involving gameplay:

- **Room rendezvous** — peers post and read each other's connection details. This needs an R2 bucket for scratch storage.
- **`GET /turn-creds`** — hands out TURN relay credentials. Optional; returns an empty list if unconfigured, and clients then fall back to STUN only.

### Option A — Terraform

Provisions the worker, the R2 bucket, and a Pages project for the site itself. You need a Cloudflare account and an API token with Workers, Pages, and R2 permissions.

```bash
cd terraform
cat > terraform.tfvars <<'EOF'
cloudflare_api_token  = "your-api-token"
cloudflare_account_id = "your-account-id"
workers_subdomain     = "your-subdomain"   # Workers & Pages → your subdomain
allowed_origins       = "https://your-site.example"
metered_username      = ""                 # optional, see TURN below
metered_credential    = ""                 # optional
EOF

terraform init
terraform apply
terraform output worker_url
```

`terraform.tfvars` and the state files are gitignored — they hold your credentials, so keep it that way.

### Option B — Wrangler only

Deploys just the worker and its bucket.

```bash
npx wrangler r2 bucket create hilo-signaling
# In wrangler.toml, set `name` and `account_id` to your own.
npx wrangler deploy

# Optional, to enable TURN:
npx wrangler secret put METERED_USERNAME
npx wrangler secret put METERED_CREDENTIAL
```

### Pointing the game at it

In the lobby, open **Advanced** and paste the worker URL into "Custom worker URL" *before* clicking Host or Join. It is remembered in your browser, and the invite link carries it, so anyone joining through that link picks it up automatically.

Anyone typing the room code by hand must enter the same worker URL — two players on different workers are looking in different places and will never find each other.

### TURN relay

Without `METERED_USERNAME`/`METERED_CREDENTIAL`, `/turn-creds` returns an empty list and clients use STUN only. Direct connections then work on most home networks but frequently fail on cellular. [Metered.ca](https://www.metered.ca/) has a free tier and is what the worker is wired up for out of the box; any TURN provider works if you edit `handleTurnCreds` in `worker.js`.

### Keeping it to yourself

- `ALLOWED_ORIGINS` — comma-separated list of sites permitted to use the worker. Set it without `ORIGIN_QUOTA` and every other origin is refused outright.
- `ORIGIN_QUOTA` — monthly join budget per origin (default 10,000) for origins not on the list.

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
