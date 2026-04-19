<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { gameState, pendingDecision, isDealing, resolveDecision, networkMode, localPlayerId } from './gameStore';
  import Setup from './components/Setup.svelte';
  import ForcedBet from './components/ForcedBet.svelte';
  import Dealing from './components/Dealing.svelte';
  import Betting from './components/Betting.svelte';
  import Calculation from './components/Calculation.svelte';
  import HighLowBet from './components/HighLowBet.svelte';
  import Results from './components/Results.svelte';
  import GameOver from './components/GameOver.svelte';
  import NetworkLobby from './components/NetworkLobby.svelte';
  import type { Card } from '../src/types';

  const SUIT_ABBR: Record<string, string> = { Gold: 'G', Silver: 'S', Bronze: 'Br', Black: 'Bl' };

  function renderCard(card: Card): string {
    if (card.kind === 'number') return `${card.value}(${SUIT_ABBR[card.suit]})`;
    return card.operator;
  }

  // Bridge Svelte 4 store → Svelte 5 rune so $derived/$effect re-evaluate on store updates.
  // Using $derived($gameState?.phase) does NOT work in runes mode because $derived only
  // tracks rune signals, not legacy store subscriptions.
  let _gs = $state(get(gameState));
  const _unsubGs = gameState.subscribe((s) => { _gs = s; });
  onDestroy(_unsubGs);

  const phase = $derived(_gs?.phase ?? 'setup');

  const activePlayerId = $derived(
    _gs?.players[_gs?.activePlayerIndex ?? 0]?.id ?? null,
  );

  /** True once the user has finished (or skipped) network setup. */
  let networkConfigured = $state(false);

  // Peers auto-proceed past the lobby as soon as the host starts the game
  // and broadcasts the first game state.
  $effect(() => {
    if (_gs !== null) networkConfigured = true;
  });

  $effect(() => {
    console.log('[App] phase=%s gameState.phase=%s', phase, _gs?.phase ?? 'null');
  });
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
  {#if $localPlayerId}
    {@const localPlayer = $gameState?.players.find((p) => p.id === $localPlayerId)}
    {#if localPlayer}
      <p>Playing as: <strong>{localPlayer.name}</strong></p>
    {/if}
  {/if}
</header>

<hr />

{#if !networkConfigured}
  <!-- ── Network setup (shown once, before the game) ──────────────────────── -->
  <NetworkLobby oncomplete={() => { networkConfigured = true; }} />
{:else}
  <!-- ── × Card Decision overlay (appears during async dealing) ───────────── -->
  {#if $pendingDecision}
    {@const isMyDecision = !$localPlayerId || $pendingDecision.player.id === $localPlayerId}
    <section aria-live="assertive">
      <h2>Multiplication Card Decision</h2>
      {#if isMyDecision}
        <p>
          You drew a <strong>×</strong> card!
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
      {:else}
        <p>
          <em>Waiting for <strong>{$pendingDecision.player.name}</strong> to decide on their × card…</em>
        </p>
      {/if}
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
    {:else if phase === 'game-over'}
      <GameOver />
    {/if}
  </main>

  <!-- ── Always-visible player table ──────────────────────────────────────── -->
  {#if $gameState && phase !== 'game-over'}
    <hr />
    <section>
      <h2>{$localPlayerId ? 'Your hand' : 'All players'}</h2>
      <table>
        <thead>
          <tr>
            <th>Player</th>
            <th>Chips</th>
            <th>Bet</th>
            <th>Secret</th>
            <th>Face-up cards</th>
            <th>Operators</th>
            <th>Bet choice</th>
            <th>Low equation</th>
            <th>High equation</th>
          </tr>
        </thead>
        <tbody>
          {#each $gameState.players as player}
            {@const isMe = player.id === $localPlayerId}
            {@const isActive = player.id === activePlayerId && (phase === 'betting-1' || phase === 'betting-2')}
            {@const showSecret = !$localPlayerId || isMe}
            {@const showEquations = !$localPlayerId || isMe || phase === 'results'}
            <tr style={isMe ? 'background-color: #fffbcc; font-weight: bold;' : ''}>
              <td>
                {player.name}
                {#if isActive} ◀{/if}
                {#if player.folded} (folded){/if}
              </td>
              <td>{player.chips}</td>
              <td>{player.currentBet}</td>
              <td>{player.secretCard ? (showSecret ? renderCard(player.secretCard) : '?') : '—'}</td>
              <td>{player.faceUpCards.length ? player.faceUpCards.map(renderCard).join('  ') : '—'}</td>
              <td>{player.personalOperators.length ? player.personalOperators.map((op) => op.operator).join('  ') : '—'}</td>
              <td>
                {#if player.betChoice !== null}
                  {(!$localPlayerId || isMe || phase === 'results' || phase === 'game-over')
                    ? player.betChoice
                    : '(hidden)'}
                {:else}
                  —
                {/if}
              </td>
              <td>
                {#if player.lowEquation !== null}
                  {showEquations ? `${player.lowEquation} = ${player.lowResult?.toFixed(4)}` : '(hidden)'}
                {:else}
                  —
                {/if}
              </td>
              <td>
                {#if player.highEquation !== null}
                  {showEquations ? `${player.highEquation} = ${player.highResult?.toFixed(4)}` : '(hidden)'}
                {:else}
                  —
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  <!-- ── Game log ──────────────────────────────────────────────────────────── -->
  {#if $gameState && $gameState.log.length > 0 && phase !== 'game-over'}
    <hr />
    <section>
      <h2>Round log</h2>
      <ol>
        {#each $gameState.log as entry}
          <li>{entry}</li>
        {/each}
      </ol>
    </section>
  {/if}
{/if}
