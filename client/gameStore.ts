/**
 * gameStore.ts — all cross-component state and game-action dispatchers.
 *
 * Components import from here; they never call src/ modules directly.
 * All game logic stays in src/; this file is pure orchestration.
 *
 * Networking modes
 * ────────────────
 * standalone — default; no WebRTC, everything runs locally.
 * host       — runs the game locally AND broadcasts every state change to
 *               connected peers via HostNetwork.  Incoming peer actions are
 *               dispatched to the same local functions so the host's game loop
 *               is the single source of truth.
 * peer       — receives state from the host via PeerNetwork; local action
 *               functions forward their arguments over the wire instead of
 *               running the game logic directly.
 */

import { writable, get } from 'svelte/store';
import type { GameState, Player, MultiplicationDecision, RoundResult } from '../src/types';
import type { BettingAction } from '../src/game';
import {
  createGame,
  startRound,
  collectForcedBets,
  applyBettingAction,
  resetBettingRound,
  applyBetChoices,
  recordBetChoice,
  recordEquationResults,
} from '../src/game';
import { evaluateEquation } from '../src/equation';
import { resolveRound, applyPayouts } from '../src/results';
import { runDealPhase1Async, runDealPhase2Async } from './dealing';
import {
  HostNetwork,
  PeerNetwork,
  serializeRoundResult,
  deserializeRoundResult,
} from './network';
import type { SerializedAction, LobbyState } from './network';

// ─── Stores ───────────────────────────────────────────────────────────────────

export const gameState = writable<GameState | null>(null);

/** Set while an async deal is in progress — disable action buttons. */
export const isDealing = writable(false);

/** Set when the dealing async function needs the active player to choose. */
export type PendingDecision = {
  player: Player;
  resolve: (d: MultiplicationDecision) => void;
};
export const pendingDecision = writable<PendingDecision | null>(null);

/** Populated once bet choices are submitted; cleared on next round. */
export const roundResult = writable<RoundResult | null>(null);

/** Current networking role. */
export const networkMode = writable<'standalone' | 'host' | 'peer'>('standalone');

/**
 * The player ID this client is playing as.
 * null  → no identity chosen yet; all players' state shown (standalone default).
 * set   → only that player's private state is shown; other players see public info only.
 */
export const localPlayerId = writable<string | null>(null);

/**
 * Pre-game lobby — shared across all clients before initGame is called.
 * Host is the source of truth; peers receive full snapshots via 'lobby' messages.
 */
export const lobbyState = writable<LobbyState>({
  players: [{ name: '' }, { name: '' }],
  startingChips: 50,
  forcedBetAmount: 1,
});

/**
 * The lobby slot index this client owns.
 * null   → standalone (no networking); all slots are locally controlled.
 * number → host (0) or peer (1+); only that slot's name is editable here.
 */
export const myPlayerIndex = writable<number | null>(null);

// ─── Network objects (module-level, not reactive) ─────────────────────────────

let hostNet: HostNetwork | null = null;
let peerNet: PeerNetwork | null = null;

// ─── Broadcast helpers ────────────────────────────────────────────────────────

// Whenever any of the three key stores change, push to all connected peers.
gameState.subscribe((s) => {
  if (s && hostNet) hostNet.broadcast({ type: 'state', payload: s });
});

roundResult.subscribe((r) => {
  if (hostNet) {
    hostNet.broadcast({
      type: 'roundResult',
      payload: r ? serializeRoundResult(r) : null,
    });
  }
});

pendingDecision.subscribe((pd) => {
  if (hostNet) {
    hostNet.broadcast({
      type: 'pendingDecision',
      payload: pd ? { player: pd.player } : null,
    });
  }
});

lobbyState.subscribe((ls) => {
  if (hostNet) hostNet.broadcast({ type: 'lobby', payload: ls });
});

// ─── Dealing helpers ──────────────────────────────────────────────────────────

/** Called by dealing.ts when a × card is drawn. Sets `pendingDecision` and
 *  returns a Promise that resolves once the player has chosen via `resolveDecision`. */
function makeRequestDecision(): (player: Player) => Promise<MultiplicationDecision> {
  return (player: Player) =>
    new Promise<MultiplicationDecision>((resolve) => {
      pendingDecision.set({ player, resolve });
    });
}

/** Called by the UI when the player submits their × choice. */
export function resolveDecision(decision: MultiplicationDecision): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'resolveDecision', args: [decision] } });
    return;
  }
  const current = get(pendingDecision);
  if (current) {
    current.resolve(decision);
    pendingDecision.set(null);
  }
}

// ─── Lobby actions ────────────────────────────────────────────────────────────

/**
 * Update the name for one lobby slot.
 * In peer mode the request is forwarded to the host; otherwise updates locally
 * (and the lobbyState subscription will broadcast to all peers if hosting).
 */
export function updateLobbyName(index: number, name: string): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'updateLobbyName', args: [index, name] } });
    return;
  }
  lobbyState.update((s) => {
    const players = s.players.map((p, i) => (i === index ? { ...p, name } : p));
    return { ...s, players };
  });
}

// ─── Game lifecycle ───────────────────────────────────────────────────────────

