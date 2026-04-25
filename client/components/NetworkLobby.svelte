<script lang="ts">
  import { setupAsHost, setupAsPeer, generateRoomId, hostProceed, lobbyState, myPlayerIndex, lobbyProceed } from '../gameStore';

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

  // The peer has been assigned a slot when myPlayerIndex is set.
  const peerAssigned = $derived($myPlayerIndex !== null && $myPlayerIndex > 0);

  // Auto-advance when the host broadcasts proceedToSetup.
  $effect(() => { if ($lobbyProceed) oncomplete(); });

  function joinGame() {
    const code = roomInput.trim().toUpperCase();
    if (code.length < 4) { peerError = 'Enter the room code from the host.'; return; }
    peerError = '';
    peerJoined = true;
    setupAsPeer(code, workerUrl.trim() || undefined);
  }

  // ─── Auto-join from invite URL ────────────────────────────────────────────────

  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    const workerParam = params.get('worker') ?? '';
    workerUrl = workerParam;
    roomInput = roomParam.toUpperCase();
    mode = 'peer';
    peerJoined = true;
    setupAsPeer(roomParam.toUpperCase(), workerParam || undefined);
    // Clean up URL bar without adding a history entry.
    history.replaceState(null, '', window.location.pathname);
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
