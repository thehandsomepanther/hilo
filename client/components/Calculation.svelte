<script lang="ts">
  import { onDestroy } from 'svelte';
  import { gameState, submitEquation, doAdvanceToBetting2 } from '../gameStore';
  import type { Card, Player } from '../../src/types';

  // ─── Token helpers ────────────────────────────────────────────────────────

  function getTokens(player: Player): Card[] {
    return [
      ...(player.secretCard ? [player.secretCard] : []),
      ...player.faceUpCards,
      ...player.personalOperators,
    ];
  }

  /** Unique label for a token — appends [n] when duplicates exist in the hand. */
  function tokenLabel(card: Card, idx: number, all: Card[]): string {
    const base = card.kind === 'number'
      ? `${card.value} (${card.suit})`
      : card.operator;
    const matches = (c: Card) =>
      c.kind === 'number'
        ? c.value === (card as typeof c).value && c.suit === (card as typeof c).suit
        : c.kind === 'operator' && c.operator === (card as typeof c).operator;
    const total = all.filter(matches).length;
    if (total === 1) return base;
    const rank = all.slice(0, idx).filter(matches).length + 1;
    return `${base} [${rank}]`;
  }

  /** The string that goes into the expression for this token. */
  function tokenExpr(card: Card): string {
    return card.kind === 'number' ? String(card.value) : card.operator;
  }

  // ─── Position-based disabling rules ──────────────────────────────────────

  // Binary operators need operands on both sides → illegal at positions 0 and N-1.
  // √ is a unary prefix operator → illegal at position N-1 (nothing to apply to).
  const BINARY_OPS = new Set(['+', '-', '×', '÷']);

  function isDisabledByPosition(card: Card, slotIdx: number, total: number): boolean {
    if (card.kind === 'number') return false;
    if (slotIdx === total - 1) return true;                           // no operator last
    if (slotIdx === 0 && BINARY_OPS.has(card.operator)) return true; // no binary op first
    return false;
  }

  // ─── Slot state ───────────────────────────────────────────────────────────

  // Each slot holds the index into the player's token array, or null if empty.
  type Slots = (number | null)[];
  type PlayerSlots = { low: Slots; high: Slots };
  type ValidationState = { error: string | null; submitted: boolean };
  type PlayerValidation = { low: ValidationState; high: ValidationState };

  let slots = $state<Record<string, PlayerSlots>>({});
  let validation = $state<Record<string, PlayerValidation>>({});

  // Initialise slots for any player not yet seen (without resetting existing ones).
  $effect(() => {
    for (const p of $gameState?.players ?? []) {
      if (p.folded || p.id in slots) continue;
      const n = getTokens(p).length;
      slots[p.id] = {
        low: Array<number | null>(n).fill(null),
        high: Array<number | null>(n).fill(null),
      };
      validation[p.id] = {
        low: { error: null, submitted: false },
        high: { error: null, submitted: false },
      };
    }
  });

  function setSlot(
    playerId: string,
    target: 'low' | 'high',
    slotIdx: number,
    value: number | null,
  ): void {
    const ps = slots[playerId];
    if (!ps) return;
    ps[target][slotIdx] = value;
    // Any slot change voids the current validation result.
    const v = validation[playerId];
    if (v) v[target] = { error: null, submitted: false };
  }

  /** True if tokenIdx is already selected in any slot of this equation other than currentSlotIdx. */
  function isUsedElsewhere(eqSlots: Slots, tokenIdx: number, currentSlotIdx: number): boolean {
    return eqSlots.some((s, i) => i !== currentSlotIdx && s === tokenIdx);
  }

  /** Build a preview string from the current slots. '?' fills empty positions. */
  function buildPreview(eqSlots: Slots, tokens: Card[]): string {
    return eqSlots
      .map((s) => (s != null ? tokenExpr(tokens[s]!) : '?'))
      .join(' ');
  }

  function allFilled(playerId: string, target: 'low' | 'high'): boolean {
    return (slots[playerId]?.[target] ?? []).every((s) => s != null);
  }

  // ─── Validation / submission ──────────────────────────────────────────────

  function validate(playerId: string, target: 'low' | 'high'): void {
    const ps = slots[playerId];
    const player = $gameState?.players.find((p) => p.id === playerId);
    if (!ps || !player) return;

    const tokens = getTokens(player);
    const expr = buildPreview(ps[target], tokens);
    if (expr.includes('?')) return; // shouldn't happen (button is disabled), but guard anyway

    const err = submitEquation(playerId, target, expr);
    const v = validation[playerId];
    if (v) v[target] = { error: err, submitted: err === null };
  }

  // ─── Timer ────────────────────────────────────────────────────────────────

  let remaining = $state($gameState?.calculationTimeLimit ?? 90);
  const interval = setInterval(() => {
    remaining = Math.max(0, remaining - 1);
  }, 1000);
  onDestroy(() => clearInterval(interval));
</script>

<section>
  <h2>Calculation Phase</h2>

  <p>Time remaining: <time><strong>{remaining}s</strong></time></p>
  <p>
    Place <strong>every</strong> card into a slot to form your equation.
    Targeting <strong>1 (Low)</strong> and/or <strong>20 (High)</strong>.
    Binary operators (+ − × ÷) are disabled in the first and last slot;
    √ is disabled in the last slot.
  </p>

  {#each $gameState?.players ?? [] as player}
    {#if !player.folded}
      {@const tokens = getTokens(player)}
      {@const ps = slots[player.id]}
      {@const v = validation[player.id]}

      <!--
        Reusable snippet for one equation's slot row.
        Captures player, tokens, ps, v from the enclosing block.
      -->
      {#snippet equationRow(target: 'low' | 'high', legend: string)}
        {@const eqSlots = ps?.[target] ?? []}
        {@const vState = v?.[target]}
        <fieldset>
          <legend>{legend}</legend>

          {#each eqSlots as _, slotIdx}
            <select
              value={eqSlots[slotIdx] != null ? String(eqSlots[slotIdx]) : ''}
              onchange={(e) => {
                const raw = (e.target as HTMLSelectElement).value;
                setSlot(player.id, target, slotIdx, raw === '' ? null : Number(raw));
              }}
            >
              <option value="">—</option>
              {#each tokens as token, tokenIdx}
                <option
                  value={String(tokenIdx)}
                  disabled={
                    isUsedElsewhere(eqSlots, tokenIdx, slotIdx) ||
                    isDisabledByPosition(token, slotIdx, tokens.length)
                  }
                >
                  {tokenLabel(token, tokenIdx, tokens)}
                </option>
              {/each}
            </select>
          {/each}

          <br />
          <output>{ps ? buildPreview(eqSlots, tokens) : '—'}</output>

          <button
            type="button"
            disabled={!allFilled(player.id, target)}
            onclick={() => validate(player.id, target)}
          >
            Validate
          </button>

          {#if vState?.error}
            <output role="alert">Error: {vState.error}</output>
          {:else if vState?.submitted}
            {@const result = target === 'low'
              ? $gameState?.players.find((p) => p.id === player.id)?.lowResult
              : $gameState?.players.find((p) => p.id === player.id)?.highResult}
            <output>✓ = {result?.toFixed(4)}</output>
          {/if}
        </fieldset>
      {/snippet}

      <fieldset>
        <legend>{player.name}</legend>
        {@render equationRow('low',  'Low equation  (target: 1)')}
        {@render equationRow('high', 'High equation (target: 20)')}
      </fieldset>
    {/if}
  {/each}

  <button type="button" onclick={doAdvanceToBetting2}>Proceed to Betting Phase 2</button>
</section>