export function initGame(
  playerNames: string[],
  startingChips: number,
  forcedBetAmount: number,
): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'initGame', args: [playerNames, startingChips, forcedBetAmount] } });
    return;
  }
  const s = createGame(playerNames, startingChips, forcedBetAmount);
  gameState.set(startRound(s));
  roundResult.set(null);
  // Auto-assign localPlayerId from the lobby slot (skipped in standalone where index is null).
  const idx = get(myPlayerIndex);
  if (idx !== null) localPlayerId.set(`player-${idx}`);
}

export function doForcedBets(): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doForcedBets' } });
    return;
  }
  gameState.update((s) => (s ? collectForcedBets(s) : null));
}

export async function doDeal(phase: 1 | 2): Promise<void> {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doDeal', args: [phase] } });
    return;
  }
  const state = get(gameState);
  if (!state) return;
  isDealing.set(true);
  try {
    const requestDecision = makeRequestDecision();
    const onUpdate = (s: GameState) => gameState.set(s);
    const next =
      phase === 1
        ? await runDealPhase1Async(state, requestDecision, onUpdate)
        : await runDealPhase2Async(state, requestDecision, onUpdate);
    gameState.set(next);
  } finally {
    isDealing.set(false);
  }
}

// ─── Betting ──────────────────────────────────────────────────────────────────

export function doBettingAction(action: BettingAction): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doBettingAction', args: [action] } });
    return;
  }
  const state = get(gameState);
  if (!state) return;

  const { state: next, roundComplete } = applyBettingAction(state, action);

  if (!roundComplete) {
    gameState.set(next);
    return;
  }

  const activePlayers = next.players.filter((p) => !p.folded);
  if (activePlayers.length <= 1) {
    const resultState: GameState = { ...next, phase: 'results' };
    roundResult.set(resolveRound(resultState));
    gameState.set(resultState);
    return;
  }

  const nextPhase = state.phase === 'betting-1' ? 'dealing-2' : 'high-low-bet';
  gameState.set(resetBettingRound(next, nextPhase));
}

// ─── Calculation ──────────────────────────────────────────────────────────────

/** Validate an equation for a player and store the result. Returns an error string or null. */
export function submitEquation(
  playerId: string,
  target: 'low' | 'high',
  expression: string,
): string | null {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'submitEquation', args: [playerId, target, expression] } });
    // Optimistically return null; the host will validate and broadcast the real state
    return null;
  }
  const state = get(gameState);
  if (!state) return 'No game in progress';

  const player = state.players.find((p) => p.id === playerId);
  if (!player) return 'Player not found';

  const allCards = [
    ...(player.secretCard ? [player.secretCard] : []),
    ...player.faceUpCards,
    ...player.personalOperators,
  ];

  const result = evaluateEquation(expression, allCards);
  if (!result.ok) return result.error;

  const low = target === 'low' ? result.value : player.lowResult;
  const high = target === 'high' ? result.value : player.highResult;
  const lowEq = target === 'low' ? expression : player.lowEquation;
  const highEq = target === 'high' ? expression : player.highEquation;

  gameState.set(recordEquationResults(state, playerId, low, high, lowEq, highEq));
  return null;
}

export function doAdvanceToBetting2(): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doAdvanceToBetting2' } });
    return;
  }
  gameState.update((s) => (s ? resetBettingRound(s, 'betting-2') : null));
}

// ─── High/Low Bet ─────────────────────────────────────────────────────────────

/**
 * Internal helper: record one player's choice and, if everyone has now chosen,
 * resolve the round and advance to results.
 */
function applyOneChoice(state: GameState, playerId: string, choice: 'high' | 'low' | 'swing'): void {
  const { state: next, allChosen } = recordBetChoice(state, playerId, choice);
  if (allChosen) {
    const resultsState = { ...next, phase: 'results' as const };
    roundResult.set(resolveRound(resultsState));
    gameState.set(resultsState);
  } else {
    gameState.set(next);
  }
}

/**
 * Submit a single player's bet choice.  Used in networked play where each
 * client only controls their own player.
 *
 * In peer mode the action is forwarded to the host (with the player ID
 * included so the host knows whose choice it is).
 */
export function submitMyBetChoice(choice: 'high' | 'low' | 'swing'): void {
  const pid = get(localPlayerId);
  if (!pid) return;
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'submitMyBetChoice', args: [pid, choice] } });
    return;
  }
  const state = get(gameState);
  if (!state) return;
  applyOneChoice(state, pid, choice);
}

export function doSubmitBetChoices(choices: Map<string, Player['betChoice']>): void {
  if (get(networkMode) === 'peer') {
    const obj = Object.fromEntries(choices) as Record<string, 'high' | 'low' | 'swing' | null>;
    peerNet?.send({ type: 'action', payload: { name: 'doSubmitBetChoices', args: [obj] } });
    return;
  }
  const state = get(gameState);
  if (!state) return;
  const withChoices = applyBetChoices(state, choices);
  const result = resolveRound(withChoices);
  roundResult.set(result);
  gameState.set(withChoices);
}

// ─── Next round ───────────────────────────────────────────────────────────────

