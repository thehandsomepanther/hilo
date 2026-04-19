<script lang="ts">
  import { onDestroy } from 'svelte';
  import { gameState, submitEquation, doAdvanceToBetting2, localPlayerId } from '../gameStore';
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
  type ValidationState = { error: string | null; submitted: boolean };

  let slots = $state<Record<string, Slots>>({});
  let validation = $state<Record<string, ValidationState>>({});

  // Initialise slots for any player not yet seen (without resetting existing ones).
  $effect(() => {
    for (const p of $gameState?.players ?? []) {
      if (p.folded || p.id in slots) continue;
      const n = getTokens(p).length;
      slots[p.id] = Array<number | null>(n).fill(null);
      validation[p.id] = { error: null, submitted: false };
    }
  });

  function setSlot(playerId: string, slotIdx: number, value: number | null): void {
    const s = slots[playerId];
    if (!s) return;
    s[slotIdx] = value;
    // Any slot change voids the current validation result.
    validation[playerId] = { error: null, submitted: false };
  }

  /** True if tokenIdx is already selected in any slot other than currentSlotIdx. */
  function isUsedElsewhere(eqSlots: Slots, tokenIdx: number, currentSlotIdx: number): boolean {
    return eqSlots.some((s, i) => i !== currentSlotIdx && s === tokenIdx);
  }

  /** Build a preview string from the current slots. '?' fills empty positions. */
  function buildPreview(eqSlots: Slots, tokens: Card[]): string {
    return eqSlots
      .map((s) => (s != null ? tokenExpr(tokens[s]!) : '?'))
      .join(' ');
  }

  function allFilled(playerId: string): boolean {
    return (slots[playerId] ?? []).every((s) => s != null);
  }

  // ─── Validation / submission ──────────────────────────────────────────────

  function validate(playerId: string): void {
    const eqSlots = slots[playerId];
    const player = $gameState?.players.find((p) => p.id === playerId);
    if (!eqSlots || !player) return;

    const tokens = getTokens(player);
    const expr = buildPreview(eqSlots, tokens);
    if (expr.includes('?')) return;

    const err = submitEquation(playerId, expr);
    validation[playerId] = { error: err, submitted: err === null };
  }

  // ─── Debug: auto-fill equations ──────────────────────────────────────────

  /**
   * Build a valid expression using every token exactly once.
   * Pairs each √ with the next available number, then interleaves remaining
   * number atoms with binary operators. Avoids ÷ 0 by swapping operands.
   */
  function buildDebugExpression(tokens: Card[]): string {
    const nums   = tokens.filter((t): t is Card & { kind: 'number' }   => t.kind === 'number');
    const roots  = tokens.filter((t): t is Card & { kind: 'operator'; operator: '√' } =>
      t.kind === 'operator' && t.operator === '√');
    const binOps = tokens.filter((t): t is Card & { kind: 'operator' } =>
      t.kind === 'operator' && t.operator !== '√');

    const numberQueue = [...nums];
    const atoms: string[] = [];
    for (const _ of roots) {
      const n = numberQueue.shift();
      atoms.push(n ? `√ ${n.value}` : '√ 1');
    }
    for (const n of numberQueue) {
      atoms.push(String(n.value));
    }

    const ops = binOps.map((o) => o.operator);
    const parts: string[] = [atoms[0] ?? '1'];
    for (let i = 0; i < ops.length; i++) {
      const op  = ops[i];
      const rhs = atoms[i + 1] ?? '1';
      if (op === '÷' && rhs === '0') {
        const prev = parts.pop()!;
        parts.push(rhs, op, prev);
      } else {
        parts.push(op, rhs);
      }
    }
    return parts.join(' ');
  }

  function debugFillAll(): void {
    for (const player of $gameState?.players ?? []) {
      if (player.folded) continue;
      const tokens = getTokens(player);
      const expr = buildDebugExpression(tokens);
      const err = submitEquation(player.id, expr);
      validation[player.id] = { error: err, submitted: err === null };
    }
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
    Binary operators (+ − × ÷) are disabled in the first and last slot;
    √ is disabled in the last slot.
  </p>

  {#each $gameState?.players ?? [] as player}
    {#if !player.folded}
      {@const isMe = !$localPlayerId || player.id === $localPlayerId}
      {@const tokens = getTokens(player)}
      {@const eqSlots = slots[player.id] ?? []}
      {@const vState = validation[player.id]}

      {#if isMe}
        <fieldset>
          <legend>{player.name}</legend>

          {#if player.lowEquation !== null}
            <p><output>✓ Submitted: <code>{player.lowEquation}</code> = {player.lowResult?.toFixed(4)}</output></p>
          {:else}
            {#each eqSlots as _, slotIdx}
              <select
                value={eqSlots[slotIdx] != null ? String(eqSlots[slotIdx]) : ''}
                onchange={(e) => {
                  const raw = (e.target as HTMLSelectElement).value;
                  setSlot(player.id, slotIdx, raw === '' ? null : Number(raw));
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
            <output>{buildPreview(eqSlots, tokens)}</output>

            <button
              type="button"
              disabled={!allFilled(player.id)}
              onclick={() => validate(player.id)}
            >
              Submit equation
            </button>

            {#if vState?.error}
              <output role="alert">Error: {vState.error}</output>
            {/if}
          {/if}
        </fieldset>
      {:else}
        <!-- Read-only status for other players — equation hidden until results -->
        <fieldset>
          <legend>{player.name}</legend>
          <p>
            {#if player.lowEquation !== null}
              Equation submitted.
            {:else}
              Working…
            {/if}
          </p>
        </fieldset>
      {/if}
    {/if}
  {/each}

  <button type="button" onclick={doAdvanceToBetting2}>Proceed to Betting Phase 2</button>
  <button type="button" onclick={debugFillAll} style="opacity:0.6;margin-left:1rem">
    Debug: auto-fill all equations
  </button>
</section>
