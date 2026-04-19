<script lang="ts">
  import { gameState, doForcedBets, doDeal, networkMode } from '../gameStore';
</script>

<section>
  <h2>Forced Bet</h2>
  <p>
    Each player must pay the forced bet of
    <strong>{$gameState?.forcedBetAmount} chip(s)</strong> to enter the round.
  </p>

  <table>
    <thead>
      <tr>
        <th>Player</th>
        <th>Chips before</th>
        <th>Forced bet</th>
        <th>Chips after</th>
      </tr>
    </thead>
    <tbody>
      {#each $gameState?.players ?? [] as player}
        <tr>
          <td>{player.name}</td>
          <td>{player.chips}</td>
          <td>{Math.min(player.chips, $gameState?.forcedBetAmount ?? 0)}</td>
          <td>{player.chips - Math.min(player.chips, $gameState?.forcedBetAmount ?? 0)}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  {#if $networkMode !== 'peer'}
    <button
      type="button"
      onclick={() => {
        doForcedBets();
        doDeal(1);
      }}
    >
      Collect forced bets &amp; deal
    </button>
  {:else}
    <p><em>Waiting for the host to start the round…</em></p>
  {/if}
</section>
