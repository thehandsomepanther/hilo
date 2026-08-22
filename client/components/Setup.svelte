<script lang="ts">
  import {
    lobbyState, myPlayerIndex, networkMode, seatOnline, lobbyFull, MAX_PLAYERS,
    addPlayer, removePlayer, updateLobbyName, updateStartingChips, updateEnforceTimeLimit,
    initGame, addBot, updateBotDifficulty,
    BOT_DIFFICULTIES, DEFAULT_BOT_DIFFICULTY, difficultyLabel,
  } from '../gameStore';
  import type { BotDifficulty } from '../gameStore';

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
    if (names.length > MAX_PLAYERS) {
      error = `At most ${MAX_PLAYERS} players are supported — the deck runs out of number cards beyond that.`;
      return;
    }
    error = '';
    initGame(names, $lobbyState.startingChips, $lobbyState.enforceTimeLimit);
  }
</script>

<section>
  <h2>New Game</h2>

  <!-- ── Player name list ──────────────────────────────────────────────────── -->
  <fieldset>
    <legend>Players</legend>

    {#each $lobbyState.players as player, i}
      {@const online = $seatOnline[i] ?? true}
      <label>
        {#if !isStandalone}
          <span
            style={online ? 'color: #2a8a2a;' : 'color: #b00;'}
            title={online ? 'Connected' : 'Disconnected — reconnecting'}
          >{online ? '●' : '○'}</span>
        {/if}
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
          <select
            aria-label="{player.name || `Bot ${i + 1}`} difficulty"
            value={player.difficulty ?? DEFAULT_BOT_DIFFICULTY}
            onchange={(e) => updateBotDifficulty(i, (e.target as HTMLSelectElement).value as BotDifficulty)}
          >
            {#each BOT_DIFFICULTIES as level}
              <option value={level}>{difficultyLabel(level)}</option>
            {/each}
          </select>
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
          {#if player.isBot}
            <!-- Peers can't set it, but they should know what is at the table -->
            <em>({difficultyLabel(player.difficulty ?? DEFAULT_BOT_DIFFICULTY)})</em>
          {/if}
        {/if}
      </label>

      {#if $lobbyState.players.length > 1 && (isStandalone || (canStart && player.isBot))}
        <button type="button" onclick={() => removePlayer(i)}>Remove</button>
      {/if}
      <br />
    {/each}

    {#if isStandalone}
      <button type="button" onclick={addPlayer} disabled={$lobbyFull}>+ Add player</button>
      <button type="button" onclick={addBot} disabled={$lobbyFull}>+ Add bot</button>
    {:else if isHost}
      <button type="button" onclick={addBot} disabled={$lobbyFull}>+ Add bot</button>
      <p><em>Human players join by connecting via the network lobby.</em></p>
    {/if}

    {#if $lobbyFull}
      <p><em>Table is full — one deck seats {MAX_PLAYERS} players.</em></p>
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
          oninput={(e) => updateStartingChips(Number((e.target as HTMLInputElement).value))}
        />
      </label>
      <br />
      <label>
        <input
          type="checkbox"
          checked={$lobbyState.enforceTimeLimit}
          onchange={(e) => updateEnforceTimeLimit((e.target as HTMLInputElement).checked)}
        />
        Enforce time limit (players who miss the deadline cannot bet on unsubmitted pots)
      </label>
      <br />
      <p><em>Forced bet starts at 1 and increases by 1 each round.</em></p>
    </fieldset>
  {:else}
    <!-- Peer: show read-only settings so they know what game they're joining -->
    <fieldset>
      <legend>Settings</legend>
      <p>Starting chips: <strong>{$lobbyState.startingChips}</strong></p>
      <p>Time limit enforcement: <strong>{$lobbyState.enforceTimeLimit ? 'on' : 'off'}</strong></p>
      <p>Forced bet increases by 1 each round (round 1 = 1 chip).</p>
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
