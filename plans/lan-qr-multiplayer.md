# LAN Multiplayer by QR Exchange — Equation Hi-Lo

> **Status:** built and reachable from the home screen as **Play over local wifi
> (QR)**. Verified between two browsers on one machine: handshake, seat
> assignment, state sync both directions, and the QR decoding back through jsQR.
> **Not yet verified on real phones over a real hotspot** — that is the open
> question, and the reason it exists. See "What to watch for on real phones".

## What this is for

Two or more devices on the same network with no internet — a hotspot, a plane,
a conference wifi with no upstream. p2pcf can't help: its signalling is an HTTP
POST to a Cloudflare Worker (`node_modules/p2pcf/src/p2pcf.js:383`, `:407`) and
it has no LAN discovery. The data path would be fine — both devices are on one
subnet, so ICE settles on host candidates with no STUN or TURN. Only the
*introduction* is missing, so we do it by hand: the two devices show each other
QR codes.

## The good news: the seam already exists

`setupAsHost` and `setupAsPeer` both take an optional injected transport
(`client/gameStore.ts:920`, `:964`) — the parameter the in-memory test transport
already uses. A LAN transport goes in through that same door with **no changes
to gameStore, network.ts, or protocol.ts**.

`Transport` (`client/transport.ts:28-52`) is eight members: `clientId`, three
callbacks (`onPeerConnect`/`onPeerClose`/`onMessage`), `start`, `send`,
`broadcast`, `setPollingMode`, `wake`, `close`. Over a raw `RTCPeerConnection`
plus one `RTCDataChannel` that is roughly 200 lines, and two of the members
(`setPollingMode`, `wake`) become no-ops because there is no signalling channel
left to modulate.

Everything above the transport keeps working as-is, and that is most of the
value: versioned snapshots, the acked/deduplicated action queue, seat identity
by token (`handleHello`, `client/gameStore.ts:429`), the heartbeat, the
per-seat connection dots. None of it knows how bytes arrive.

Two conventions the new transport has to honour:

- The host's `clientId` must be `HOST_CLIENT_ID`, because `PeerNetwork` ignores
  every peer whose id isn't exactly that (`client/network.ts:270`, `:283`).
- p2pcf handed out mesh client ids for free. With manual signalling there is no
  mesh, so each peer has to generate its own id (`generateClientId()`) and carry
  it *inside* the QR payload, since the host has no other way to learn it.

## Measured, not assumed: it fits in one QR code

I generated a real LAN-only offer/answer in Chrome with `iceServers: []`:

| | offer | answer |
|---|---|---|
| raw SDP | 715 B | 713 B |
| deflate | 472 B | 472 B |
| deflate + base64 | **632 chars** | **632 chars** |

A version-40 QR holds 2953 bytes at L error correction, so 632 chars is not
close to the limit — it lands around version 20, which scans comfortably off a
phone screen. No multi-frame animation, no SDP munging, no custom compact
encoding needed.

Compression needs no library either: browsers ship `CompressionStream`
('deflate-raw'), Safari included since 16.4.

## The finding that decides whether this works on a hotspot

By default Chrome hides local IPs behind mDNS: the candidates come out as
`fc6ac57f-….local`, and the far side has to resolve that over multicast DNS.
Multicast is exactly what phone hotspots and locked-down APs like to drop, so
this is the difference between "works on a plane" and "works on my desk".

Chrome stops obfuscating once the page holds camera or microphone permission —
and **the QR scanner needs the camera anyway**. Measured, with permission as the
only variable:

```
camera NOT granted → 2 candidates — 2 mDNS .local, 0 real IPv4
camera GRANTED     → 4 candidates — 0 mDNS,        2 real IPv4 (192.168.1.144, + IPv6)
```

So the flow gets a real LAN address for free, provided the ordering is right:
**call `getUserMedia` before creating the offer or answer.** Build the offer
first and you have already gathered mDNS candidates, and the permission comes
too late to help. This is the single most important implementation detail here,
and the easiest one to get backwards.

(Caveat worth stating: this was measured on Chrome/macOS. Safari's candidate
policy is its own thing and needs checking on a real iPhone before anyone
promises this works there.)

## What has to be built

1. **`client/lanTransport.ts`** — `Transport` over `RTCPeerConnection`. Host
   holds one connection per peer keyed by the peer's id; peer holds exactly one,
   labelled `HOST_CLIENT_ID`. `broadcast` fans out over the map. Non-trickle:
   wait for `iceGatheringState === 'complete'` so a single blob carries every
   candidate. `iceServers: []` so gathering never stalls on unreachable STUN.

2. **SDP codec** — `deflate-raw` via `CompressionStream` + base64url, plus the
   peer id and a session id. ~30 lines, no dependency.

3. **QR in and out** — encoding needs a small generator (`qrcode-generator`,
   ~20 KB). Decoding is `BarcodeDetector` on Chrome/Android, with `jsQR`
   (~45 KB) for Safari, which has no `BarcodeDetector`. Both must be precached
   or the offline case fails at the worst moment; call it ~65 KB onto the
   current 232 KB precache.

