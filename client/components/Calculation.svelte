<script lang="ts">
  import { onDestroy } from 'svelte';
  import { gameState, submitEquation, unsubmitEquation, doAdvanceToBetting2, localPlayerId, networkMode } from '../gameStore';
  import type { Card, DealtPlayer } from '../gameStore';

  // ─── Token helpers ────────────────────────────────────────────────────────

  const calcPlayers = $derived(
    ($gameState?.phase === 'calculation' ? $gameState.players : []) as DealtPlayer[],
  );

  function getTokens(player: DealtPlayer): Card[] {
    return [player.secretCard, ...player.faceUpCards, ...player.personalOperators];
  }

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
    if (slotIdx === total - 1) return true;
    if (slotIdx === 0 && BINARY_OPS.has(card.operator)) return true;
    return false;
  }

  // ─── Slot state ───────────────────────────────────────────────────────────

  type Slots = (number | null)[];
  type EquationState = { slots: Slots; error: string | null; submitted: boolean };
  type PlayerState = { low: EquationState; high: EquationState };

  let playerStates = $state<Record<string, PlayerState>>({});

  function makeEquationState(n: number): EquationState {
    return { slots: Array<number | null>(n).fill(null), error: null, submitted: false };
  }

  $effect(() => {
    for (const p of calcPlayers) {
      if (p.folded || p.id in playerStates) continue;
      const n = getTokens(p).length;
      playerStates[p.id] = { low: makeEquationState(n), high: makeEquationState(n) };
    }
  });

  function setSlot(playerId: string, target: 'low' | 'high', slotIdx: number, value: number | null): void {
    const eq = playerStates[playerId]?.[target];
    if (!eq) return;
    eq.slots[slotIdx] = value;
    eq.error = null;
    eq.submitted = false;
  }

  function resetEquation(playerId: string, target: 'low' | 'high'): void {
    const ps = playerStates[playerId];
    if (!ps) return;
    const n = ps[target].slots.length;
    ps[target] = makeEquationState(n);
  }

  /** True if tokenIdx is already selected in any slot of this equation other than currentSlotIdx. */
  function isUsedElsewhere(eqSlots: Slots, tokenIdx: number, currentSlotIdx: number): boolean {
    return eqSlots.some((s, i) => i !== currentSlotIdx && s === tokenIdx);
  }

  /** Build a preview string from the current slots. '?' fills empty positions. */
  function buildPreview(eqSlots: Slots, tokens: Card[]): string {
    return eqSlots.map((s) => (s != null ? tokenExpr(tokens[s]!) : '?')).join(' ');
  }

  function allFilled(eqSlots: Slots): boolean {
    return eqSlots.every((s) => s != null);
  }

  // ─── Validation / submission ──────────────────────────────────────────────

  function validate(playerId: string, target: 'low' | 'high'): void {
    const eq = playerStates[playerId]?.[target];
    const player = calcPlayers.find((p) => p.id === playerId);
    if (!eq || !player) return;

    const tokens = getTokens(player);
    const expr = buildPreview(eq.slots, tokens);
    if (expr.includes('?')) return;

    const err = submitEquation(playerId, target, expr);
    eq.error = err;
    eq.submitted = err === null;
  }

  // ─── Debug: auto-fill equations ──────────────────────────────────────────

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
    for (const n of numberQueue) atoms.push(String(n.value));

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
    for (const player of calcPlayers) {
      if (player.folded) continue;
      const tokens = getTokens(player);
      const expr = buildDebugExpression(tokens);
      for (const target of ['low', 'high'] as const) {
        const err = submitEquation(player.id, target, expr);
        const eq = playerStates[player.id]?.[target];
        if (eq) { eq.error = err; eq.submitted = err === null; }
      }
    }
  }

  // ─── Timer ────────────────────────────────────────────────────────────────

  let remaining = $state(($gameState?.phase === 'calculation' ? $gameState.calculationTimeLimit : null) ?? 90);
  const interval = setInterval(() => { remaining = Math.max(0, remaining - 1); }, 1000);
  onDestroy(() => clearInterval(interval));
</script>

<section>
  <h2>Calculation Phase</h2>

  <p>Time remaining: <time><strong>{remaining}s</strong></time></p>
  <p>
    Build two equations using <strong>every</strong> card — one targeting <strong>1 (Low)</strong>,
    one targeting <strong>20 (High)</strong>.
    Binary operators (+ − × ÷) are disabled in the first and last slot;
    √ is disabled in the last slot.
  </p>

  {#each calcPlayers as player}
    {#if !player.folded}
      {@const isMe = !$localPlayerId || player.id === $localPlayerId}
      {@const tokens = getTokens(player)}
      {@const ps = playerStates[player.id]}

      {#if isMe}
        <fieldset>
          <legend>{player.name}</legend>

          {#snippet equationBuilder(target: 'low' | 'high', label: string, submittedEquation: string | null, submittedResult: number | null)}
            {@const eq = ps?.[target]}
            {@const eqSlots = eq?.slots ?? []}
            <fieldset>
              <legend>{label}</legend>

              {#if submittedEquation !== null}
                <output>✓ <code>{submittedEquation}</code> = {submittedResult?.toFixed(4)}</output>
                <button type="button" onclick={() => unsubmitEquation(player.id, target)}>Edit</button>
              {:else}
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
                <output>{buildPreview(eqSlots, tokens)}</output>

                <button
                  type="button"
                  disabled={!allFilled(eqSlots)}
                  onclick={() => validate(player.id, target)}
                >
                  Submit
                </button>
                <button type="button" onclick={() => resetEquation(player.id, target)}>Reset</button>

                {#if eq?.error}
                  <output role="alert">Error: {eq.error}</output>
                {/if}
              {/if}
            </fieldset>
          {/snippet}

          {@render equationBuilder('low',  'Low equation (target: 1)',  player.lowEquation,  player.lowResult)}
          {@render equationBuilder('high', 'High equation (target: 20)', player.highEquation, player.highResult)}
        </fieldset>
      {:else}
        <!-- Read-only status for other players — equations hidden until results -->
        <fieldset>
          <legend>{player.name}</legend>
          <p>
            {#if player.lowEquation !== null && player.highEquation !== null}
              Both equations submitted.
            {:else if player.lowEquation !== null}
              Low submitted, waiting on high…
            {:else if player.highEquation !== null}
              High submitted, waiting on low…
            {:else}
              Working…
            {/if}
          </p>
        </fieldset>
      {/if}
    {/if}
  {/each}

  {#if $networkMode !== 'peer'}
    {@const allSubmitted = calcPlayers
      .filter(p => !p.folded)
      .every(p => p.lowEquation !== null && p.highEquation !== null)}
    <button type="button" onclick={doAdvanceToBetting2} disabled={!allSubmitted}>
      Proceed to Betting Phase 2
    </button>
    <button type="button" onclick={debugFillAll} style="opacity:0.6;margin-left:1rem">
      Debug: auto-fill all equations
    </button>
  {:else}
    <p><em>Waiting for the host to advance to the next phase…</em></p>
  {/if}
</section>
