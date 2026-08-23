# PWA / Offline Single-Player Plan — Equation Hi-Lo

> **Status:** Phases 1–3 and 5 are implemented. Phase 4 (surviving eviction) is
> **not** done — a game in progress is still memory-only, which is also why the
> update prompt warns before reloading mid-round.

## Context — most of this already works

The game engine (`src/`) is pure and synchronous, and standalone mode already
runs the whole game in the tab with no network at all: `networkMode` defaults
to `'standalone'` (`client/gameStore.ts:71`), bots run in-process via
`startBotRunner` (`client/bots/botRunner.ts:167`), and `controlsSeat` already
hides bot hands so a standalone game against bots plays as real single-player
rather than solitaire.

The only `fetch` anywhere in the client is the TURN-credentials call in
`client/p2pcfTransport.ts:38`, reached only in host/peer mode. The built output
is five static files (`docs/`, ~170 KB total, all content-hashed).

So "play offline against bots" is *already implemented*. What's missing is
four things, and only the third is real product work:

1. an installable identity (manifest + icons) — none exist today, not even a favicon
2. a service worker so the shell is available with no network
3. a UI that doesn't dead-end when the app is opened offline
4. game state that survives the tab being evicted (optional, but this is what
   makes an installed mobile PWA actually usable)

## Deployment constraints to respect

- `base` is `/hilo/` by default with a `VITE_BASE_PATH` override
  (`vite.config.ts:6`); output goes to `docs/` for GitHub Pages
  (thehandsomepanther.github.io/hilo/). A service worker's scope is tied to the
  path it is served from, so registration must go through
  `import.meta.env.BASE_URL`, and `start_url`/`scope` in the manifest must be
  relative (`.`), never `/`. Hard-coding `/sw.js` breaks the Pages deploy.
- The Cloudflare Pages copy (hilo.pages.dev) is built with a different base.
  It needs its own build — don't serve a `/hilo/`-based `docs/` from a root
  domain, or the SW will register out of scope.
- The pre-commit hook is `pnpm build && git add docs/`, so the manifest, icons,
  and generated `sw.js` land in the committed bundle automatically. No CI
  change needed. Accept that `sw.js`'s precache manifest will churn on every
  commit, the same way hashed asset names already do.
- **Land the in-flight bot-difficulty work first.** `client/bots/difficulty.ts`
  is untracked and `gameStore.ts`, `network.ts`, `strategy.ts`, `solver.ts`,
  and `botRunner.ts` are all modified against it. Phase 3 wants to pick a bot
  difficulty from the solo entry point, so build on top of that rather than
  beside it.

## Phase 1 — Manifest and icons

