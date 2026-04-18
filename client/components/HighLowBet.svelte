<script lang="ts">
  import { gameState, doSubmitBetChoices, localPlayerId } from '../gameStore';
  import type { Player } from '../../src/types';

  // Collect each player's choice before simultaneous reveal
  let choices = $state<Map<string, Player['betChoice']>>(new Map());
  let revealed = $state(false);
  let error = $state('');

  $effect(() => {
    // Initialise choices when players change
    const players = $gameState?.players ?? [];
    const next = new Map<string, Player['betChoice']>();
    for (const p of players) {
      if (!p.folded) next.set(p.id, choices.get(p.id) ?? null);
    }
    choices = next;
  });

  function setChoice(playerId: string, choice: Player['betChoice']) {
    choices = new Map(choices).set(playerId, choice);
  }

  function revealAll() {
    const activePlayers = ($gameState?.players ?? []).filter((p) => !p.folded);
    const missing = activePlayers.filter((p) => choices.get(p.id) === null);
    if (missing.length > 0) {
      error = `${missing.map((p) => p.name).join(', ')} have not chosen yet.`;
      return;
    }

    // Validate swing players have equations
    for (const p of activePlayers) {
      if (choices.get(p.id) === 'swing') {
        const player = $gameState?.players.find((x) => x.id === p.id);
        if (!player?.lowResult || !player?.highResult) {
          error = `${p.name} chose Swing but hasn't validated both equations.`;
          return;
        }
      }
    }

    error = '';
    revealed = true;
    doSubmitBetChoices(choices);
  }
</script>

<section>
  <h2>High / Low Bet</h2>
  <p>
    Each player secretly chooses a target, then all choices are revealed at once.
    <br />
    <strong>Swing</strong> means you must win <em>both</em> pots, or you win neither.
  </p>

  {#if !revealed}
    {#each $gameState?.players ?? [] as player}
      {#if !player.folded}
        {@const isMe = !$localPlayerId || player.id === $localPlayerId}
        {#if isMe}
          <fieldset>
            <legend>{player.name}</legend>
            <label>
              <input
                type="radio"
                name="choice-{player.id}"
                value="low"
                checked={choices.get(player.id) === 'low'}
                onchange={() => setChoice(player.id, 'low')}
              />
              Low (target: 1)
            </label>
            <label>
              <input
                type="radio"
                name="choice-{player.id}"
                value="high"
                checked={choices.get(player.id) === 'high'}
                onchange={() => setChoice(player.id, 'high')}
              />
              High (target: 20)
            </label>
            <label>
              <input
                type="radio"
                name="choice-{player.id}"
                value="swing"
                checked={choices.get(player.id) === 'swing'}
                onchange={() => setChoice(player.id, 'swing')}
              />
              Swing (both — must win both pots)
            </label>
          </fieldset>
        {:else}
          <p><em>{player.name} — choice hidden until reveal.</em></p>
        {/if}
      {/if}
    {/each}

    {#if error}
      <p role="alert">{error}</p>
    {/if}

    <button type="button" onclick={revealAll}>Reveal all choices</button>
  {:else}
    <p><em>Choices revealed — see Results below.</em></p>
  {/if}
</section>
