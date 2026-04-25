/**
 * gameStore.ts — cross-component state and game-action dispatchers.
 *
 * Components import from here; they never call src/ modules directly.
 * All game logic lives in src/; this file is pure orchestration.
 *
 * The game's full state (including round results) lives in a single `gameState`
 * store — no separate `roundResult` store.  The `ResultsState` variant of
 * `GameState` carries `result: RoundResult` directly.
 *
 * Networking modes
 * ────────────────
 * standalone — default; no WebRTC, everything runs locally.
 * host       — runs the game locally AND broadcasts every state change to peers.
 *              Incoming peer actions are dispatched to the same local functions.
 * peer       — receives state from the host; local action functions forward
 *              arguments over the wire instead of running game logic directly.
 */

import { writable, get } from 'svelte/store';
import type {
  GameState, Player, DealtPlayer, MultiplicationDecision,
  Dealing1State, Dealing2State, BettingState, HighLowBetState,
  CalculationState, ResultsState,
} from '../src/types';
import type { BettingAction } from '../src/game';
import {
  createGame, startRound,
  collectForcedBets,
  applyBettingAction, advanceFromBetting,
  applyBetChoices, recordBetChoice, advanceFromHighLowBet,
  recordEquationResults, checkGameOver,
  advanceFromResults, initBettingRound,
} from '../src/game';
import type { RoundResult } from '../src/types';
import { evaluateEquation } from '../src/equation';
import { startDealPhase1, startDealPhase2 } from './dealing';
import type { DealStep } from './dealing';
import { HostNetwork, PeerNetwork, generateRoomId } from './network';
import type { SerializedAction, LobbyState } from './network';
export { generateRoomId } from './network';
import { startBotRunner } from './bots/botRunner';

// Re-export types that components need so they never import src/ directly.
export type { Player, DealtPlayer, Card } from '../src/types';

// ─── Stores ───────────────────────────────────────────────────────────────────

export const gameState = writable<GameState | null>(null);

/** Set while a deal step is in-flight (awaiting a × card decision or iterating). */
export const isDealing = writable(false);

/**
 * Set when dealing is suspended awaiting a × card decision.
 * Only the affected player (or host on their behalf) calls `resolveDecision`.
 */
export type PendingDecision = {
  player: Player;
  resolve: (d: MultiplicationDecision) => void;
};
export const pendingDecision = writable<PendingDecision | null>(null);

export const networkMode = writable<'standalone' | 'host' | 'peer'>('standalone');

/** Set to true when the host broadcasts proceedToSetup; peers watch this to auto-advance. */
export const lobbyProceed = writable(false);

export const localPlayerId = writable<string | null>(null);

export const lobbyState = writable<LobbyState>({
  players: [{ name: '', isBot: false }],
  startingChips: 50,
  enforceTimeLimit: false,
});

export const myPlayerIndex = writable<number | null>(null);

// ─── Network objects ──────────────────────────────────────────────────────────

let hostNet: HostNetwork | null = null;
let peerNet: PeerNetwork | null = null;
let stopBots: (() => void) | null = null;

/** Maps WebRTC peer ID → player index (e.g. 'peer-1' → 1). */
const peerPlayerIndex = new Map<string, number>();

/**
 * During the high-low-bet phase, strip betChoice from every player except the
 * one who owns `playerIndex`.  Prevents peers from seeing each other's hidden
 * choices before the reveal.
 */
function sanitizeStateForPeer(state: GameState, playerIndex: number): GameState {
  if (state.phase !== 'high-low-bet') return state;
  const playerId = `player-${playerIndex}`;
  return {
    ...state,
    players: state.players.map((p) => (p.id === playerId ? p : { ...p, betChoice: null })),
  } as GameState;
}