Create `public/` (it doesn't exist yet; Vite copies it to `outDir` verbatim)
and add `icon-192.png`, `icon-512.png`, a maskable 512 variant, an
`apple-touch-icon-180.png`, and an SVG favicon. Something legible at 48 px —
the deck's suits or a `1 ≤ x ≤ 20` mark.

Manifest fields that matter here:

```
name: "Equation Hi-Lo", short_name: "Hi-Lo"
start_url: ".", scope: ".", display: "standalone"
background_color / theme_color, icons incl. purpose: "maskable"
```

Generate the manifest from `vite.config.ts` (see Phase 2) rather than checking
in a static `manifest.webmanifest`, so the base path is rewritten for you.

In `index.html`: `<link rel="manifest">`, `theme-color`, and the Apple
touch-icon/status-bar metas.

One trap: the invite flow rewrites the address bar to carry `?room=…` via
`history.replaceState` (`client/components/NetworkLobby.svelte:81-87`). A user
who installs while sitting on an invite URL can end up with a launcher entry
that tries to rejoin a dead room every time. A relative `start_url` of `"."`
plus the offline guard in Phase 3 covers this.

## Phase 2 — Service worker

**Recommendation: `vite-plugin-pwa`** (dev dependency, Workbox `generateSW`).
The asset filenames are content-hashed on every build, so the precache list has
to be generated at build time; rolling it by hand means writing a Vite plugin
that reads the bundle in `generateBundle` and emits `sw.js`. That is genuinely
only ~40 lines given how small the output is, and it fits this repo's
build-it-yourself character — but you would then own revisioning, cache
cleanup, and the update handshake. Not worth it for a solved problem.

Config sketch:

```ts
VitePWA({
  registerType: 'prompt',
  manifest: { /* Phase 1 fields */ },
  workbox: {
    globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
    navigateFallback: 'index.html',
    cleanupOutdatedCaches: true,
  },
})
```

Notes on the choices:

- **`registerType: 'prompt'`, not `'autoUpdate'`.** Auto-update reloads the tab
  when a new worker activates. Game state is in-memory only until Phase 4, so
  an auto-reload mid-round silently destroys the game. Prompt, with a small
  "New version available — reload" banner in `App.svelte`, and let the player
  choose the moment. (If you do Phase 4, `autoUpdate` becomes safe.)
- **No runtime caching rules.** Precaching the shell is the entire strategy.
  Explicitly do *not* let the SW intercept the signalling worker or the
  `/turn-creds` fetch (`client/p2pcfTransport.ts:38`) — those are cross-origin
  and online-only by definition, and a cached TURN credential is a stale
  credential. Workbox won't touch them by default; verify it stays that way.
- The p2pcf chunk is dynamically imported and gets precached along with
  everything else. That's correct: without it, an offline cold start would
  attempt a chunk fetch during module init.

## Phase 3 — Make the offline path a real path

This is the part that isn't config. Today, a cold offline launch lands on
`NetworkLobby`, whose two prominent buttons both require the network, and whose
third is labelled "Play without networking".

1. **Add an `online` store** (`client/online.ts`): a `writable` seeded from
   `navigator.onLine` and updated from the `online`/`offline` window events.
   Small, and it drives everything below.

2. **Guard the auto-join.** `NetworkLobby.svelte:101-112` calls `setupAsPeer`
   at module scope whenever `?room=` is present. Offline, that spins for the
   full 30 s `connectTimeout` (`:48-60`) before showing a networking error —
   the worst possible first impression for an installed app opened on a plane.
   When offline and a `room` param is present, skip `setupAsPeer`, show "You're
   offline — this invite needs a connection", offer the solo path, and retry
   automatically when the `online` event fires.

3. **Reorder the choose screen** (`:132-153`) when offline: explain that
   hosting and joining need a connection, and promote the local option to the
   primary action. Rename it from "Play without networking" to something
   affirmative — "Single player vs bots" / "Pass and play".

   Caveat: `navigator.onLine === true` only means a link exists, not that the
   internet is reachable. So *soften* Host/Join when offline (warn, keep them
   clickable) rather than hard-disabling them, and keep the 30 s timeout as the
   real failure detector.

4. **Add a one-click solo start.** The standalone lobby starts as a single
   player with an empty name (`client/gameStore.ts:78-82`), so today "single
   player" means clicking `+ Add bot` twice and typing three names. A "Play
   solo" button that seeds `lobbyState` with one human plus two bots at the
   default difficulty and jumps straight to `Setup` is a few lines and is the
   difference between an installed app that's fun to open and one that isn't.

## Phase 4 — Survive eviction (optional, strongly recommended)

An installed PWA on a phone gets backgrounded and killed constantly. Without
persistence, every return to the app is a lost game — and that also blocks the
safer `autoUpdate` in Phase 2.

This is cheaper than it sounds. `GameState` is plain JSON (no `Set`, `Map`, or
`Date` in `src/types.ts`) and the entire state already round-trips through
`JSON.stringify` on the wire (`client/network.ts:125-131`), so multiplayer has
been proving the serialization works this whole time.

- Persist from a single `gameState.subscribe`, only when
  `networkMode === 'standalone'`, into `localStorage` alongside `lobbyState`
  (needed to rebuild the bot id set).
- **Only persist at stable phases** — skip while `isDealing` is true or
  `pendingDecision` is non-null. `PendingDecision` holds a live `resolve`
  callback (`client/gameStore.ts:65-69`) that cannot be serialized, and the
  dealing flow is mid-async. Resuming to the last settled phase and re-dealing
  is correct and much simpler than trying to snapshot a suspended deal.
- To restore, mirror the tail of `initGame`: `gameState.set(saved)` then start
  the bot runner from the saved lobby (`client/gameStore.ts:572-582`). Factor
  that bot-start block out into a `startBotsForLobby(lobby)` so init and resume
  share one code path instead of drifting.
- Offer "Resume game / New game" on the Setup screen when a save exists; clear
  it at `game-over` and on a fresh `initGame`.
- Cap the persisted `log` (keep the last ~200 entries) — it grows without bound
  and is the only part of the state that isn't small.

## Phase 5 — Verification

- `pnpm build && npx vite preview`, which serves at `/hilo/` because of `base`.
  DevTools → Application: manifest parses and is installable; the SW is
  registered **under `/hilo/`, not `/`**. Then Network → Offline, hard reload,
  and play a bot game to `game-over` with the network off.
- Install on a real phone from the Pages URL, enable airplane mode, launch from
  the home screen. Desktop emulation misses the launcher/eviction behaviour
  that matters most here.
- Regression check that multiplayer is untouched: host a room online with the
  SW active and confirm signalling, the `/turn-creds` fetch, and the data
  channels all behave — nothing should be served from cache.
- Lighthouse's PWA audit as a checklist, not a target.
- Leave the vitest suite alone. `client/__tests__` runs in Node with an
  in-memory transport; service workers aren't testable there and faking them
  would test the fake. SW verification is manual and belongs in DevTools.

## Out of scope: two installed devices on a local hotspot

Worth writing down explicitly, because it looks like it should work and
doesn't. Two players on a hotspot with no internet — one hosts, the other
joins — fails, and not for the reason you'd guess.

The **data path is fine**. Both devices sit on the same subnet, so ICE would
settle on link-local host candidates with no STUN or TURN involved; the two
STUN servers at `client/p2pcfTransport.ts:25-28` would simply time out first
and add some delay.

**Signalling is the blocker.** p2pcf exchanges SDP by HTTP POST to a Cloudflare
Worker (`node_modules/p2pcf/src/p2pcf.js:383` and `:407`, defaulting to the
public `p2pcf.minddrop.workers.dev`), and has no LAN discovery fallback. No
internet means the two devices never exchange candidates. Running your own
worker doesn't help — it's on Cloudflare too. Nor can the hosting device serve
signalling itself: a browser tab cannot accept inbound connections. Both
players would load the app fine from cache (an invite URL is in SW scope, so
the navigation is served without DNS), reach the lobby, and sit through the
30 s timeout.

Two things that *do* work:

**Pass-and-play, already shipped.** Standalone supports multiple human seats
(`+ Add player`, `client/components/Setup.svelte:103`) and `controlsSeat`
treats every human seat in standalone as local, so hands are visible to whoever
holds the device and passing it is the privacy mechanism. For two people
sitting together this is the answer, and it costs nothing.

**A manual-signalling transport (QR exchange)**, if pass-and-play isn't enough.
The architecture is unusually ready for it: `Transport` is a 52-line interface
(`client/transport.ts:28-52`) with two implementations already, so a third
slots in under `HostNetwork`/`PeerNetwork` with no changes above it, and
`tiny-simple-peer` is already present as a p2pcf dependency. Host generates an
offer with trickle disabled (one blob carrying all candidates), renders a QR;
peer scans and shows an answer QR; host scans back. Set `iceServers: []` in
this mode so gathering doesn't stall on unreachable STUN. Costs, worst first:

- **Reconnection is gone.** `setPollingMode` and `wake` become no-ops, and the
  healing design assumes polling *is* the reconnect mechanism
  (`client/transport.ts:16-25`). The versioned-snapshot and acked-action layers
  will resync once a channel is re-established, but re-establishing it means
  re-scanning mid-game.
- `BarcodeDetector` is Chrome/Android only; Safari needs a bundled JS decoder
  (jsQR, ~50 KB, precached).
- O(n−1) scan pairs — fine at two players, tedious at four.

Not part of the PWA phases above; it is a separate feature that happens to share
the offline motivation. Costed out properly — with measured SDP sizes and the
mDNS problem it turns on — in [lan-qr-multiplayer.md](lan-qr-multiplayer.md).

## Known gotchas

- **Stale worker trapping users on an old build.** `cleanupOutdatedCaches` plus
  a visible update prompt. GitHub Pages caches `sw.js` for ~10 minutes and you
  can't set headers there, so updates lag slightly — harmless for this app.
- **iOS storage isolation.** An installed PWA gets a different storage bucket
  than Safari, so a Phase 4 save started in the browser tab won't appear in the
  installed app. Expect to be confused by this once.
- **Two deploy targets, two bases.** Anything that hard-codes `/hilo/` in the
  SW registration or the manifest will silently break hilo.pages.dev.

## Rough effort

Phases 1–2 are an hour of config plus however long the icons take. Phase 3 is a
couple of hours. Phase 4 is the only substantial one — half a day with the
resume path tested.
