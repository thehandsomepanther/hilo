<script lang="ts">
  import { gameState, doBettingAction, localPlayerId } from '../gameStore';

  let raiseAmount = $state(0);

  // gameState is BettingState when this component is mounted
  const bettingState = $derived(
    $gameState?.phase === 'betting-1' || $gameState?.phase === 'betting-2' ? $gameState : null,
  );

  const activePlayer = $derived(
    bettingState ? bettingState.players[bettingState.activePlayerIndex] ?? null : null,
  );

  const canCheck = $derived(
    activePlayer !== null && (bettingState?.currentBet ?? 0) <= activePlayer.currentBet,
  );

  const callAmount = $derived(
    activePlayer
      ? Math.min((bettingState?.currentBet ?? 0) - activePlayer.currentBet, activePlayer.chips)
      : 0,
  );

  /** Maximum any player can be raised to: the smallest effective stack among active players. */
  const maxRaise = $derived(
    bettingState
      ? Math.min(...bettingState.players.filter((p) => !p.folded).map((p) => p.chips + p.currentBet))
      : 0,
  );

  $effect(() => {
    raiseAmount = (bettingState?.currentBet ?? 0) + 1;
  });

  function raise() {
    doBettingAction({ type: 'raise', amount: raiseAmount });
  }
</script>

<section>
  <h2>Betting — Phase {$gameState?.phase === 'betting-1' ? 1 : 2}</h2>

  <p>Pot: <strong>{bettingState?.pot}</strong> chips | Current bet: <strong>{bettingState?.currentBet}</strong></p>
  {#if bettingState?.bettingLocked}
    <p><em>Betting locked — a player went all-in on the forced bet. Call or fold only.</em></p>
  {/if}

  {#if activePlayer}
    {@const isMyTurn = !$localPlayerId || activePlayer.id === $localPlayerId}
    <fieldset>
      <legend>
        {activePlayer.name}'s turn
        ({activePlayer.chips} chips, already bet {activePlayer.currentBet})
      </legend>

      {#if isMyTurn}
        {#if canCheck}
          <button type="button" onclick={() => doBettingAction({ type: 'check' })}>Check</button>
        {:else}
          <button type="button" onclick={() => doBettingAction({ type: 'call' })}>
            Call ({callAmount} chip{callAmount !== 1 ? 's' : ''})
          </button>
        {/if}

        {#if !bettingState?.bettingLocked}
          <label>
            Raise to
            <input
              type="number"
              bind:value={raiseAmount}
              min={(bettingState?.currentBet ?? 0) + 1}
              max={maxRaise}
            />
          </label>
          <button
            type="button"
            onclick={raise}
            disabled={raiseAmount <= (bettingState?.currentBet ?? 0)}
          >
            Raise
          </button>
        {/if}

        <button type="button" onclick={() => doBettingAction({ type: 'fold' })}>Fold</button>
      {:else}
        <p><em>Waiting for {activePlayer.name} to act…</em></p>
      {/if}
    </fieldset>
  {/if}


</section>
