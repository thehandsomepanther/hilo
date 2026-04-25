<script lang="ts">
  import { gameState, doNextRound, networkMode } from '../gameStore';

  const result = $derived($gameState?.phase === 'results' ? $gameState.result : null);

  const lowWinnerId  = $derived(result?.kind === 'contested' ? result.lowWinnerId  : null);
  const highWinnerId = $derived(result?.kind === 'contested' ? result.highWinnerId : null);

  const lowWinner  = $derived(lowWinnerId  ? $gameState?.players.find((p) => p.id === lowWinnerId)  : null);
  const highWinner = $derived(highWinnerId ? $gameState?.players.find((p) => p.id === highWinnerId) : null);

  function payoutFor(playerId: string): number {
    if (!result) return 0;
    if (result.kind === 'last-player-standing') {
      return result.winnerId === playerId ? result.payout : 0;
    }
    return result.payouts[playerId] ?? 0;
  }

  const rollover = $derived(
    result?.kind === 'contested' ? (result.payouts['__rollover__'] ?? 0) : 0,
  );
</script>

<section>
  <h2>Results — Round {$gameState?.round}</h2>

  {#if result}
    {#if result.kind === 'last-player-standing'}
      <fieldset>
        <legend>Pot winner</legend>
        <p>
          All other players folded.
          <strong>{$gameState?.players.find((p) => p.id === result.winnerId)?.name}</strong>
          wins the pot of <strong>{result.payout}</strong> chips.
        </p>
      </fieldset>
    {:else}
      <fieldset>
        <legend>Pot winners</legend>
        <p>
          <strong>Low pot (target 1):</strong>
          {#if lowWinner}
            {lowWinner.name}
            — equation: <code>{'lowEquation' in lowWinner ? lowWinner.lowEquation : ''}</code>
            = {'lowResult' in lowWinner ? lowWinner.lowResult?.toFixed(4) : ''}
            {#if result.kind === 'contested' && result.lowTiebreak}
              <br /><em>{result.lowTiebreak}</em>
            {/if}
          {:else}
            No winner (rolled over)
          {/if}
        </p>
        <p>
          <strong>High pot (target 20):</strong>
          {#if highWinner}
            {highWinner.name}
            — equation: <code>{'highEquation' in highWinner ? highWinner.highEquation : ''}</code>
            = {'highResult' in highWinner ? highWinner.highResult?.toFixed(4) : ''}
            {#if result.kind === 'contested' && result.highTiebreak}
              <br /><em>{result.highTiebreak}</em>
            {/if}
          {:else}
            No winner (rolled over)
          {/if}
        </p>
        {#if rollover > 0}
          <p><strong>Rollover to next round:</strong> {rollover} chips</p>
        {/if}
      </fieldset>
    {/if}

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
          {@const won = payoutFor(player.id)}
          <tr>
            <td>{player.name}{player.folded ? ' (folded)' : ''}</td>
            <td>{!player.folded && 'betChoice' in player ? (player.betChoice ?? '—') : '—'}</td>
            <td>{!player.folded && 'lowResult' in player && player.lowResult !== null ? player.lowResult.toFixed(4) : '—'}</td>
            <td>{!player.folded && 'highResult' in player && player.highResult !== null ? player.highResult.toFixed(4) : '—'}</td>
            <td>{won}</td>
            <td>{player.chips + won}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p>Computing results…</p>
  {/if}

  {#if $networkMode !== 'peer'}
    <button type="button" onclick={doNextRound}>Start next round</button>
  {:else}
    <p><em>Waiting for the host to start the next round…</em></p>
  {/if}
</section>
