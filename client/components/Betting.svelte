<script lang="ts">
  import { gameState, doBettingAction } from '../gameStore';

  let raiseAmount = $state(0);

  const activePlayer = $derived(
    $gameState?.players[$gameState.activePlayerIndex] ?? null,
  );

  const canCheck = $derived(
    activePlayer !== null &&
    ($gameState?.currentBet ?? 0) <= activePlayer.currentBet,
  );

  const callAmount = $derived(
    activePlayer
      ? Math.min(
          ($gameState?.currentBet ?? 0) - activePlayer.currentBet,
          activePlayer.chips,
        )
      : 0,
  );

  $effect(() => {
    // Default raise to one above current bet when the active player changes
    raiseAmount = ($gameState?.currentBet ?? 0) + 1;
  });

  function raise() {
    doBettingAction({ type: 'raise', amount: raiseAmount });
  }
</script>

<section>
  <h2>Betting — Phase {$gameState?.phase === 'betting-1' ? 1 : 2}</h2>

  <p>Pot: <strong>{$gameState?.pot}</strong> chips | Current bet: <strong>{$gameState?.currentBet}</strong></p>

  {#if activePlayer}
    <fieldset>
      <legend>
        {activePlayer.name}'s turn
        ({activePlayer.chips} chips, already bet {activePlayer.currentBet})
      </legend>

      {#if canCheck}
        <button type="button" onclick={() => doBettingAction({ type: 'check' })}>Check</button>
      {:else}
        <button type="button" onclick={() => doBettingAction({ type: 'call' })}>
          Call ({callAmount} chip{callAmount !== 1 ? 's' : ''})
        </button>
      {/if}

      <label>
        Raise to
        <input
          type="number"
          bind:value={raiseAmount}
          min={($gameState?.currentBet ?? 0) + 1}
          max={activePlayer.chips + activePlayer.currentBet}
        />
      </label>
      <button
        type="button"
        onclick={raise}
        disabled={raiseAmount <= ($gameState?.currentBet ?? 0)}
      >
        Raise
      </button>

      <button type="button" onclick={() => doBettingAction({ type: 'fold' })}>Fold</button>
    </fieldset>
  {/if}

  <details>
    <summary>All bets</summary>
    <table>
      <thead>
        <tr><th>Player</th><th>Bet</th><th>Chips</th><th>Status</th></tr>
      </thead>
      <tbody>
        {#each $gameState?.players ?? [] as p}
          <tr>
            <td>{p.name}{p.id === activePlayer?.id ? ' ◀' : ''}</td>
            <td>{p.currentBet}</td>
            <td>{p.chips}</td>
            <td>{p.folded ? 'Folded' : 'Active'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </details>
</section>
