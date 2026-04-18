<script lang="ts">
  import { onDestroy } from 'svelte';
  import { gameState, submitEquation, doAdvanceToBetting2 } from '../gameStore';
  import type { Card } from '../../src/types';

  // Per-player local state for equation inputs and validation feedback
  type PlayerInput = {
    lowExpr: string;
    highExpr: string;
    lowError: string | null;
    highError: string | null;
    lowSubmitted: boolean;
    highSubmitted: boolean;
  };

  let inputs = $state<Map<string, PlayerInput>>(new Map());

  // Initialise inputs when the player list is first known
  $effect(() => {
    const players = $gameState?.players ?? [];
    const next = new Map<string, PlayerInput>();
    for (const p of players) {
      if (p.folded) continue;
      next.set(p.id, inputs.get(p.id) ?? {
        lowExpr: '',
        highExpr: '',
        lowError: null,
        highError: null,
        lowSubmitted: false,
        highSubmitted: false,
      });
    }
    inputs = next;
  });

  // Timer
  let remaining = $state($gameState?.calculationTimeLimit ?? 90);
  const interval = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
  }, 1000);
  onDestroy(() => clearInterval(interval));

  function renderCard(card: Card): string {
    if (card.kind === 'number') return `${card.value}(${card.suit[0]})`;
    return card.operator;
  }

  function getCards(playerId: string): string {
    const p = $gameState?.players.find((x) => x.id === playerId);
    if (!p) return '';
    return [
      ...(p.secretCard ? [renderCard(p.secretCard)] : []),
      ...p.faceUpCards.map(renderCard),
      ...p.personalOperators.map((op) => op.operator),
    ].join('  ');
  }

  function trySubmit(playerId: string, target: 'low' | 'high') {
    const entry = inputs.get(playerId);
    if (!entry) return;
    const expr = target === 'low' ? entry.lowExpr : entry.highExpr;
    const err = submitEquation(playerId, target, expr);
    const updated: PlayerInput = { ...entry };
    if (target === 'low') {
      updated.lowError = err;
      updated.lowSubmitted = err === null;
    } else {
      updated.highError = err;
      updated.highSubmitted = err === null;
    }
    inputs = new Map(inputs).set(playerId, updated);
  }
</script>

<section>
  <h2>Calculation Phase</h2>

  <p>
    Time remaining: <time><strong>{remaining}s</strong></time>
  </p>
  <p>
    Use <em>all</em> your cards to form equations as close to <strong>1 (Low)</strong>
    and/or <strong>20 (High)</strong> as possible.
    Operators: <code>+  -  ×  ÷  √</code> (or use <code>*</code> and <code>/</code>).
    √ applies to the single number immediately after it.
  </p>

  {#each $gameState?.players ?? [] as player}
    {#if !player.folded}
      {@const entry = inputs.get(player.id)}
      <fieldset>
        <legend>{player.name}</legend>
        <p><strong>Your cards:</strong> {getCards(player.id)}</p>

        <label>
          Low equation (target: 1)
          <input
            type="text"
            placeholder="e.g. 3 + √4 - 5 ÷ 2"
            value={entry?.lowExpr ?? ''}
            oninput={(e) => {
              const cur = inputs.get(player.id);
              if (cur) inputs = new Map(inputs).set(player.id, { ...cur, lowExpr: (e.target as HTMLInputElement).value, lowError: null });
            }}
          />
        </label>
        <button
          type="button"
          onclick={() => trySubmit(player.id, 'low')}
          disabled={!entry?.lowExpr}
        >
          {entry?.lowSubmitted ? 'Re-validate low' : 'Validate low'}
        </button>
        {#if entry?.lowError}
          <output role="alert"> Error: {entry.lowError}</output>
        {:else if entry?.lowSubmitted}
          <output> ✓ Low result: {$gameState?.players.find(p => p.id === player.id)?.lowResult?.toFixed(4)}</output>
        {/if}

        <br />

        <label>
          High equation (target: 20)
          <input
            type="text"
            placeholder="e.g. 3 × 7 - √4 ÷ 2"
            value={entry?.highExpr ?? ''}
            oninput={(e) => {
              const cur = inputs.get(player.id);
              if (cur) inputs = new Map(inputs).set(player.id, { ...cur, highExpr: (e.target as HTMLInputElement).value, highError: null });
            }}
          />
        </label>
        <button
          type="button"
          onclick={() => trySubmit(player.id, 'high')}
          disabled={!entry?.highExpr}
        >
          {entry?.highSubmitted ? 'Re-validate high' : 'Validate high'}
        </button>
        {#if entry?.highError}
          <output role="alert"> Error: {entry.highError}</output>
        {:else if entry?.highSubmitted}
          <output> ✓ High result: {$gameState?.players.find(p => p.id === player.id)?.highResult?.toFixed(4)}</output>
        {/if}
      </fieldset>
    {/if}
  {/each}

  <button type="button" onclick={doAdvanceToBetting2}>
    Proceed to Betting Phase 2
  </button>
</section>
