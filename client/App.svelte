<script lang="ts">
  import { gameState, pendingDecision, isDealing, resolveDecision, networkMode } from './gameStore';
  import Setup from './components/Setup.svelte';
  import ForcedBet from './components/ForcedBet.svelte';
  import Dealing from './components/Dealing.svelte';
  import Betting from './components/Betting.svelte';
  import Calculation from './components/Calculation.svelte';
  import HighLowBet from './components/HighLowBet.svelte';
  import Results from './components/Results.svelte';
  import PlayerHand from './components/PlayerHand.svelte';
  import NetworkLobby from './components/NetworkLobby.svelte';

  const phase = $derived($gameState?.phase ?? 'setup');

  const activePlayerId = $derived(
    $gameState?.players[$gameState.activePlayerIndex]?.id ?? null,
  );

  /** True once the user has finished (or skipped) network setup. */
  let networkConfigured = $state(false);
</script>

<header>
  <h1>Equation Hi-Lo</h1>
  {#if $gameState}
    <p>
      Round <strong>{$gameState.round}</strong> |
      Phase <strong>{phase}</strong> |
      Pot <strong>{$gameState.pot}</strong> chips
      {#if $isDealing}<em> — dealing…</em>{/if}
    </p>
  {/if}
  {#if $networkMode !== 'standalone'}
    <p><em>Network mode: <strong>{$networkMode}</strong></em></p>
  {/if}
</header>

<hr />

{#if !networkConfigured}
  <!-- ── Network setup (shown once, before the game) ──────────────────────── -->
  <NetworkLobby oncomplete={() => { networkConfigured = true; }} />
{:else}
  <!-- ── × Card Decision overlay (appears during async dealing) ───────────── -->
  {#if $pendingDecision}
    <section aria-live="assertive">
      <h2>Multiplication Card Decision</h2>
      <p>
        <strong>{$pendingDecision.player.name}</strong> drew a
        <strong>×</strong> card!
      </p>
      <p>
        Accept it by giving up a <strong>+</strong> or <strong>−</strong> card,
        or decline it. Either way you receive a bonus number card.
      </p>
      <fieldset>
        <legend>Choose an option:</legend>
        {#if $pendingDecision.player.personalOperators.some((op) => op.operator === '+')}
          <button
            type="button"
            onclick={() => resolveDecision({ accept: true, discard: '+' })}
          >
            Accept × — give up +
          </button>
        {/if}
        {#if $pendingDecision.player.personalOperators.some((op) => op.operator === '-')}
          <button
            type="button"
            onclick={() => resolveDecision({ accept: true, discard: '-' })}
          >
            Accept × — give up −
          </button>
        {/if}
        <button type="button" onclick={() => resolveDecision({ accept: false })}>
          Decline ×
        </button>
      </fieldset>
    </section>
    <hr />
  {/if}

  <!-- ── Phase-specific controls ──────────────────────────────────────────── -->
  <main>
    {#if phase === 'setup' || !$gameState}
      <Setup />
    {:else if phase === 'forced-bet'}
      <ForcedBet />
    {:else if phase === 'dealing-1'}
      <Dealing phase={1} />
    {:else if phase === 'dealing-2'}
      <Dealing phase={2} />
    {:else if phase === 'betting-1' || phase === 'betting-2'}
      <Betting />
    {:else if phase === 'calculation'}
      <Calculation />
    {:else if phase === 'high-low-bet'}
      <HighLowBet />
    {:else if phase === 'results'}
      <Results />
    {/if}
  </main>

  <!-- ── Always-visible state for all players ─────────────────────────────── -->
  {#if $gameState}
    <hr />
    <section>
      <h2>All Players</h2>
      <div>
        {#each $gameState.players as player}
          <PlayerHand
            {player}
            isActive={player.id === activePlayerId &&
              (phase === 'betting-1' || phase === 'betting-2')}
            showSecret={true}
          />
        {/each}
      </div>
    </section>
  {/if}
{/if}
