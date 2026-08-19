<script lang="ts">
  import {
    setupAsHost, setupAsPeer, generateRoomId, hostProceed,
    lobbyState, myPlayerIndex, lobbyProceed, joinRejected,
  } from '../gameStore';

  type Props = { oncomplete: () => void };
  const { oncomplete }: Props = $props();

  type Mode = 'choose' | 'host' | 'peer';
  let mode = $state<Mode>('choose');

  let workerUrl = $state(localStorage.getItem('workerUrl') ?? '');
  $effect(() => { localStorage.setItem('workerUrl', workerUrl); });

  // ─── Host state ───────────────────────────────────────────────────────────────

  let roomId = $state('');

  const inviteUrl = $derived.by(() => {
    if (!roomId) return '';
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('room', roomId);
    if (workerUrl.trim()) url.searchParams.set('worker', workerUrl.trim());
    return url.toString();
  });

  function hostGame() {
    roomId = generateRoomId();
    setupAsHost(roomId, workerUrl.trim() || undefined);
    mode = 'host';
  }

  // Number of remote peers who have connected (lobby has 1 slot per player; index 0 is host).
  const remotePeerCount = $derived($lobbyState.players.length - 1);

  // ─── Peer state ───────────────────────────────────────────────────────────────

  let roomInput = $state('');
  let peerJoined = $state(false);
  let peerError = $state('');
  let connectTimeout: ReturnType<typeof setTimeout> | null = null;

  // The peer has been assigned a slot when myPlayerIndex is set.
  const peerAssigned = $derived($myPlayerIndex !== null && $myPlayerIndex > 0);

  $effect(() => {
    if (peerJoined && !peerAssigned) {
      connectTimeout = setTimeout(() => {
        if (!peerAssigned) {
          peerJoined = false;
          peerError = 'Could not connect after 30 seconds. Check the room code and try again. If both players are on different networks, a custom TURN server may be required.';
        }
      }, 30000);
    } else if (peerAssigned && connectTimeout !== null) {
      clearTimeout(connectTimeout);
      connectTimeout = null;
    }
  });

  // Auto-advance when the host broadcasts proceedToSetup.
  $effect(() => { if ($lobbyProceed) oncomplete(); });

  // The host can refuse a seat — most often because the game already started.
  $effect(() => {
    if ($joinRejected === null) return;
    peerJoined = false;
    peerError = 'That game is already in progress, so no new players can join. '
      + 'Ask the host to finish the round and start a new game.';
  });

  /**
   * Put the room in the address bar (no history entry), so reloading the tab
   * re-joins instead of dumping the player back at the front page.  Together
   * with the per-tab seat token this is what makes a refresh recoverable: the
   * peer rejoins the same room and the host hands back the same seat.
   */
  function keepRoomInUrl(code: string, worker: string) {
    const url = new URL(window.location.href);
    url.search = '';
    url.searchParams.set('room', code);
    if (worker) url.searchParams.set('worker', worker);
    history.replaceState(null, '', url.toString());
  }

  function joinGame() {
    const code = roomInput.trim().toUpperCase();
    if (code.length < 4) { peerError = 'Enter the room code from the host.'; return; }
    peerError = '';
    peerJoined = true;
    const worker = workerUrl.trim();
    setupAsPeer(code, worker || undefined);
    keepRoomInUrl(code, worker);
  }

  // ─── Auto-join from invite URL (or from a reload) ─────────────────────────────

  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    const workerParam = params.get('worker') ?? '';
    const code = roomParam.toUpperCase();
    workerUrl = workerParam;
    roomInput = code;
    mode = 'peer';
    peerJoined = true;
    setupAsPeer(code, workerParam || undefined);
    keepRoomInUrl(code, workerParam);
  }

  // ─── Clipboard helper ────────────────────────────────────────────────────────

  let copyFeedback = $state('');

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copyFeedback = 'Copied!';
      setTimeout(() => { copyFeedback = ''; }, 1500);
    } catch {
      copyFeedback = 'Copy failed — select and copy manually.';
    }
  }
</script>

<section>
  <h2>Network Setup</h2>

  {#if mode === 'choose'}
    <p>
      <strong>Host</strong> creates a room and shares the code with other players.
      <strong>Join</strong> connects to an existing host using their room code.
    </p>
    <details>
      <summary>Advanced</summary>
      <label>
        Custom worker URL (optional)
        <br />
        <input
          type="url"
          bind:value={workerUrl}
          placeholder="https://your-worker.workers.dev"
          style="width: 24em;"
        />
      </label>
    </details>
    <br />
    <button type="button" onclick={hostGame}>Host a game</button>
    <button type="button" onclick={() => { mode = 'peer'; }}>Join a game</button>
    <button type="button" onclick={oncomplete}>Play without networking</button>

  {:else if mode === 'host'}
    <h3>Hosting</h3>
    <p>Share this room code with players who want to join:</p>

    <p style="font-size: 2em; font-weight: bold; letter-spacing: 0.15em;">{roomId}</p>
    <button type="button" onclick={() => copyToClipboard(roomId)}>Copy code</button>
    <button type="button" onclick={() => copyToClipboard(inviteUrl)}>Copy invite link</button>
    {#if copyFeedback}<span aria-live="polite"> {copyFeedback}</span>{/if}

    <p>
      {#if remotePeerCount === 0}
        <em>Waiting for players to join…</em>
      {:else}
        {remotePeerCount} player{remotePeerCount !== 1 ? 's' : ''} connected.
      {/if}
    </p>

    <button type="button" onclick={() => { hostProceed(); oncomplete(); }}>Done — proceed to game setup</button>

  {:else}
    <!-- peer mode -->
    <h3>Joining</h3>

    {#if !peerJoined}
      <label>
        Room code:
        <br />
        <input
          type="text"
          bind:value={roomInput}
          placeholder="e.g. AB3X7K"
          style="font-size: 1.5em; letter-spacing: 0.1em; text-transform: uppercase;"
          maxlength="6"
        />
      </label>
      <br />
      <button type="button" disabled={!roomInput.trim()} onclick={joinGame}>Join</button>

      {#if peerError}
        <p role="alert">{peerError}</p>
      {/if}
    {:else if peerAssigned}
      <p>Connected! Waiting for the host to start the game…</p>
    {:else}
      <p><em>Connecting to room {roomInput.trim().toUpperCase()}…</em></p>
    {/if}
  {/if}
</section>
