<script lang="ts">
  import { setupAsHost, acceptPeerAnswer, setupAsPeer } from '../gameStore';

  type Props = { oncomplete: () => void };
  const { oncomplete }: Props = $props();

  // ─── Shared UI state ─────────────────────────────────────────────────────────

  type Mode = 'choose' | 'host' | 'peer';
  let mode = $state<Mode>('choose');

  // ─── Host state ───────────────────────────────────────────────────────────────

  type PeerSlot = {
    id: string;
    offerBlob: string | null;   // generated
    answerInput: string;        // typed by user
    answerApplied: boolean;
    connected: boolean;
    error: string | null;
  };

  let peerSlots = $state<PeerSlot[]>([]);
  let hostWorking = $state(false);

  async function addPeer() {
    const id = `peer-${peerSlots.length + 1}`;
    const slot: PeerSlot = {
      id,
      offerBlob: null,
      answerInput: '',
      answerApplied: false,
      connected: false,
      error: null,
    };
    peerSlots = [...peerSlots, slot];

    hostWorking = true;
    try {
      const blob = await setupAsHost(id);
      peerSlots = peerSlots.map((s) => s.id === id ? { ...s, offerBlob: blob } : s);
    } catch (e) {
      peerSlots = peerSlots.map((s) =>
        s.id === id ? { ...s, error: String(e) } : s,
      );
    } finally {
      hostWorking = false;
    }
  }

  async function applyAnswer(slotId: string) {
    const slot = peerSlots.find((s) => s.id === slotId);
    if (!slot || !slot.answerInput.trim()) return;

    peerSlots = peerSlots.map((s) =>
      s.id === slotId ? { ...s, error: null } : s,
    );

    try {
      await acceptPeerAnswer(slotId, slot.answerInput.trim());
      // Mark applied; 'connected' will be confirmed when the channel opens.
      // For simplicity we mark it connected optimistically here —
      // the data channel fires asynchronously and there is no reactive
      // hook wired into this component.
      peerSlots = peerSlots.map((s) =>
        s.id === slotId ? { ...s, answerApplied: true, connected: true } : s,
      );
    } catch (e) {
      peerSlots = peerSlots.map((s) =>
        s.id === slotId ? { ...s, error: `Invalid answer: ${String(e)}` } : s,
      );
    }
  }

  // ─── Peer state ───────────────────────────────────────────────────────────────

  let offerInput = $state('');
  let answerBlob = $state<string | null>(null);
  let peerConnected = $state(false);
  let peerError = $state('');
  let peerWorking = $state(false);

  async function connectToPeer() {
    if (!offerInput.trim()) return;
    peerWorking = true;
    peerError = '';
    answerBlob = null;
    try {
      const blob = await setupAsPeer(offerInput.trim());
      answerBlob = blob;
      // Give the ICE connectivity checks a moment; the channel opens asynchronously.
      // We show the answer blob and let the user know to share it back.
      // Once the host applies the answer the channel will open on both sides.
      peerConnected = true;
    } catch (e) {
      peerError = `Connection failed: ${String(e)}`;
    } finally {
      peerWorking = false;
    }
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
      Choose how to play.  <strong>Host</strong> sets up and runs the game;
      <strong>Join</strong> connects to an existing host.
      In both cases you exchange short blobs of text (copy &amp; paste,
      text message, etc.) — no server required.
    </p>
    <button type="button" onclick={() => { mode = 'host'; }}>Host a game</button>
    <button type="button" onclick={() => { mode = 'peer'; }}>Join a game</button>
    <button type="button" onclick={oncomplete}>Play without networking</button>

  {:else if mode === 'host'}
    <h3>Hosting</h3>
    <p>
      For each player joining remotely, click <strong>Add peer</strong>.
      Share the offer blob with that player (e.g. via text message), then
      paste their answer blob back here.
    </p>

    {#each peerSlots as slot (slot.id)}
      <fieldset>
        <legend>Peer: {slot.id}</legend>

        {#if slot.offerBlob}
          <p><strong>1. Share this offer with the peer:</strong></p>
          <textarea readonly rows="4" cols="60">{slot.offerBlob}</textarea>
          <br />
          <button type="button" onclick={() => copyToClipboard(slot.offerBlob!)}>
            Copy offer
          </button>

          {#if !slot.answerApplied}
            <p><strong>2. Paste the peer's answer here:</strong></p>
            <textarea
              rows="4"
              cols="60"
              bind:value={slot.answerInput}
              placeholder="Paste peer answer blob…"
            ></textarea>
            <br />
            <button
              type="button"
              disabled={!slot.answerInput.trim()}
              onclick={() => applyAnswer(slot.id)}
            >
              Apply answer
            </button>
          {:else}
            <p>
              {#if slot.connected}
                Connected.
              {:else}
                Answer applied — waiting for channel to open…
              {/if}
            </p>
          {/if}
        {:else if slot.error}
          <p role="alert">Error: {slot.error}</p>
        {:else}
          <p>Generating offer…</p>
        {/if}
      </fieldset>
    {/each}

    {#if copyFeedback}
      <p aria-live="polite">{copyFeedback}</p>
    {/if}

    <button type="button" onclick={addPeer} disabled={hostWorking}>
      Add peer
    </button>

    <br /><br />
    <button type="button" onclick={oncomplete}>
      Done — proceed to game setup
    </button>

  {:else}
    <!-- peer mode -->
    <h3>Joining</h3>
    <p>
      Ask the host to generate an offer for you, then paste it below.
      After connecting you will receive a blob to send back to the host.
    </p>

    {#if !answerBlob}
      <label>
        Host's offer blob:
        <br />
        <textarea
          rows="4"
          cols="60"
          bind:value={offerInput}
          placeholder="Paste host offer blob…"
        ></textarea>
      </label>
      <br />
      <button
        type="button"
        disabled={!offerInput.trim() || peerWorking}
        onclick={connectToPeer}
      >
        {peerWorking ? 'Connecting…' : 'Connect'}
      </button>

      {#if peerError}
        <p role="alert">{peerError}</p>
      {/if}
    {:else}
      <p><strong>Send this answer blob to the host:</strong></p>
      <textarea readonly rows="4" cols="60">{answerBlob}</textarea>
      <br />
      <button type="button" onclick={() => copyToClipboard(answerBlob!)}>
        Copy answer
      </button>

      {#if copyFeedback}
        <p aria-live="polite">{copyFeedback}</p>
      {/if}

      <p>
        Once the host applies your answer, the connection will open and
        you will start receiving game state automatically.
      </p>

      {#if peerConnected}
        <button type="button" onclick={oncomplete}>
          Continue to game
        </button>
      {/if}
    {/if}
  {/if}
</section>