// Broadcast state changes to peers.
gameState.subscribe((s) => {
  if (!s || !hostNet) return;
  if (s.phase === 'high-low-bet') {
    // Send each peer only their own betChoice — others are hidden until reveal.
    for (const peerId of hostNet.getPeerIds()) {
      const idx = peerPlayerIndex.get(peerId);
      if (idx !== undefined) {
        hostNet.send(peerId, { type: 'state', payload: sanitizeStateForPeer(s, idx) });
      }
    }
  } else {
    hostNet.broadcast({ type: 'state', payload: s });
  }
});
pendingDecision.subscribe((pd) => {
  if (hostNet) hostNet.broadcast({ type: 'pendingDecision', payload: pd ? { player: pd.player } : null });
});
lobbyState.subscribe((ls) => {
  if (hostNet) hostNet.broadcast({ type: 'lobby', payload: ls });
});

// ─── Log helper ───────────────────────────────────────────────────────────────

function appendLog(state: GameState, entry: string): GameState {
  return { ...state, log: [...state.log, entry] } as GameState;
}

// ─── Dealing step runner ──────────────────────────────────────────────────────

/**
 * Drive a DealStep to completion, suspending on × card decisions.
 * Intermediate states are written to `gameState` for live UI updates.
 */
function runDealStep<Final extends GameState>(step: DealStep<Final>): void {
  if (step.status === 'complete') {
    isDealing.set(false);
    gameState.set(step.state);
    return;
  }

  // Pause on × card — write intermediate state and wait for resolveDecision.
  gameState.set(step.state as GameState);
  pendingDecision.set({
    player: step.player,
    resolve: (d: MultiplicationDecision) => {
      pendingDecision.set(null);
      runDealStep(step.resume(d));
    },
  });
}

// ─── Lobby actions ────────────────────────────────────────────────────────────

export function addPlayer(): void {
  lobbyState.update((s) => ({ ...s, players: [...s.players, { name: '', isBot: false }] }));
}

export function removePlayer(index: number): void {
  lobbyState.update((s) => ({ ...s, players: s.players.filter((_, i) => i !== index) }));
}

export function updateStartingChips(chips: number): void {
  lobbyState.update((s) => ({ ...s, startingChips: chips }));
}

export function updateEnforceTimeLimit(enforce: boolean): void {
  lobbyState.update((s) => ({ ...s, enforceTimeLimit: enforce }));
}


export function addBot(): void {
  lobbyState.update((s) => {
    const botCount = s.players.filter((p) => p.isBot).length;
    return { ...s, players: [...s.players, { name: `Bot ${botCount + 1}`, isBot: true }] };
  });
}

export function updateLobbyName(index: number, name: string): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'updateLobbyName', args: [index, name] } });
    return;
  }
  lobbyState.update((s) => ({
    ...s,
    players: s.players.map((p, i) => (i === index ? { ...p, name } : p)),
  }));
}

// ─── Game lifecycle ───────────────────────────────────────────────────────────

export function initGame(playerNames: string[], startingChips: number, enforceTimeLimit: boolean): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'initGame', args: [playerNames, startingChips, enforceTimeLimit] } });
    return;
  }
  const s = createGame(playerNames, startingChips, 90, enforceTimeLimit);
  gameState.set(startRound(s));
  const idx = get(myPlayerIndex);
  if (idx !== null) localPlayerId.set(`player-${idx}`);

  // Start bot runner for any bot slots (host and standalone only).
  stopBots?.();
  stopBots = null;
  const lobby = get(lobbyState);
  const botIds = new Set(
    lobby.players
      .map((p, i) => (p.isBot ? `player-${i}` : null))
      .filter((id): id is string => id !== null),
  );
  if (botIds.size > 0) stopBots = startBotRunner(botIds);
}

export function doForcedBets(): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doForcedBets' } });
    return;
  }
  gameState.update((s) => {
    if (!s || s.phase !== 'forced-bet') return s;
    const next = collectForcedBets(s);
    return appendLog(next, `Forced bets collected — pot: ${next.pot}`);
  });
}

