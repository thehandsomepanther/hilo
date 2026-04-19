<script lang="ts">
  import type { Player, Card } from '../gameStore';

  interface Props {
    player: Player;
    isActive?: boolean;
    showSecret?: boolean;
    showEquations?: boolean;
  }

  let { player, isActive = false, showSecret = true, showEquations = true }: Props = $props();

  const SUIT_ABBR: Record<string, string> = { Gold: 'G', Silver: 'S', Bronze: 'Br', Black: 'Bl' };

  function renderCard(card: Card): string {
    if (card.kind === 'number') return `${card.value}(${SUIT_ABBR[card.suit]})`;
    return card.operator;
  }

  const secretLabel = $derived(
    player.secretCard
      ? (showSecret ? renderCard(player.secretCard) : '?')
      : '—'
  );
</script>

<fieldset>
  <legend>
    {player.name}
    {#if isActive}— ACTIVE PLAYER{/if}
    {#if player.folded}— FOLDED{/if}
  </legend>

  <dl>
    <dt>Chips</dt>
    <dd>{player.chips}</dd>

    <dt>Bet this round</dt>
    <dd>{player.currentBet}</dd>

    <dt>Secret card</dt>
    <dd>{secretLabel}</dd>

    <dt>Face-up cards</dt>
    <dd>
      {#if player.faceUpCards.length === 0}
        —
      {:else}
        {player.faceUpCards.map(renderCard).join('  ')}
      {/if}
    </dd>

    <dt>Operators</dt>
    <dd>
      {#if player.personalOperators.length === 0}
        —
      {:else}
        {player.personalOperators.map((op) => op.operator).join('  ')}
      {/if}
    </dd>

    {#if player.betChoice}
      <dt>Bet choice</dt>
      <dd>{player.betChoice}</dd>
    {/if}

    {#if player.lowEquation !== null}
      <dt>Low equation</dt>
      <dd>{showEquations ? `${player.lowEquation} = ${player.lowResult?.toFixed(4)}` : '(hidden)'}</dd>
    {/if}

    {#if player.highEquation !== null}
      <dt>High equation</dt>
      <dd>{showEquations ? `${player.highEquation} = ${player.highResult?.toFixed(4)}` : '(hidden)'}</dd>
    {/if}
  </dl>
</fieldset>