export function doNextRound(): void {
  if (get(networkMode) === 'peer') {
    peerNet?.send({ type: 'action', payload: { name: 'doNextRound' } });
    return;
  }
  const state = get(gameState);
  if (!state) return;
  const result = get(roundResult);
  const afterPayout = result ? applyPayouts(state, result) : state;
  roundResult.set(null);
  gameState.set(startRound(afterPayout));
}

// ─── Networking setup ─────────────────────────────────────────────────────────

/**
 * Initialise host mode and generate a WebRTC offer for one peer.
 * `peerId` is an arbitrary label (e.g. "peer-1") used to identify the
 * connection slot; it does not need to match any in-game player name.
 *
 * Returns the offer blob — a base-64 string the host shares out-of-band.
 */
export async function setupAsHost(peerId: string): Promise<string> {
  if (!hostNet) {
    hostNet = new HostNetwork();
    networkMode.set('host');
    myPlayerIndex.set(0); // host is always slot 0
    // Reset to just the host's slot; peer slots are added as peers connect.
    lobbyState.update((s) => ({ ...s, players: [{ name: '' }] }));

    hostNet.onMessage = (_pid, msg) => {
      applyPeerAction(msg.payload);
    };

    // When a peer's channel opens: assign them a lobby slot and sync state.
    hostNet.onConnected = (pid) => {
      // Add a new slot for this peer; the subscription will broadcast the lobby update.
      lobbyState.update((ls) => ({
        ...ls,
        players: [...ls.players, { name: '' }],
      }));
      const currentLobby = get(lobbyState);
      const peerIndex = currentLobby.players.length - 1;

      hostNet!.send(pid, { type: 'slotAssignment', payload: { playerIndex: peerIndex } });
      // Lobby is broadcast automatically via the subscription, but we also send
      // it directly in case the subscription fired before this peer was connected.
      hostNet!.send(pid, { type: 'lobby', payload: currentLobby });

      // Sync in-progress game state if the game has already started.
      const s = get(gameState);
      const r = get(roundResult);
      const pd = get(pendingDecision);
      if (s)  hostNet!.send(pid, { type: 'state', payload: s });
      if (r)  hostNet!.send(pid, { type: 'roundResult', payload: serializeRoundResult(r) });
      if (pd) hostNet!.send(pid, { type: 'pendingDecision', payload: { player: pd.player } });
    };
  }

  return hostNet.createOffer(peerId);
}

/**
 * Apply a peer's answer blob for an already-generated offer slot.
 * Call this after the peer has shared their answer back to the host.
 */
export async function acceptPeerAnswer(peerId: string, answerBlob: string): Promise<void> {
  await hostNet?.acceptAnswer(peerId, answerBlob);
}

/**
 * Initialise peer mode and connect to the host using their offer blob.
 * Returns the answer blob — a base-64 string the peer shares back to the host.
 */
export async function setupAsPeer(offerBlob: string): Promise<string> {
  peerNet = new PeerNetwork();
  networkMode.set('peer');

  peerNet.onMessage = (msg) => {
    switch (msg.type) {
      case 'state':
        gameState.set(msg.payload);
        // Auto-assign localPlayerId the first time a game state arrives.
        if (!get(localPlayerId)) {
          const idx = get(myPlayerIndex);
          if (idx !== null) localPlayerId.set(`player-${idx}`);
        }
        break;

      case 'roundResult':
        roundResult.set(msg.payload ? deserializeRoundResult(msg.payload) : null);
        break;

      case 'pendingDecision':
        if (msg.payload) {
          // Create a synthetic PendingDecision whose resolve sends a network action.
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
    }
  };

  return peerNet.connect(offerBlob);
}

/** Returns the IDs of all peers with an open data channel. */
export function getConnectedPeerIds(): string[] {
  return hostNet?.getConnectedPeerIds() ?? [];
}

// ─── Host-side peer action dispatcher ────────────────────────────────────────

/** Dispatch a serialised peer action to the corresponding local function. */
function applyPeerAction(action: SerializedAction): void {
  switch (action.name) {
    case 'initGame':
      initGame(...action.args);
      break;
    case 'doForcedBets':
      doForcedBets();
      break;
    case 'doDeal':
      void doDeal(action.args[0]);
      break;
    case 'doBettingAction':
      doBettingAction(action.args[0]);
      break;
    case 'submitEquation':
      submitEquation(...action.args);
      break;
    case 'doAdvanceToBetting2':
      doAdvanceToBetting2();
      break;
    case 'doSubmitBetChoices': {
      const obj = action.args[0];
      const map = new Map(
        Object.entries(obj) as [string, Player['betChoice']][],
      );
      doSubmitBetChoices(map);
      break;
    }
    case 'doNextRound':
      doNextRound();
      break;
    case 'resolveDecision':
      resolveDecision(action.args[0]);
      break;
    case 'updateLobbyName':
      updateLobbyName(action.args[0], action.args[1]);
      break;
    case 'submitMyBetChoice': {
      const [playerId, choice] = action.args;
      const state = get(gameState);
      if (state) applyOneChoice(state, playerId, choice);
      break;
    }
  }
}