export function doDeal(phase: 1 | 2): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doDeal', args: [phase] } });
    return;
  }
  const state = get(gameState);
  if (!state) return;

  isDealing.set(true);

  if (phase === 1) {
    if (state.phase !== 'dealing-1') return;
    const step = startDealPhase1(state as Dealing1State);
    runDealStep(step);
  } else {
    if (state.phase !== 'dealing-2') return;
    const step = startDealPhase2(state as Dealing2State);
    runDealStep(step);
  }
}

/** Called by the UI when the player submits their × card choice. */
export function resolveDecision(decision: MultiplicationDecision): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'resolveDecision', args: [decision] } });
    return;
  }
  const current = get(pendingDecision);
  if (current) current.resolve(decision);
}

// ─── Betting ──────────────────────────────────────────────────────────────────

export function doBettingAction(action: BettingAction): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doBettingAction', args: [action] } });
    return;
  }
  const state = get(gameState);
  if (!state || (state.phase !== 'betting-1' && state.phase !== 'betting-2')) return;

  const bettingState = state as BettingState;
  const player = bettingState.players[bettingState.activePlayerIndex];
  const playerName = player?.name ?? 'Unknown';

  let logEntry: string;
  switch (action.type) {
    case 'check':  logEntry = `${playerName} checked`; break;
    case 'call': {
      const amount = Math.min((bettingState.currentBet) - (player?.currentBet ?? 0), player?.chips ?? 0);
      logEntry = `${playerName} called ${amount} chip(s)`;
      break;
    }
    case 'raise': logEntry = `${playerName} raised to ${action.amount}`; break;
    case 'fold':  logEntry = `${playerName} folded`; break;
  }

  const { state: next, roundComplete } = applyBettingAction(bettingState, action);
  const withLog = appendLog(next, logEntry!) as BettingState;

  if (!roundComplete) {
    gameState.set(withLog);
    return;
  }

  gameState.set(advanceFromBetting(withLog));
}

// ─── Calculation ──────────────────────────────────────────────────────────────

export function submitEquation(playerId: string, target: 'low' | 'high', expression: string): string | null {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'submitEquation', args: [playerId, target, expression] } });
    return null;
  }
  const state = get(gameState);
  if (!state || state.phase !== 'calculation') return 'No calculation phase active';

  const calcState = state as CalculationState;
  const player = calcState.players.find((p) => p.id === playerId);
  if (!player) return 'Player not found';

  const allCards = [player.secretCard, ...player.faceUpCards, ...player.personalOperators];
  const result = evaluateEquation(expression, allCards);
  if (!result.ok) return result.error;

  const low    = target === 'low'  ? result.value    : player.lowResult;
  const high   = target === 'high' ? result.value    : player.highResult;
  const lowEq  = target === 'low'  ? expression      : player.lowEquation;
  const highEq = target === 'high' ? expression      : player.highEquation;

  const updated = recordEquationResults(calcState, playerId, low, high, lowEq, highEq);
  gameState.set(appendLog(updated, `${player.name} submitted their ${target} equation`));
  return null;
}

export function unsubmitEquation(playerId: string, target: 'low' | 'high'): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'unsubmitEquation', args: [playerId, target] } });
    return;
  }
  const state = get(gameState);
  if (!state || state.phase !== 'calculation') return;

  const calcState = state as CalculationState;
  const player = calcState.players.find((p) => p.id === playerId);
  if (!player) return;

  const low    = target === 'low'  ? null : player.lowResult;
  const high   = target === 'high' ? null : player.highResult;
  const lowEq  = target === 'low'  ? null : player.lowEquation;
  const highEq = target === 'high' ? null : player.highEquation;

  const updated = recordEquationResults(calcState, playerId, low, high, lowEq, highEq);
  gameState.set(appendLog(updated, `${player.name} retracted their ${target} equation`));
}

export function doAdvanceToBetting2(): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doAdvanceToBetting2' } });
    return;
  }
  const state = get(gameState);
  if (!state || state.phase !== 'calculation') return;
  gameState.set(initBettingRound(state as CalculationState, 'betting-2'));
}

/**
 * Enforce the calculation time limit: fold players with no equations, then
 * advance to betting-2.  If only one player survives, jump straight to results.
 * Only runs on the host / standalone side.
 */
