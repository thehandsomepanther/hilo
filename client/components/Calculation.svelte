<script lang="ts">
  import { onDestroy } from 'svelte';
  import { gameState, submitEquation, unsubmitEquation, doAdvanceToBetting2, expireCalculationPhase, setPlayerReady, localPlayerId, networkMode } from '../gameStore';
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
      ? `${card.value}`
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

  /** Remove the card at fromIdx and everything to its right. */
  function popFrom(playerId: string, target: 'low' | 'high', fromIdx: number): void {
    const eq = playerStates[playerId]?.[target];
    if (!eq) return;
    for (let i = fromIdx; i < eq.slots.length; i++) eq.slots[i] = null;
    eq.error = null;
    eq.submitted = false;
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
  let timerExpired = $state(false);
  const interval = setInterval(() => { remaining = Math.max(0, remaining - 1); }, 1000);
  onDestroy(() => clearInterval(interval));

  $effect(() => {
    if (remaining === 0 && !timerExpired && $gameState?.phase === 'calculation' && $gameState.enforceTimeLimit) {
      timerExpired = true;
      // Auto-submit any filled-but-not-yet-submitted equations before expiry.
      for (const player of calcPlayers) {
        if (player.folded) continue;
        if ($localPlayerId && player.id !== $localPlayerId) continue;
        for (const target of ['low', 'high'] as const) {
          const alreadySubmitted = target === 'low' ? player.lowEquation !== null : player.highEquation !== null;
          if (alreadySubmitted) continue;
          const eq = playerStates[player.id]?.[target];
          if (eq && allFilled(eq.slots)) validate(player.id, target);
        }
      }
      // Auto-ready any player who has both equations (enforcement bypasses the manual ready step).
      for (const player of calcPlayers) {
        if (player.folded) continue;
        if ($localPlayerId && player.id !== $localPlayerId) continue;
        if (player.lowEquation !== null && player.highEquation !== null) setPlayerReady(player.id);
      }
      if ($networkMode !== 'peer') expireCalculationPhase();
    }
  });
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
        <fieldset style="max-width: 100vw; box-sizing: border-box;">
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
                <!-- Both rows in one grid so each column is sized by its widest item -->
                <div style="display:grid;grid-template-columns:repeat({tokens.length},minmax(0,3rem));justify-items:stretch;gap:6px;margin-bottom:8px;">
                  <!-- Top row: slots -->
                  {#each eqSlots as slotValue, slotIdx}
                    {#if slotValue != null}
                      <div
                        role="button"
                        tabindex="0"
                        title="Click to remove this card and all to its right"
                        style="height:2.5rem;padding:0 6px;border:2px solid #555;border-radius:4px;display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:0.85rem;background:#fff;"
                        onclick={() => popFrom(player.id, target, slotIdx)}
                        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') popFrom(player.id, target, slotIdx); }}
                      >{tokenLabel(tokens[slotValue]!, slotValue, tokens)}</div>
                    {:else}
                      <div style="height:2.5rem;border:2px dashed #bbb;border-radius:4px;background:#fafafa;"></div>
                    {/if}
                  {/each}

                  <!-- Bottom row: available tokens; click to place in next empty slot -->
                  {#each tokens as token, tokenIdx}
                    {@const used = eqSlots.some(s => s === tokenIdx)}
                    {@const nextSlot = eqSlots.indexOf(null)}
                    {@const posDisabled = nextSlot === -1 || isDisabledByPosition(token, nextSlot, tokens.length)}
                    {@const disabled = used || posDisabled}
                    <div
                      role="button"
                      tabindex={disabled ? -1 : 0}
                      style="height:2.5rem;padding:0 6px;border:2px solid {disabled ? '#ccc' : '#555'};border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.85rem;background:{used ? '#f0f0f0' : '#fff'};opacity:{used ? 0.4 : 1};cursor:{disabled ? 'default' : 'pointer'};"
                      onclick={() => { if (!disabled) setSlot(player.id, target, nextSlot, tokenIdx); }}
                      onkeydown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !disabled) setSlot(player.id, target, nextSlot, tokenIdx); }}
                    >{tokenLabel(token, tokenIdx, tokens)}</div>
                  {/each}
                </div>

                <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                  <output style="font-family:monospace;font-size:0.9rem;">{buildPreview(eqSlots, tokens)}</output>
                  <button
                    type="button"
                    disabled={!allFilled(eqSlots)}
                    onclick={() => validate(player.id, target)}
                  >Submit</button>
                  <button type="button" onclick={() => resetEquation(player.id, target)}>Reset</button>
                </div>

                {#if eq?.error}
                  <p role="alert" style="color:red;margin:4px 0 0;">{eq.error}</p>
                {/if}
              {/if}
            </fieldset>
          {/snippet}

          {@render equationBuilder('low',  'Low equation (target: 1)',  player.lowEquation,  player.lowResult)}
          {@render equationBuilder('high', 'High equation (target: 20)', player.highEquation, player.highResult)}

          {#if $gameState?.phase === 'calculation' && $gameState.readyPlayerIds.includes(player.id)}
            <p><strong>✓ Ready</strong></p>
          {:else}
            <button
              type="button"
              disabled={!(player.lowEquation !== null && player.highEquation !== null)}
              onclick={() => setPlayerReady(player.id)}
            >
              Ready
            </button>
          {/if}
        </fieldset>
      {:else}
        <!-- Read-only status for other players — equations hidden until results -->
        <fieldset>
          <legend>{player.name}</legend>
          <p>
            {#if $gameState?.phase === 'calculation' && $gameState.readyPlayerIds.includes(player.id)}
              Ready ✓
            {:else if player.lowEquation !== null && player.highEquation !== null}
              Both equations submitted, not yet ready…
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
    {@const allReady = calcPlayers.filter(p => !p.folded).every(p => $gameState?.phase === 'calculation' && $gameState.readyPlayerIds.includes(p.id))}
    <button
      type="button"
      onclick={doAdvanceToBetting2}
      disabled={!allReady}
    >
      Proceed to Betting Phase 2
    </button>
    <button type="button" onclick={debugFillAll} style="opacity:0.6;margin-left:1rem">
      Debug: auto-fill all equations
    </button>
  {:else}
    <p><em>Waiting for the host to advance to the next phase…</em></p>
  {/if}
</section>
