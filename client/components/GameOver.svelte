<script lang="ts">
  import { gameState, doPlayAgain } from '../gameStore';

  const winnerId = $derived($gameState?.phase === 'game-over' ? $gameState.winnerId : null);

  const winner = $derived(
    winnerId ? $gameState?.players.find((p) => p.id === winnerId) ?? null : null,
  );

  const sorted = $derived(
    [...($gameState?.players ?? [])].sort((a, b) => b.chips - a.chips),
  );
</script>

<section>
  <h2>Game Over</h2>

  {#if winner}
    <p><strong>{winner.name}</strong> wins with <strong>{winner.chips}</strong> chips!</p>
  {:else}
    <p>No winner — everyone ran out of chips.</p>
  {/if}

  <table>
    <thead>
      <tr>
        <th>Place</th>
        <th>Player</th>
        <th>Chips</th>
      </tr>
    </thead>
    <tbody>
      {#each sorted as player, i}
        <tr>
          <td>{i + 1}</td>
          <td>
            {player.name}
            {#if player.id === winnerId} 🏆{/if}
          </td>
          <td>{player.chips}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  <p>Rounds played: <strong>{$gameState?.round}</strong></p>

  <button type="button" onclick={doPlayAgain}>Play again</button>
</section>