export function expireCalculationPhase(): void {
  if (get(networkMode) === 'peer') return;
  const state = get(gameState);
  if (!state || state.phase !== 'calculation') return;
  const cs = state as CalculationState;

  const players = cs.players.map((p) => {
    if (p.folded || p.lowEquation !== null || p.highEquation !== null) return p;
    return { ...p, folded: true };
  });

  const foldedNames = cs.players
    .filter((p, i) => !p.folded && players[i]!.folded)
    .map((p) => p.name);
  let updated: CalculationState = {
    ...cs,
    players,
    log: foldedNames.length > 0
      ? [...cs.log, `Time expired — ${foldedNames.join(', ')} folded (no equations submitted)`]
      : cs.log,
  };

  const active = players.filter((p) => !p.folded);
  if (active.length <= 1) {
    const winner = active[0];
    const result: RoundResult = winner
      ? { kind: 'last-player-standing', winnerId: winner.id, payout: updated.pot }
      : { kind: 'contested', lowWinnerId: null, highWinnerId: null, payouts: { __rollover__: updated.pot } };
    gameState.set({ ...updated, phase: 'results', result });
    return;
  }

  gameState.set(initBettingRound(updated, 'betting-2'));
}

// ─── High/Low Bet ─────────────────────────────────────────────────────────────

function applyOneChoice(state: HighLowBetState, playerId: string, choice: 'high' | 'low' | 'swing'): void {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || player.folded) return;
  const playerName = player.name;
  const { state: next, allChosen } = recordBetChoice(state, playerId, choice);
  const withLog = appendLog(next, `${playerName} chose ${choice}`) as HighLowBetState;
  gameState.set(allChosen ? advanceFromHighLowBet(withLog) : withLog);
}

export function submitMyBetChoice(choice: 'high' | 'low' | 'swing'): void {
  const pid = get(localPlayerId);
  if (!pid) return;
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'submitMyBetChoice', args: [pid, choice] } });
    return;
  }
  const state = get(gameState);
  if (!state || state.phase !== 'high-low-bet') return;
  applyOneChoice(state as HighLowBetState, pid, choice);
}

export function doSubmitBetChoices(choices: Map<string, DealtPlayer['betChoice']>): void {
  if (get(networkMode) === 'peer') {
    const obj = Object.fromEntries(choices) as Record<string, 'high' | 'low' | 'swing' | null>;
    peerNet?.send({ type: 'action', payload: { name: 'doSubmitBetChoices', args: [obj] } });
    return;
  }
  const state = get(gameState);
  if (!state || state.phase !== 'high-low-bet') return;
  const hlState = state as HighLowBetState;
  const withChoices = applyBetChoices(hlState, choices);
  const entries = [...choices.entries()]
    .map(([id, c]) => `${hlState.players.find((p) => p.id === id)?.name ?? id} chose ${c}`)
    .join('; ');
  const withLog = appendLog(withChoices, entries) as HighLowBetState;
  gameState.set(advanceFromHighLowBet(withLog));
}

// ─── Next round / play again ──────────────────────────────────────────────────

export function doNextRound(): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doNextRound' } });
    return;
  }
  const state = get(gameState);
  if (!state || state.phase !== 'results') return;
  gameState.set(advanceFromResults(state as ResultsState));
}

export function doPlayAgain(): void {
  stopBots?.();
  stopBots = null;
  peerPlayerIndex.clear();
  gameState.set(null);
}

/**
 * Submit a high/low bet choice on behalf of a bot player.
 * Bots run on the host tab and cannot use submitMyBetChoice (which is tied
 * to localPlayerId).  This bypasses the localPlayerId check.
 */
export function submitBotBetChoice(playerId: string, choice: 'high' | 'low' | 'swing'): void {
  const state = get(gameState);
  if (!state || state.phase !== 'high-low-bet') return;
  applyOneChoice(state as HighLowBetState, playerId, choice);
}

