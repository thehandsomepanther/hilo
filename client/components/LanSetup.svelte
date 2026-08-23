<script lang="ts">
  /**
   * Local-wifi multiplayer: two devices on the same network, introduced by QR
   * code because there is no signalling server to do it.
   *
   * The exchange is two scans per player — host shows an invite, the player
   * scans it and shows back a reply, the host scans that — and it has to be
   * repeated for each additional player, since every connection needs its own
   * offer and answer.
   */
  import {
    setupAsHost, setupAsPeer, hostProceed, generateRoomId,
    lobbyState, myPlayerIndex, lobbyFull, MAX_PLAYERS,
  } from '../gameStore';
  import { LanHostTransport, LanPeerTransport, unmaskLocalCandidates, peekPayload } from '../lanTransport';
  import QrCode from './QrCode.svelte';
  import QrScanner from './QrScanner.svelte';

  type Props = { oncomplete: () => void; onback: () => void };
  const { oncomplete, onback }: Props = $props();

  type Step =
    | 'choose'
    | 'host-preparing' | 'host-invite' | 'host-scanning'
    | 'join-scanning' | 'join-preparing' | 'join-reply';

  let step = $state<Step>('choose');
  let error = $state('');
  let busy = $state(false);

  let hostTransport: LanHostTransport | null = null;
  let peerTransport: LanPeerTransport | null = null;
  let inviteCode = $state('');
  let replyCode = $state('');

  /** Players who have completed the exchange (host side); seat 0 is the host. */
  const connectedPlayers = $derived($lobbyState.players.length - 1);

  /** Peer side: the host has given us a seat. */
  const seated = $derived($myPlayerIndex !== null && $myPlayerIndex > 0);

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // ─── Host ───────────────────────────────────────────────────────────────────

  async function startHosting() {
    busy = true;
    error = '';
    try {
      const sessionId = generateRoomId();
      hostTransport = new LanHostTransport(sessionId);
      step = 'host-preparing';

      // Order matters: holding camera permission is what makes the browser put
      // real local IPs in the SDP instead of mDNS names that a hotspot may not
      // resolve.  Candidates are gathered by createInvite(), so priming has to
      // happen first — see unmaskLocalCandidates().
      await unmaskLocalCandidates();
      await setupAsHost(sessionId, undefined, hostTransport);

      inviteCode = await hostTransport.createInvite();
      step = 'host-invite';
    } catch (e) {
      error = message(e);
      step = 'choose';
    } finally {
      busy = false;
    }
  }

  async function nextInvite() {
    if (!hostTransport) return;
    busy = true;
    error = '';
    try {
      inviteCode = await hostTransport.createInvite();
      step = 'host-invite';
    } catch (e) {
      error = message(e);
    } finally {
      busy = false;
    }
  }

  async function onReplyScanned(text: string) {
    if (!hostTransport) return;
    busy = true;
    try {
      await hostTransport.acceptAnswer(text);
      error = '';
      // The seat itself is granted by `hello` over the new channel, so the
      // player count catches up a moment later.
      step = 'host-invite';
    } catch (e) {
      error = message(e);
      step = 'host-invite';
    } finally {
      busy = false;
    }
  }

  // ─── Join ───────────────────────────────────────────────────────────────────

  async function onInviteScanned(text: string) {
    busy = true;
    step = 'join-preparing';
    try {
      const payload = await peekPayload(text);
      if (payload.t !== 'offer') throw new Error("That's a reply code, not an invite.");

      // Set up the peer before building the connection, so the network layer's
      // handlers are attached before the channel can open.
      peerTransport = new LanPeerTransport();
      await setupAsPeer(payload.s, undefined, peerTransport);

      replyCode = await peerTransport.acceptInvite(text);
      error = '';
      step = 'join-reply';
    } catch (e) {
      error = message(e);
      step = 'join-scanning';
    } finally {
      busy = false;
    }
  }
</script>

<section>
  <h2>Play over local wifi</h2>

  {#if step === 'choose'}
    <p>
      For two or more devices on the same wifi or hotspot with <strong>no
      internet</strong> — a plane, a car, a hotel with a captive portal. The
      devices introduce each other by camera instead of over the network, so
      you'll scan a code on each phone.
    </p>
    <p>
      <em>Both devices must be on the same network, and each needs a camera.</em>
    </p>

    {#if error}<p role="alert">{error}</p>{/if}

    <button type="button" disabled={busy} onclick={startHosting}>Host on this device</button>
    <button type="button" disabled={busy} onclick={() => { error = ''; step = 'join-scanning'; }}>
      Join someone's game
    </button>
    <button type="button" onclick={onback}>Back</button>

  {:else if step === 'host-preparing'}
    <p><em>Preparing the invite…</em></p>
    <p>If your browser asks for the camera, allow it — it's needed both to read
      the other device's reply and to make the direct connection work.</p>

  {:else if step === 'host-invite'}
    <h3>Step 1 — show this to the next player</h3>
    <p>Have them open Equation Hi-Lo, choose <strong>Play over local wifi →
      Join someone's game</strong>, and scan this code.</p>

    <QrCode data={inviteCode} label="Invite code" />

    {#if error}<p role="alert">{error}</p>{/if}

    <p>
      {#if connectedPlayers === 0}
        <em>No players connected yet.</em>
      {:else}
        <strong>{connectedPlayers}</strong>
        player{connectedPlayers === 1 ? '' : 's'} connected.
      {/if}
    </p>

    <button type="button" disabled={busy} onclick={() => { error = ''; step = 'host-scanning'; }}>
      Step 2 — scan their reply
    </button>

    {#if connectedPlayers > 0}
      <button type="button" disabled={busy || $lobbyFull} onclick={nextInvite}>
        Add another player
      </button>
      <button type="button" onclick={() => { hostProceed(); oncomplete(); }}>
        Done — proceed to game setup
      </button>
    {/if}

    {#if $lobbyFull}
      <p><em>Table is full — one deck seats {MAX_PLAYERS} players.</em></p>
    {/if}

  {:else if step === 'host-scanning'}
    <h3>Step 2 — scan the player's reply</h3>
    <p>They should be showing a code back to you now.</p>
    <QrScanner onscan={onReplyScanned} oncancel={() => { step = 'host-invite'; }} />

  {:else if step === 'join-scanning'}
    <h3>Scan the host's invite</h3>
    <p>Point your camera at the code on the host's screen.</p>
    {#if error}<p role="alert">{error}</p>{/if}
    <QrScanner onscan={onInviteScanned} oncancel={() => { step = 'choose'; }} />

  {:else if step === 'join-preparing'}
    <p><em>Connecting…</em></p>

  {:else if step === 'join-reply'}
    <h3>Show this back to the host</h3>
    <p>The host now scans this code from your screen.</p>

    <QrCode data={replyCode} label="Reply code" />

    {#if error}<p role="alert">{error}</p>{/if}

    {#if seated}
      <p><strong>Connected!</strong> Waiting for the host to start the game…</p>
    {:else}
      <p><em>Waiting for the host to scan this…</em></p>
    {/if}
  {/if}
</section>
