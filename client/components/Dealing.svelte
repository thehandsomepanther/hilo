<script lang="ts">
  import { isDealing, doDeal, networkMode } from '../gameStore';

  interface Props {
    phase: 1 | 2;
  }
  let { phase }: Props = $props();
</script>

<section>
  <h2>Dealing — Phase {phase}</h2>

  {#if $isDealing}
    <p><em>Dealing cards… please wait.</em></p>
  {:else if $networkMode === 'peer'}
    <p><em>Waiting for the host to deal…</em></p>
  {:else if phase === 2}
    <p>Each active player will receive one additional face-up card.</p>
    <button type="button" onclick={() => doDeal(2)}>Deal extra card</button>
  {:else}
    <p>Cards will be dealt once you proceed. If a × card appears you will be asked to make a decision.</p>
    <button type="button" onclick={() => doDeal(1)}>Deal cards</button>
  {/if}
</section>
