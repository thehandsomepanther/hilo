<script lang="ts">
  import { lobbyState, myPlayerIndex, networkMode, updateLobbyName, initGame, addBot } from '../gameStore';

  let error = $state('');

  // ─── Derived conveniences ─────────────────────────────────────────────────

  const isStandalone = $derived($networkMode === 'standalone');
  const isHost      = $derived($networkMode === 'host');
  const isPeer      = $derived($networkMode === 'peer');
  const canStart    = $derived(isStandalone || isHost);

  /** True when this slot index is the one this client controls. */
  function isMine(i: number): boolean {
    return isStandalone || $myPlayerIndex === i;
  }

  // ─── Standalone-only: add / remove player slots ────────────────────────────

  function addPlayer() {
    lobbyState.update((s) => ({ ...s, players: [...s.players, { name: '', isBot: false }] }));
  }

  function removePlayer(i: number) {
    lobbyState.update((s) => ({
      ...s,
      players: s.players.filter((_, idx) => idx !== i),
    }));
  }

  // ─── Start game ───────────────────────────────────────────────────────────

  function start() {
    const names = $lobbyState.players.map((p) => p.name.trim());
    if (names.some((n) => !n)) {
      error = 'All players must have a name before starting.';
      return;
    }
    if (new Set(names).size !== names.length) {
      error = 'Player names must be unique.';
      return;
    }
    if (names.length < 2) {
      error = 'At least 2 players are required.';
      return;
    }
    error = '';
    initGame(names, $lobbyState.startingChips, $lobbyState.forcedBetAmount);
  }
</script>

<section>
  <h2>New Game</h2>

  <!-- ── Player name list ──────────────────────────────────────────────────── -->
  <fieldset>
    <legend>Players</legend>

    {#each $lobbyState.players as player, i}
      <label>
        {#if player.isBot}
          <strong>Player {i + 1} (Bot)</strong>
        {:else if isMine(i)}
          <strong>Player {i + 1} (you)</strong>
        {:else}
          Player {i + 1}
        {/if}

        {#if player.isBot && canStart}
          <!-- Bots get an editable name field on the host/standalone side -->
          <input
            type="text"
            value={player.name}
            placeholder="Bot name"
            oninput={(e) => updateLobbyName(i, (e.target as HTMLInputElement).value)}
          />
        {:else if isMine(i)}
          <input
            type="text"
            value={player.name}
            placeholder="Your name"
            required
            oninput={(e) => updateLobbyName(i, (e.target as HTMLInputElement).value)}
          />
        {:else}
          <input
            type="text"
            value={player.name || (player.isBot ? '(bot)' : '(waiting for player…)')}
            readonly
            disabled
          />
        {/if}
      </label>

      {#if $lobbyState.players.length > 1 && (isStandalone || (canStart && player.isBot))}
        <button type="button" onclick={() => removePlayer(i)}>Remove</button>
      {/if}
      <br />
    {/each}

    {#if isStandalone}
      <button type="button" onclick={addPlayer}>+ Add player</button>
      <button type="button" onclick={addBot}>+ Add bot</button>
    {:else if isHost}
      <button type="button" onclick={addBot}>+ Add bot</button>
      <p><em>Human players join by connecting via the network lobby.</em></p>
    {/if}
  </fieldset>

  <!-- ── Game settings — host and standalone only ──────────────────────────── -->
  {#if canStart}
    <fieldset>
      <legend>Settings</legend>
      <label>
        Starting chips per player
        <input
          type="number"
          value={$lobbyState.startingChips}
          min="1"
          oninput={(e) => lobbyState.update((s) => ({
            ...s,
            startingChips: Number((e.target as HTMLInputElement).value),
          }))}
        />
      </label>
      <br />
      <label>
        Forced bet (ante)
        <input
          type="number"
          value={$lobbyState.forcedBetAmount}
          min="1"
          oninput={(e) => lobbyState.update((s) => ({
            ...s,
            forcedBetAmount: Number((e.target as HTMLInputElement).value),
          }))}
        />
      </label>
    </fieldset>
  {:else}
    <!-- Peer: show read-only settings so they know what game they're joining -->
    <fieldset>
      <legend>Settings</legend>
      <p>Starting chips: <strong>{$lobbyState.startingChips}</strong></p>
      <p>Forced bet (ante): <strong>{$lobbyState.forcedBetAmount}</strong></p>
    </fieldset>
  {/if}

  <!-- ── Error / status ────────────────────────────────────────────────────── -->
  {#if error}
    <p role="alert">{error}</p>
  {/if}

  {#if canStart}
    <button type="button" onclick={start}>Start Game</button>
  {:else}
    <p><em>Waiting for the host to start the game…</em></p>
  {/if}
</section>
