<script lang="ts">
  import { untrack } from 'svelte';
  import { gameState, doSubmitBetChoices, submitMyBetChoice, localPlayerId, controlsSeat } from '../gameStore';
  import type { DealtPlayer } from '../gameStore';

  // ─── Standalone flow (localPlayerId is null) ──────────────────────────────
  // Collect the choices of every seat this client plays — all the humans in a
  // pass-and-play game — then reveal them at once.  Bots are excluded: they
  // choose for themselves through the bot runner, and nobody gets to pick a
  // bot's side for it.

  const hlPlayers = $derived(
    ($gameState?.phase === 'high-low-bet' ? $gameState.players : []) as DealtPlayer[],
  );

  /** The seats this client chooses for, still waiting on a decision or not. */
  const myPlayers = $derived(
    hlPlayers.filter((p) => !p.folded && $controlsSeat(p.id)),
  );

  /** Once every seat we play has a recorded choice there is nothing left to do. */
  const submitted = $derived(myPlayers.every((p) => p.betChoice !== null));

  let choices = $state<Map<string, DealtPlayer['betChoice']>>(new Map());
  let error = $state('');

  $effect(() => {
    const players = myPlayers;
    const prev = untrack(() => choices);
    const next = new Map<string, DealtPlayer['betChoice']>();
    for (const p of players) next.set(p.id, prev.get(p.id) ?? null);
    choices = next;
  });

  function setChoice(playerId: string, choice: DealtPlayer['betChoice']) {
    choices = new Map(choices).set(playerId, choice);
  }

  function revealAll() {
    const activePlayers = myPlayers;
    const missing = activePlayers.filter((p) => choices.get(p.id) === null);
    if (missing.length > 0) {
      error = `${missing.map((p) => p.name).join(', ')} have not chosen yet.`;
      return;
    }
    for (const p of activePlayers) {
      if (choices.get(p.id) === 'swing') {
        if (p.lowResult === null || p.lowResult === undefined) {
          error = `${p.name} chose Swing but hasn't submitted an equation.`;
          return;
        }
      }
    }
    error = '';
    doSubmitBetChoices(choices);
  }

  // ─── Networked flow (localPlayerId is set) ────────────────────────────────
  // Each player submits only their own choice; host accumulates and advances.

  let myPick = $state<'high' | 'low' | 'swing' | null>(null);
  let myError = $state('');

  const mySubmittedChoice = $derived(
    $localPlayerId
      ? (hlPlayers.find((p) => p.id === $localPlayerId)?.betChoice ?? null)
      : null,
  );

  function pickOption(choice: 'high' | 'low' | 'swing') {
    myPick = choice;
  }

  function submitMine() {
    if (!myPick) { myError = 'Please choose an option first.'; return; }
    if (myPick === 'swing') {
      const me = hlPlayers.find((p) => p.id === $localPlayerId);
      if (me?.lowResult === null || me?.lowResult === undefined) {
        myError = 'Swing requires an equation to be submitted first.';
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
    {@const me = hlPlayers.find((p) => p.id === $localPlayerId)}
    {@const enforce = !!$gameState?.enforceTimeLimit}
    {@const allowLow   = !enforce || (me?.lowEquation  !== null && me?.lowEquation  !== undefined)}
    {@const allowHigh  = !enforce || (me?.highEquation !== null && me?.highEquation !== undefined)}
    {@const allowSwing = !enforce || (allowLow && allowHigh)}
    {#if me?.folded}
      <p><em>You folded — waiting for other players to submit their choices…</em></p>
    {:else if mySubmittedChoice === null}
      <fieldset>
        <legend>Your choice</legend>
        <label>
          <input type="radio" name="my-choice" value="low"
            checked={myPick === 'low'}
            disabled={!allowLow}
            onchange={() => pickOption('low')} />
          Low (target: 1){!allowLow ? ' — no equation submitted' : ''}
        </label>
        <label>
          <input type="radio" name="my-choice" value="high"
            checked={myPick === 'high'}
            disabled={!allowHigh}
            onchange={() => pickOption('high')} />
          High (target: 20){!allowHigh ? ' — no equation submitted' : ''}
        </label>
        <label>
          <input type="radio" name="my-choice" value="swing"
            checked={myPick === 'swing'}
            disabled={!allowSwing}
            onchange={() => pickOption('swing')} />
          Swing (both — must win both pots){!allowSwing ? ' — requires both equations' : ''}
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
    <!-- ── Standalone: our seats choose, then reveal at once ──────────────── -->
    {@const enforce = !!$gameState?.enforceTimeLimit}
    {#if myPlayers.length === 0}
      <p><em>You folded — waiting for the other players to submit their choices…</em></p>
    {:else if !submitted}
      {#each myPlayers as player}
        {@const allowLow   = !enforce || player.lowEquation  !== null}
        {@const allowHigh  = !enforce || player.highEquation !== null}
        {@const allowSwing = !enforce || (allowLow && allowHigh)}
        <fieldset>
          <legend>{player.name}</legend>
          <label>
            <input type="radio" name="choice-{player.id}" value="low"
              checked={choices.get(player.id) === 'low'}
              disabled={!allowLow}
              onchange={() => setChoice(player.id, 'low')} />
            Low (target: 1){!allowLow ? ' — no equation submitted' : ''}
          </label>
          <label>
            <input type="radio" name="choice-{player.id}" value="high"
              checked={choices.get(player.id) === 'high'}
              disabled={!allowHigh}
              onchange={() => setChoice(player.id, 'high')} />
            High (target: 20){!allowHigh ? ' — no equation submitted' : ''}
          </label>
          <label>
            <input type="radio" name="choice-{player.id}" value="swing"
              checked={choices.get(player.id) === 'swing'}
              disabled={!allowSwing}
              onchange={() => setChoice(player.id, 'swing')} />
            Swing (both — must win both pots){!allowSwing ? ' — requires both equations' : ''}
          </label>
        </fieldset>
      {/each}

      {#if error}
        <p role="alert">{error}</p>
      {/if}

      <button type="button" onclick={revealAll}>
        {myPlayers.length > 1 ? 'Reveal all choices' : 'Submit choice'}
      </button>
    {:else}
      <p><em>Waiting for the other players to choose…</em></p>
    {/if}
  {/if}
</section>