4. **A scan wizard in `NetworkLobby`** — a third mode beside host/join. Host:
   request camera → show offer QR → scan the peer's answer → connected. Peer:
   request camera → scan offer → show answer QR → connected. Repeat per
   additional player, which is the scaling cost: N−1 exchanges of two scans
   each. Fine at two players, tiresome at four.

5. **A seat-identity key** — `identity.ts` keys the seat token by room id
   (`client/identity.ts:25-26`), and a LAN session has no room id. Generate one
   host-side and put it in the offer payload; it then does double duty as the
   session id that stops a stale QR from being scanned into the wrong game.

6. **Reconnection UX** — see below.

## The real regression: refresh means rescan

`setPollingMode` and `wake` stop meaning anything, and polling is what the
existing design leans on for recovery (`client/transport.ts:16-25`). Worth being
precise about what actually breaks, because it is narrower than it sounds:

- **A brief network blip is fine.** ICE recovers a `disconnected` connection on
  its own without re-signalling, and once the channel is back the message layer
  resyncs by itself — the host's heartbeat rebroadcasts versioned snapshots and
  the peer's queue flushes its unacked actions. No new work.
- **A page reload is not fine.** The `RTCPeerConnection` dies with the page and
  there is no signalling channel to rebuild it, so the peer must rescan. Under
  p2pcf a refresh recovers by itself; here it costs a QR exchange. The seat
  survives — `sessionStorage` keeps the token and `handleHello` hands back the
  same seat, chips and cards — so it is an interruption, not a lost game.

So the honest UX is: on disconnect, the host shows a fresh QR and a "rescan to
reconnect" prompt. Worth building deliberately rather than discovering later,
and worth telling players up front, because "don't refresh" is a real
constraint that p2pcf mode doesn't have.

## Testing

The message layer is already covered by `InMemoryTransport`, and none of it
changes. What is new and worth testing:

- SDP codec round-trip — plain vitest.
- Transport peer lifecycle — vitest with a faked `RTCPeerConnection`; Node has
  no WebRTC, so a real one can't run there.
- The actual two-browser handshake — a Playwright harness with two pages,
  passing the SDP blob between them directly (skipping the camera). That proves
  the transport and the codec without needing to point one webcam at another
  screen. The QR encode/decode step is then the only manually-tested link, and a
  unit test covering "encode then decode returns the same bytes" narrows even
  that.

## What to watch for on real phones

The build is verified between two desktop browsers. Everything below is what
that setup *cannot* tell us, roughly in order of how likely it is to bite.

**Test against the deployed HTTPS URL, not a LAN dev server.** `getUserMedia`
requires a secure origin, so `http://192.168.x.x:5173` will fail on the phone
with a camera error that looks like a bug in this feature. Commit (the
pre-commit hook rebuilds `docs/`) and use the GitHub Pages URL.

**Scanning density.** The invite is ~740 characters → QR version 19, 93×93
modules. That decodes perfectly from a synthetic bitmap at every size tested,
but a synthetic bitmap has no glare, no moiré between two pixel grids, and no
hand shake. The code renders at `min(92vw, 420px)` for exactly this reason —
maximum millimetres per module. If scanning proves fiddly in the hand, the
lever with the most headroom left is shrinking the payload: strip the SDP to
its interesting fields (ufrag, pwd, fingerprint, candidates) and rebuild it on
the far side, which should roughly halve it and drop several QR versions. That
is browser-specific and fragile, which is why it is the fallback rather than
the starting point.

**Safari's ICE behaviour.** The mDNS-versus-real-IP finding was measured on
Chrome. Safari has its own candidate policy, and if it publishes `.local`
candidates regardless of camera permission, the connection depends on multicast
working across the hotspot — which is exactly what phone hotspots tend to drop.
This is the single biggest unknown. Worth checking first, by hosting on one
phone and reading the offer's candidates.

**iOS hotspot client isolation.** Even with real IPs in the SDP, some hotspot
implementations refuse to route traffic between two clients. Nothing in the app
can fix that; it would mean the feature works on a wifi network but not on a
phone hotspot, which is worth knowing before promising it.

**Camera permission inside an installed PWA.** iOS grants permission per page
session, and a home-screen PWA is its own context. If a prompt appears at an
awkward moment, the fix is where `unmaskLocalCandidates()` is called, not what
it does.

**Backgrounding.** Switching apps to read a code, or the screen locking mid
exchange, may suspend the page and kill a half-built connection. The wizard can
be restarted, but if this happens routinely the flow needs to hold the offer
across a suspend.

## Effort spent, and what is left

The build came in around the estimate. What remains is not code: it is an hour
with two phones on a hotspot, answering the Safari question first. If Safari
publishes real candidates and the hotspot routes between clients, this works;
if either fails, the fallbacks are payload shrinking (density) and accepting
wifi-but-not-hotspot (isolation).

Still missing by design, carried over from the plan: **reconnection**. A brief
drop heals itself, but a page reload needs a fresh QR exchange, and there is
currently no UI saying so — the peer just shows the standard "Reconnecting to
the host…" banner forever. That wants a "rescan to reconnect" path before this
is something to hand to other people.
