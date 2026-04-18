<script lang="ts">
  import { onMount } from 'svelte';
  import { gameState, roundResult, doNextRound } from '../gameStore';

  onMount(() => {
    console.log('[Results] mounted, roundResult=%o gameState.phase=%s',
      $roundResult, $gameState?.phase);
  });

  const lowWinner = $derived(
    $roundResult?.lowWinnerId
      ? $gameState?.players.find((p) => p.id === $roundResult?.lowWinnerId)
      : null,
  );

  const highWinner = $derived(
    $roundResult?.highWinnerId
      ? $gameState?.players.find((p) => p.id === $roundResult?.highWinnerId)
      : null,
  );

  function payout(playerId: string): number {
    return $roundResult?.payouts.get(playerId) ?? 0;
  }

  const rollover = $derived($roundResult?.payouts.get('__rollover__') ?? 0);
</script>

<section>
  <h2>Results — Round {$gameState?.round}</h2>

  {#if $roundResult}
    <fieldset>
      <legend>Pot winners</legend>
      <p>
        <strong>Low pot (target 1):</strong>
        {#if lowWinner}
          {lowWinner.name}
          — equation: <code>{$gameState?.players.find(p => p.id === lowWinner.id)?.lowEquation}</code>
          = {$gameState?.players.find(p => p.id === lowWinner.id)?.lowResult?.toFixed(4)}
        {:else}
          No winner (rolled over)
        {/if}
      </p>
      <p>
        <strong>High pot (target 20):</strong>
        {#if highWinner}
          {highWinner.name}
          — equation: <code>{$gameState?.players.find(p => p.id === highWinner.id)?.highEquation}</code>
          = {$gameState?.players.find(p => p.id === highWinner.id)?.highResult?.toFixed(4)}
        {:else}
          No winner (rolled over)
        {/if}
      </p>
      {#if rollover > 0}
        <p><strong>Rollover to next round:</strong> {rollover} chips</p>
      {/if}
    </fieldset>

    <table>
      <thead>
        <tr>
          <th>Player</th>
          <th>Bet</th>
          <th>Low result</th>
          <th>High result</th>
          <th>Won</th>
          <th>Chips after</th>
        </tr>
      </thead>
      <tbody>
        {#each $gameState?.players ?? [] as player}
          <tr>
            <td>{player.name}{player.folded ? ' (folded)' : ''}</td>
            <td>{player.betChoice ?? '—'}</td>
            <td>{player.lowResult !== null ? player.lowResult.toFixed(4) : '—'}</td>
            <td>{player.highResult !== null ? player.highResult.toFixed(4) : '—'}</td>
            <td>{payout(player.id)}</td>
            <td>{player.chips + payout(player.id)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p>Computing results…</p>
  {/if}

  <button type="button" onclick={doNextRound}>Start next round</button>
</section>
