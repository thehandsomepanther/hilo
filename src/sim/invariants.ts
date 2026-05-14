import type { GameState, DealtPlayer } from '../types';

export class InvariantError extends Error {
  constructor(
    public readonly label: string,
    message: string,
    public readonly state: GameState,
  ) {
    super(`[${label}] ${message}`);
    this.name = 'InvariantError';
  }
}

const POST_DEAL_PHASES = new Set([
  'betting-1', 'betting-2', 'calculation', 'high-low-bet', 'results',
]);

const BETTING_PHASES = new Set(['betting-1', 'betting-2']);

export function checkInvariants(state: GameState, label: string, totalChips: number): void {
  // ── Chip conservation ──────────────────────────────────────────────────────
  // sum(player.chips) + pot must equal the initial chip count at every step
  // because all chips are either in a player's stack or in the pot.
  const chipSum = state.players.reduce((s, p) => s + p.chips, 0) + state.pot;
  if (chipSum !== totalChips) {
    throw new InvariantError(
      label,
      `chip conservation violated: ${chipSum} !== ${totalChips}`,
      state,
    );
  }

  // ── Zero limit ─────────────────────────────────────────────────────────────
  // At most 3 of the 4 zero-value cards may be dealt as secret cards in any
  // round (enforced by drawNumberCard's excludeValues logic).
  if (POST_DEAL_PHASES.has(state.phase)) {
    const dealtPlayers = state.players as DealtPlayer[];
    const zerosDealt = dealtPlayers.filter(
      (p) => !p.folded && p.secretCard?.value === 0,
    ).length;
    if (zerosDealt > 3) {
      throw new InvariantError(
        label,
        `more than 3 zeros dealt as secret cards: ${zerosDealt}`,
        state,
      );
    }
  }

  // ── Active player validity ─────────────────────────────────────────────────
  if (BETTING_PHASES.has(state.phase)) {
    type BS = Extract<GameState, { phase: 'betting-1' | 'betting-2' }>;
    const bs = state as BS;
    const active = bs.players[bs.activePlayerIndex];
    if (!active || active.folded) {
      throw new InvariantError(
        label,
        `activePlayerIndex ${bs.activePlayerIndex} points to folded or missing player`,
        state,
      );
    }
  }

  // ── Game-over correctness ──────────────────────────────────────────────────
  if (state.phase === 'game-over') {
    const solvent = state.players.filter((p) => p.chips > 0);
    if (solvent.length !== 1) {
      throw new InvariantError(
        label,
        `game-over with ${solvent.length} solvent player(s), expected 1`,
        state,
      );
    }
    if (state.winnerId !== solvent[0]!.id) {
      throw new InvariantError(
        label,
        `winnerId "${state.winnerId}" does not match solvent player "${solvent[0]!.id}"`,
        state,
      );
    }
  }
}
