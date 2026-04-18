<script lang="ts">
  import { initGame } from '../gameStore';

  let playerNames = $state(['', '']);
  let startingChips = $state(50);
  let forcedBetAmount = $state(1);
  let error = $state('');

  function addPlayer() {
    playerNames = [...playerNames, ''];
  }

  function removePlayer(i: number) {
    playerNames = playerNames.filter((_, idx) => idx !== i);
  }

  function start() {
    const names = playerNames.map((n) => n.trim()).filter(Boolean);
    if (names.length < 2) {
      error = 'At least 2 player names are required.';
      return;
    }
    if (new Set(names).size !== names.length) {
      error = 'Player names must be unique.';
      return;
    }
    error = '';
    initGame(names, startingChips, forcedBetAmount);
  }
</script>

<section>
  <h2>New Game</h2>

  <fieldset>
    <legend>Players</legend>
    {#each playerNames as _, i}
      <label>
        Player {i + 1}
        <input
          type="text"
          bind:value={playerNames[i]}
          placeholder="Name"
          required
        />
      </label>
      {#if playerNames.length > 2}
        <button type="button" onclick={() => removePlayer(i)}>Remove</button>
      {/if}
      <br />
    {/each}
    <button type="button" onclick={addPlayer}>+ Add player</button>
  </fieldset>

  <fieldset>
    <legend>Settings</legend>
    <label>
      Starting chips per player
      <input type="number" bind:value={startingChips} min="1" />
    </label>
    <br />
    <label>
      Forced bet (ante)
      <input type="number" bind:value={forcedBetAmount} min="1" />
    </label>
  </fieldset>

  {#if error}
    <p role="alert">{error}</p>
  {/if}

  <button type="button" onclick={start}>Start Game</button>
</section>
