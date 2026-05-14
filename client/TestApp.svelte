<script lang="ts">
  import GameOver from './components/GameOver.svelte';
  import { seedGameOver } from './debugSeed';

  const SEEDS: Record<string, () => void> = {
    'game-over (3 players, 10 rounds)': seedGameOver,
  };

  let current = $state(Object.keys(SEEDS)[0]!);

  function load() {
    SEEDS[current]!();
  }

  // Load the first seed immediately so the screen isn't blank on arrival.
  seedGameOver();
</script>

<header style="background:#ffefc0; padding:0.5rem 1rem; border-bottom:2px solid #e6b800;">
  <strong>Debug — game-over screen</strong>
  <select bind:value={current} style="margin-left:1rem;">
    {#each Object.keys(SEEDS) as name}
      <option value={name}>{name}</option>
    {/each}
  </select>
  <button type="button" onclick={load} style="margin-left:0.5rem;">Reload seed</button>
</header>

<main>
  <GameOver />
</main>