// ─── Networking setup ─────────────────────────────────────────────────────────

export function setupAsHost(roomId: string, workerUrl?: string): void {
  if (hostNet) return;
  hostNet = new HostNetwork(roomId, workerUrl);
  networkMode.set('host');
  myPlayerIndex.set(0);
  lobbyState.update((s) => ({ ...s, players: [{ name: '', isBot: false }] }));

  hostNet.onMessage = (_pid, msg) => { applyPeerAction(msg.payload); };

  hostNet.onConnected = (pid) => {
    lobbyState.update((ls) => ({ ...ls, players: [...ls.players, { name: '', isBot: false }] }));
    const currentLobby = get(lobbyState);
    const peerIndex = currentLobby.players.length - 1;
    peerPlayerIndex.set(pid, peerIndex);
    hostNet!.send(pid, { type: 'slotAssignment', payload: { playerIndex: peerIndex } });
    hostNet!.send(pid, { type: 'lobby', payload: currentLobby });
    const s = get(gameState);
    const pd = get(pendingDecision);
    if (s)  hostNet!.send(pid, { type: 'state', payload: s });
    if (pd) hostNet!.send(pid, { type: 'pendingDecision', payload: { player: pd.player } });
  };

  hostNet.start();
}

export function setupAsPeer(roomId: string, workerUrl?: string): void {
  peerNet = new PeerNetwork(roomId, workerUrl);
  networkMode.set('peer');

  peerNet.onMessage = (msg) => {
    switch (msg.type) {
      case 'state':
        gameState.set(msg.payload);
        if (!get(localPlayerId)) {
          const idx = get(myPlayerIndex);
          if (idx !== null) localPlayerId.set(`player-${idx}`);
        }
        break;
      case 'pendingDecision':
        if (msg.payload) {
          pendingDecision.set({
            player: msg.payload.player,
            resolve: (d) => {
              peerNet?.send({ type: 'action', payload: { name: 'resolveDecision', args: [d] } });
            },
          });
        } else {
          pendingDecision.set(null);
        }
        break;
      case 'lobby':
        lobbyState.set(msg.payload);
        break;
      case 'slotAssignment':
        myPlayerIndex.set(msg.payload.playerIndex);
        break;
      case 'proceedToSetup':
        peerNet?.stopPolling();
        lobbyProceed.set(true);
        break;
    }
  };

  peerNet.start();
}

/** Host calls this when clicking "Done" — signals all peers to advance past the lobby. */
export function hostProceed(): void {
  hostNet?.broadcast({ type: 'proceedToSetup' });
  hostNet?.stopPolling();
}

export function getConnectedPeerIds(): string[] {
  return hostNet?.getConnectedPeerIds() ?? [];
}

// ─── Host-side peer action dispatcher ────────────────────────────────────────

function applyPeerAction(action: SerializedAction): void {
  switch (action.name) {
    case 'initGame':           initGame(...action.args); break;
    case 'doForcedBets':       doForcedBets(); break;
    case 'doDeal':             doDeal(action.args[0]); break;
    case 'doBettingAction':    doBettingAction(action.args[0]); break;
    case 'submitEquation':     submitEquation(action.args[0], action.args[1], action.args[2]); break;
    case 'unsubmitEquation':   unsubmitEquation(action.args[0], action.args[1]); break;
    case 'doAdvanceToBetting2': doAdvanceToBetting2(); break;
    case 'doSubmitBetChoices': {
      const map = new Map(Object.entries(action.args[0]) as [string, DealtPlayer['betChoice']][]);
      doSubmitBetChoices(map);
      break;
    }
    case 'doNextRound':        doNextRound(); break;
    case 'resolveDecision':    resolveDecision(action.args[0]); break;
    case 'updateLobbyName':    updateLobbyName(action.args[0], action.args[1]); break;
    case 'submitMyBetChoice': {
      const state = get(gameState);
      if (state?.phase === 'high-low-bet') applyOneChoice(state as HighLowBetState, action.args[0], action.args[1]);
      break;
    }
  }
}
