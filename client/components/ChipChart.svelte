<script lang="ts">
  interface Props {
    chipHistory: Array<Record<string, number>>;
    players: Array<{ id: string; name: string }>;
  }

  const { chipHistory, players }: Props = $props();

  const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'];

  const W = 600, H = 240;
  const PL = 45, PR = 15, PT = 15, PB = 35;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  const rounds = $derived(chipHistory.length - 1);
  const maxChips = $derived(
    Math.max(1, ...chipHistory.flatMap((snap) => Object.values(snap))),
  );
  const yTicks = $derived([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxChips * f)));

  const xLabelIndices = $derived((() => {
    if (rounds <= 10) return chipHistory.map((_, i) => i);
    const maxTicks = 8;
    const step = Math.ceil(rounds / maxTicks);
    const indices: number[] = [];
    for (let i = 0; i <= rounds; i += step) indices.push(i);
    if (indices[indices.length - 1] !== rounds) indices.push(rounds);
    return indices;
  })());

  function xPos(i: number): number {
    return PL + (rounds > 0 ? (i / rounds) * plotW : 0);
  }

  function yPos(chips: number): number {
    return PT + plotH - (chips / maxChips) * plotH;
  }

  function playerPoints(pid: string): string {
    return chipHistory.map((snap, i) => `${xPos(i)},${yPos(snap[pid] ?? 0)}`).join(' ');
  }
</script>

<div class="chart-wrap">
  <svg viewBox="0 0 {W} {H}" width="100%">
    <!-- Grid lines and Y-axis labels -->
    {#each yTicks as val}
      {@const y = yPos(val)}
      <line x1={PL - 4} y1={y} x2={W - PR} y2={y} stroke="#e0e0e0" stroke-width="1" />
      <text x={PL - 8} y={y + 4} text-anchor="end" font-size="11" fill="#888">{val}</text>
    {/each}

    <!-- X-axis labels -->
    {#each xLabelIndices as i}
      <text x={xPos(i)} y={H - PB + 18} text-anchor="middle" font-size="11" fill="#888">
        {i === 0 ? 'Start' : i}
      </text>
    {/each}

    <!-- Axes -->
    <line x1={PL} y1={PT} x2={PL} y2={H - PB} stroke="#aaa" stroke-width="1.5" />
    <line x1={PL} y1={H - PB} x2={W - PR} y2={H - PB} stroke="#aaa" stroke-width="1.5" />

    <!-- Player lines -->
    {#each players as player, pi}
      <polyline
        points={playerPoints(player.id)}
        fill="none"
        stroke={COLORS[pi % COLORS.length]}
        stroke-width="2.5"
        stroke-linejoin="round"
        stroke-linecap="round"
      />
    {/each}

    <!-- Final-round dots -->
    {#each players as player, pi}
      {@const lastSnap = chipHistory[chipHistory.length - 1]}
      {#if lastSnap}
        <circle
          cx={xPos(rounds)}
          cy={yPos(lastSnap[player.id] ?? 0)}
          r="4"
          fill={COLORS[pi % COLORS.length]}
        />
      {/if}
    {/each}
  </svg>

  <div class="legend">
    {#each players as player, pi}
      <span class="legend-item">
        <span class="swatch" style="background:{COLORS[pi % COLORS.length]}"></span>
        {player.name}
      </span>
    {/each}
  </div>
</div>

<style>
  .chart-wrap {
    margin-top: 1rem;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 1rem;
    margin-top: 0.5rem;
    font-size: 0.85rem;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .swatch {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    flex-shrink: 0;
  }
</style>
