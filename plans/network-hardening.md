# Network Hardening Plan — Equation Hi-Lo

## Context

In multiplayer, the host tab is the sole authority: it runs the engine, and a
`gameState.subscribe` hook broadcasts the **entire GameState** to every peer on
every change. Peers run no game logic — their action functions serialize a
`SerializedAction` and send it to the host, which dispatches it to the same
local store functions. Transport is WebRTC data channels via p2pcf, with a
Cloudflare Worker used only for signalling/discovery.

## Tradeoffs of the current design

**Host-authoritative full-state broadcast** — Excellent simplicity: no
reconciliation, no per-peer deltas, peers are dumb renderers, and the engine
stays purely testable. The costs: the host tab is a single point of failure (a
host reload destroys the game — there's no persistence); bandwidth grows
without bound because `log` is an ever-growing array re-sent on every change;
and **peers receive everyone's `secretCard` in every phase** —
`sanitizeStateForPeer` (`client/gameStore.ts:93`) only strips `betChoice`
during `high-low-bet`, so any player can read opponents' hidden cards in
devtools.

**Fire-and-forget messaging with no delivery protocol** — There are no
sequence numbers, acks, retries, or dedup anywhere. This works only because
WebRTC data channels are reliable and ordered *while the connection is alive*.
The moment a connection blips, messages vanish silently: p2pcf's `send()`
begins with `if (!peer.connected) return`
(`node_modules/p2pcf/src/p2pcf.js:908`), `PeerNetwork.send` no-ops when
`hostPeer` is null (`client/network.ts:228`), and `HostNetwork.send` no-ops
for unknown peers (`client/network.ts:147`). No caller ever learns a send
failed.

**Signalling is permanently disabled after the lobby** — `hostProceed()` calls
`stopPolling()` on the host and broadcasts `proceedToSetup`, which makes every
peer do the same (`client/gameStore.ts:544, 554–557`). This is a deliberate
cost-saving move (the Cloudflare Worker stops receiving polls), but p2pcf's
polling loop is also its *reconnection* mechanism. After the lobby, a dropped
connection can never be re-established.

**Actions carry no sender identity** — `doBettingAction` has no `playerId`;
the host applies whatever arrives to `players[activePlayerIndex]`. Any peer
can also send `doNextRound`, `doDeal`, or even `initGame`. This is fine among
trusting friends, but it means a *late-arriving* action (delivered after the
state moved on) can be silently applied to the wrong player, and duplicate
delivery would double-apply.

**No rejoin identity** — Peers get a random `client_id` per page load, and
`onConnected` unconditionally appends a new lobby slot
(`client/gameStore.ts:495–506`). A player who refreshes mid-game can't reclaim
their seat even if signalling were still running; a mid-game connection would
actually corrupt `lobbyState`.

## Why "packet drops" break gameplay

To be precise: the data channel itself retransmits lost packets (it's a
default reliable/ordered SCTP channel). What actually kills the game is
**connection-level drops** — a laptop sleeping, a network switch, ICE
failure — combined with the silent-drop send paths above. The two deadlock
scenarios:

1. **Lost peer→host action**: a peer's bet/equation/`resolveDecision` is
   dropped while the channel is down. The host keeps waiting for that player
   to act. No state change occurs, so no rebroadcast occurs, so nothing ever
   heals. The game is permanently stalled for everyone.
2. **Lost host→peer state**: a peer misses a `state` broadcast. Because
   broadcasts are edge-triggered (only on change), the peer stays frozen on
   the previous phase until some *other* player causes a state change — which
   never happens if the game is waiting on the frozen peer.

And once the connection fully drops, `stopPolling` guarantees it stays
dropped.

## Hardening plan

Ordered by impact-per-effort; phases 1–2 fix the stalls, 3 fixes drops, 4–5
are defense in depth.

### Phase 1 — Make state sync level-triggered instead of edge-triggered ✅ IMPLEMENTED

Implemented in `client/protocol.ts` (VersionCounter/VersionGate), `client/gameStore.ts`
(stamping, heartbeat, peer-side gate), and `client/network.ts` (versioned wire types).
Testing infrastructure: `client/transport.ts` (Transport interface),
`client/p2pcfTransport.ts` (production adapter, dynamically imported),
`client/testing/inMemoryTransport.ts` (in-memory lossy transport), and tests in
`client/__tests__/`.

- Add a monotonically increasing `stateVersion` to every
  `state`/`pendingDecision`/`lobby` message (host-side counter in
  `gameStore.ts`, not in `GameState` itself so the engine stays pure).
- Host rebroadcasts current state on a heartbeat (every ~3s, only while a
  game is active). Full-state snapshots are idempotent, so redundant delivery
  is free correctness; the heartbeat doubles as a liveness signal.
- Peers ignore any message with a version ≤ the last one applied. This makes
  missed broadcasts self-heal within one heartbeat and closes deadlock #2.

### Phase 2 — Reliable, deduplicated actions ✅ IMPLEMENTED

Implemented in `client/protocol.ts` (`OutboundActionQueue`, `InboundActionFilter`,
`makeActionId`/`parseActionId`), `client/network.ts` (`ActionMsg` envelope, `ack`
message, `PeerNetwork.sendAction` + retry timer, host-side admission), and
`client/gameStore.ts` (`sendToHost` helper at every peer action site). Tests in
`client/__tests__/protocol.test.ts`, `network.test.ts`, and
`reliableActions.test.ts` (deadlock #1 end-to-end through the host's game logic).

Retry backoff is per queue rather than per action, and each flush resends the
whole queue oldest-first, so the host never has to buffer an out-of-order
counter — anything it can't apply yet ('gap') is dropped and redelivered by the
next retry.

- Wrap `PeerMsg` actions in an envelope:
  `{ actionId: <clientId>:<counter>, playerId, payload }`.
- Host replies with an `ack { actionId }` (and keeps a last-processed counter
  per client to drop duplicates). Peer keeps an outbound queue:
  `PeerNetwork.send` **queues instead of silently dropping** when
  disconnected, and retries unacked actions with backoff until acked. This
  closes deadlock #1.
- Dedup must land *before* retries do, or retried `doBettingAction`s will
  double-apply (a duplicated "call" would act as the next player).

### Phase 3 — Reconnection and seat reclamation ✅ IMPLEMENTED

Implemented in `client/transport.ts` + `client/p2pcfTransport.ts` (`setPollingMode`,
replacing `stopPolling`), `client/identity.ts` (seat token), `client/network.ts`
(`HelloMsg`, `rejected`, `connections`, `onDisconnected`), and
`client/gameStore.ts` (`handleHello`, seat maps, presence stores, host-silence
watchdog). UI: connection dots in `App.svelte`/`Setup.svelte`, a reconnecting
banner, and a rejection message in `NetworkLobby.svelte`. Tests in
`client/__tests__/reconnect.test.ts`.

Two deliberate deviations from the sketch below:

- **sessionStorage, not localStorage**, keyed per room. It survives the reload
  this phase is about, but stays per-tab — with localStorage a second peer tab
  in the same browser would claim the first tab's seat, which breaks local
  playtesting and any household sharing a browser profile.
- **Actions are queued, not disabled**, while disconnected. Phase 2 already
  makes them reliable, so taking the move away would be a downgrade; the banner
  says the move is saved and will send.

Also needed for reload recovery to actually work: `NetworkLobby` now keeps
`?room=` in the address bar instead of clearing it, so refreshing a peer tab
rejoins the room rather than returning to the front page.

- Replace permanent `stopPolling()` with the slow/idle polling rates p2pcf
  already supports (`slowPollingRateMs`/`idlePollingRateMs`), or re-enable
  polling when `peerclose` fires. Tradeoff: modest ongoing Worker traffic in
  exchange for mid-game recovery — worth it; you can tune the idle rate high
  (30–60s).
- Persistent identity: peer generates a token once, stores it in
  `localStorage`, and sends a `hello { token, name }` message on every
  connect. Host maps token → player index. On reconnect, the host restores
  the seat mapping and sends `slotAssignment` + current state instead of
  appending a lobby slot. Guard `onConnected` so unknown connections during
  an active game are rejected (or spectate) rather than mutating
  `lobbyState`.
- UI: a connection indicator per player (driven by the heartbeat and
  `peerclose`); disable/queue action buttons while disconnected so players
  understand why nothing is happening.

### Phase 4 — Action validation and attribution on the host

- Every action carries `playerId`; the host verifies the sending connection
  owns that seat (via the token map) and that the action is legal in the
  current phase — e.g. `doBettingAction` only from the seat at
  `activePlayerIndex`, `doNextRound`/`doDeal` only from the host UI or an
  agreed "any player may advance" rule. Rejected actions get a `nack` + state
  rebroadcast so a stale peer's UI resnaps.
- This also converts the late-delivery hazard into a harmless rejection
  instead of a misapplied bet.

### Phase 5 — Host durability (and the secret-card leak)

- Snapshot `gameState` + seat map to `localStorage` on the host each round so
  a host reload can offer "resume game"; reconnecting peers heal
  automatically via phases 1–3. Full host migration is possible but not worth
  the complexity here — document host-reload-resume as the recovery story.
- While touching the broadcast path, extend `sanitizeStateForPeer` to strip
  *other players' `secretCard`* (and unsubmitted equations) in all phases,
  revealing them only in `results`. Same mechanism as the existing
  `betChoice` sanitization; it fixes cheating-by-devtools, though it does
  make full-state idempotency per-peer rather than global (each peer gets its
  own sanitized snapshot — the broadcast loop at `client/gameStore.ts:103`
  already knows how to do per-peer sends).

## Testing

The repo already has `src/sim/` and a simulation test. Add a network
simulation harness: extract a `Transport` interface from
`HostNetwork`/`PeerNetwork`, and in tests use an in-memory implementation
with injectable message loss, delay, duplication, and disconnect/reconnect
events. Then property-test the invariant that matters: *for any
drop/reorder/reconnect schedule, the game eventually reaches the same
terminal state as the drop-free run, and never deadlocks*. That directly
regression-proofs both stall scenarios.

## Summary

The unifying idea: keep the host-authoritative full-snapshot model — it's the
right architecture for this game — and make it *level-triggered with
acknowledged inputs*, so any single lost message is healed by the next
heartbeat or retry instead of stalling the game forever.
