<script lang="ts">
  import { gameState, doSubmitBetChoices, submitMyBetChoice, localPlayerId } from '../gameStore';
  import type { Player } from '../../src/types';

  // ─── Standalone flow (localPlayerId is null) ──────────────────────────────
  // Collect all players' choices locally then reveal at once.

  let choices = $state<Map<string, Player['betChoice']>>(new Map());
  let revealed = $state(false);
  let error = $state('');

  $effect(() => {
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

  // ─── Networked flow (localPlayerId is set) ────────────────────────────────
  // Each player submits only their own choice; host accumulates and advances.

  let myPick = $state<'high' | 'low' | 'swing' | null>(null);
  let myError = $state('');

  // The local player's recorded choice lives in game state once submitted.
  const mySubmittedChoice = $derived(
    $localPlayerId
      ? ($gameState?.players.find((p) => p.id === $localPlayerId)?.betChoice ?? null)
      : null,
  );

  function submitMine() {
    if (!myPick) { myError = 'Please choose an option first.'; return; }
    if (myPick === 'swing') {
      const me = $gameState?.players.find((p) => p.id === $localPlayerId);
      if (!me?.lowResult || !me?.highResult) {
        myError = 'Swing requires both equations to be validated first.';
        return;
      }
    }
    myError = '';
    submitMyBetChoice(myPick);
  }
</script>

<section>
  <h2>High / Low Bet</h2>
  <p>
    Each player secretly chooses a target, then all choices are revealed at once.
    <br />
    <strong>Swing</strong> means you must win <em>both</em> pots, or you win neither.
  </p>

  {#if $localPlayerId}
    <!-- ── Networked: one player at a time ────────────────────────────────── -->
    {#if mySubmittedChoice === null}
      <fieldset>
        <legend>Your choice</legend>
        <label>
          <input type="radio" name="my-choice" value="low"
            bind:group={myPick} />
          Low (target: 1)
        </label>
        <label>
          <input type="radio" name="my-choice" value="high"
            bind:group={myPick} />
          High (target: 20)
        </label>
        <label>
          <input type="radio" name="my-choice" value="swing"
            bind:group={myPick} />
          Swing (both — must win both pots)
        </label>
      </fieldset>

      {#if myError}
        <p role="alert">{myError}</p>
      {/if}

      <button type="button" onclick={submitMine}>Submit choice</button>
    {:else}
      <p>Your choice: <strong>{mySubmittedChoice}</strong></p>
      <p><em>Waiting for all players to submit their choices…</em></p>
    {/if}

  {:else}
    <!-- ── Standalone: all players choose then reveal at once ─────────────── -->
    {#if !revealed}
      {#each $gameState?.players ?? [] as player}
        {#if !player.folded}
          <fieldset>
            <legend>{player.name}</legend>
            <label>
              <input type="radio" name="choice-{player.id}" value="low"
                checked={choices.get(player.id) === 'low'}
                onchange={() => setChoice(player.id, 'low')} />
              Low (target: 1)
            </label>
            <label>
              <input type="radio" name="choice-{player.id}" value="high"
                checked={choices.get(player.id) === 'high'}
                onchange={() => setChoice(player.id, 'high')} />
              High (target: 20)
            </label>
            <label>
              <input type="radio" name="choice-{player.id}" value="swing"
                checked={choices.get(player.id) === 'swing'}
                onchange={() => setChoice(player.id, 'swing')} />
              Swing (both — must win both pots)
            </label>
          </fieldset>
        {/if}
      {/each}

      {#if error}
        <p role="alert">{error}</p>
      {/if}

      <button type="button" onclick={revealAll}>Reveal all choices</button>
    {:else}
      <p><em>Choices revealed — see Results below.</em></p>
    {/if}
  {/if}
</section>
