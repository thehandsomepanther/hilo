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
 *              Forwarded actions are queued until the host acks them, so an
 *              action taken during a connection blip is never lost.
 */

import { writable, derived, get } from 'svelte/store';
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
import { HostNetwork, PeerNetwork, generateClientId, HOST_CLIENT_ID } from './network';
import type { SerializedAction, LobbyState, JoinRejection } from './network';
import type { Transport } from './transport';
import { VersionCounter, VersionGate, HEARTBEAT_INTERVAL_MS } from './protocol';
import { seatToken, seatName, rememberSeatName } from './identity';
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

// ─── Connection status ────────────────────────────────────────────────────────

/**
 * Seats with a live connection to the host, maintained by the host and
 * broadcast so every client shows the same picture.  The host's own seat is
 * included; bot seats are not (they have no connection) — use `seatOnline`,
 * which folds them in.
 */
export const connectedSeats = writable<number[]>([]);

/** Peer side: is the host reachable?  Driven by `peerclose` and the heartbeat. */
export const hostLinkUp = writable(true);

/** Peer side: actions sent but not yet acked — nonzero means "not through yet". */
export const queuedActionCount = writable(0);

/** Set when the host refuses this client a seat. */
export const joinRejected = writable<JoinRejection | null>(null);

/**
 * Per-seat "is this player present" flags, aligned with `lobbyState.players`.
 * Bots run on the host tab and are always present; standalone has no network
 * to lose.
 */
export const seatOnline = derived(
  [connectedSeats, lobbyState, networkMode],
  ([seats, lobby, mode]) =>
    lobby.players.map((p, i) => mode === 'standalone' || p.isBot || seats.includes(i)),
);

/**
 * A peer treats silence as a disconnect after this long.  The host heartbeats
 * every HEARTBEAT_INTERVAL_MS, so three missed beats is a real outage rather
 * than a slow tick — and `peerclose` usually reports it sooner.
 */
export const HOST_SILENCE_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3;

// ─── Network objects ──────────────────────────────────────────────────────────

let hostNet: HostNetwork | null = null;
let peerNet: PeerNetwork | null = null;
let stopBots: (() => void) | null = null;

/**
 * Host-side seat bookkeeping.
 *
 * `seatTokens` is the durable one: a peer's identity token → the seat it owns,
 * which is what lets a reloaded player reclaim their chips and cards. The other
 * two are keyed by transport connection id, which changes on every page load,
 * and are re-pointed at the new connection when a known token says hello.
 */
const peerPlayerIndex = new Map<string, number>();   // connection → seat
const peerTokens = new Map<string, string>();        // connection → token
const seatTokens = new Map<string, number>();        // token → seat

/**
 * True once the lobby is closed.  Before that, signalling stays 'active' for
 * discovery; after it, the host idles down to a cheap keepalive whenever
 * everyone is present.
 */
let pastLobby = false;

/**
 * Host side: per-message-type version counter (see protocol.ts).  New
 * snapshots are stamped with `next()`; rebroadcasts of the same snapshot
 * (heartbeat, late-joining peer) reuse `current()` so peers that already
 * applied it drop the duplicate.
 */
let msgVersions = new VersionCounter();

/** Peer side: drops stale/duplicate host messages by version. */
let hostMsgGate = new VersionGate();

/** Host side: rebroadcasts current snapshots every HEARTBEAT_INTERVAL_MS. */
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

/** Peer side: watches for host silence.  See `hostSilenceWatchdog`. */
const HOST_WATCHDOG_TICK_MS = 1000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastHostMsgAt = 0;

/** The room this peer joined — the key its seat identity is stored under. */
let peerRoomId: string | null = null;

function noteHostAlive(): void {
  lastHostMsgAt = Date.now();
  // Only write on an actual transition — this runs on every heartbeat.
  if (!get(hostLinkUp)) {
    hostLinkUp.set(true);
    updatePeerPolling();
  }
}

/**
 * `peerclose` is the authoritative disconnect signal but can lag a real outage
 * by tens of seconds (ICE has to time out first), and a half-open channel may
 * never fire it at all.  The heartbeat is the faster, surer tell: if the host
 * has gone quiet for three beats, treat the link as down.
 *
 * Only meaningful once a game is running — the host deliberately doesn't
 * heartbeat in the lobby, so silence there isn't evidence of anything.
 */
function hostSilenceWatchdog(): void {
  if (!peerNet || !get(gameState)) return;
  if (Date.now() - lastHostMsgAt > HOST_SILENCE_TIMEOUT_MS) {
    hostLinkUp.set(false);
    updatePeerPolling();
  }
}

/**
 * Peer side: forward an action to the host.  PeerNetwork queues it and retries
 * until acked, so this never silently drops — an action taken during a
 * connection blip lands when the link returns.  `playerId` rides along for
 * host-side attribution.
 */
function sendToHost(payload: SerializedAction): void {
  peerNet?.sendAction(payload, get(localPlayerId));
}

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

/** Send a state snapshot to every peer, stamped with version `v`. */
function broadcastState(s: GameState, v: number): void {
  if (!hostNet) return;
  if (s.phase === 'high-low-bet') {
    // Send each peer only their own betChoice — others are hidden until reveal.
    for (const peerId of hostNet.getPeerIds()) {
      const idx = peerPlayerIndex.get(peerId);
      if (idx !== undefined) {
        hostNet.send(peerId, { type: 'state', v, payload: sanitizeStateForPeer(s, idx) });
      }
    }
  } else {
    hostNet.broadcast({ type: 'state', v, payload: s });
  }
}

function broadcastPendingDecision(pd: PendingDecision | null, v: number): void {
  hostNet?.broadcast({ type: 'pendingDecision', v, payload: pd ? { player: pd.player } : null });
}

// Broadcast state changes to peers.  Each change gets a fresh version.
gameState.subscribe((s) => {
  if (!s || !hostNet) return;
  broadcastState(s, msgVersions.next('state'));
});
pendingDecision.subscribe((pd) => {
  if (hostNet) broadcastPendingDecision(pd, msgVersions.next('pendingDecision'));
});
lobbyState.subscribe((ls) => {
  if (hostNet) hostNet.broadcast({ type: 'lobby', v: msgVersions.next('lobby'), payload: ls });
});
connectedSeats.subscribe((seats) => {
  if (hostNet) hostNet.broadcast({ type: 'connections', v: msgVersions.next('connections'), payload: seats });
});

/**
 * Heartbeat: while a game is active, rebroadcast the current snapshots at
 * their CURRENT versions.  Peers that already applied them drop the
 * duplicates; a peer that missed a broadcast (connection blip, silent send
 * drop) is healed within one interval instead of freezing forever.
 */
function heartbeat(): void {
  if (!hostNet) return;
  const s = get(gameState);
  if (!s) return;
  broadcastState(s, msgVersions.current('state'));
  broadcastPendingDecision(get(pendingDecision), msgVersions.current('pendingDecision'));
  hostNet.broadcast({ type: 'lobby', v: msgVersions.current('lobby'), payload: get(lobbyState) });
  hostNet.broadcast({
    type: 'connections',
    v: msgVersions.current('connections'),
    payload: get(connectedSeats),
  });
}

// ─── Host-side connection tracking ───────────────────────────────────────────

function setSeatConnected(seat: number, connected: boolean): void {
  const seats = get(connectedSeats);
  if (seats.includes(seat) === connected) return; // no change, no rebroadcast
  connectedSeats.set(
    connected ? [...seats, seat].sort((a, b) => a - b) : seats.filter((s) => s !== seat),
  );
}

/**
 * Signalling costs Worker traffic, so idle down to a keepalive once the lobby
 * is closed AND every seated player is present.  Any absence flips discovery
 * back on: polling is the only thing that can re-establish the connection.
 */
function updateHostPolling(): void {
  if (!hostNet) return;
  const seats = get(connectedSeats);
  const everyoneHere = [...seatTokens.values()].every((seat) => seats.includes(seat));
  hostNet.setPollingMode(pastLobby && everyoneHere ? 'idle' : 'active');
}

function updatePeerPolling(): void {
  if (!peerNet) return;
  // `hostLinkUp` also covers the half-open case the transport hasn't noticed.
  const linkUp = peerNet.isConnected() && get(hostLinkUp);
  peerNet.setPollingMode(pastLobby && linkUp ? 'idle' : 'active');
}

// ─── Connectivity changes ────────────────────────────────────────────────────

/**
 * Something happened that could have changed our address or interrupted us:
 * the network came back, or a backgrounded tab was foregrounded (its timers
 * throttled to a crawl while it was away, so everything below is overdue).
 *
 * Re-announce immediately rather than waiting out an idle interval — on a
 * phone switching from wifi to cellular, that wait is most of the time spent
 * staring at "reconnecting".  Exported because the browser listeners are not
 * the only sensible caller: a manual "retry" control would do exactly this.
 */
export function noteConnectivityChange(): void {
  // A hidden tab is going away, not coming back; nothing to re-announce yet.
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  updateHostPolling();
  updatePeerPolling();
  hostNet?.wake();
  peerNet?.wake();
}

let connectivityListening = false;

function listenForConnectivityChanges(): void {
  if (connectivityListening || typeof window === 'undefined') return;
  window.addEventListener('online', noteConnectivityChange);
  document.addEventListener('visibilitychange', noteConnectivityChange);
  connectivityListening = true;
}

function stopListeningForConnectivityChanges(): void {
  if (!connectivityListening || typeof window === 'undefined') return;
  window.removeEventListener('online', noteConnectivityChange);
  document.removeEventListener('visibilitychange', noteConnectivityChange);
  connectivityListening = false;
}

/**
 * Bring one peer up to date: its seat number, then every current snapshot at
 * its CURRENT version.  Used both for a first join and for every reconnect —
 * a peer that missed changes while away applies them; one that didn't drops
 * them by version.
 */
function sendSnapshotsTo(peerId: string, seat: number): void {
  if (!hostNet) return;
  hostNet.send(peerId, { type: 'slotAssignment', payload: { playerIndex: seat } });
  hostNet.send(peerId, { type: 'lobby', v: msgVersions.current('lobby'), payload: get(lobbyState) });
  hostNet.send(peerId, {
    type: 'connections',
    v: msgVersions.current('connections'),
    payload: get(connectedSeats),
  });
  const s = get(gameState);
  if (s) {
    hostNet.send(peerId, {
      type: 'state',
      v: msgVersions.current('state'),
      payload: sanitizeStateForPeer(s, seat),
    });
  }
  const pd = get(pendingDecision);
  if (pd) {
    hostNet.send(peerId, {
      type: 'pendingDecision',
      v: msgVersions.current('pendingDecision'),
      payload: { player: pd.player },
    });
  }
  if (pastLobby) hostNet.send(peerId, { type: 'proceedToSetup' });
}

/**
 * A peer has claimed an identity.  Either it's a token we know — in which case
 * it keeps its seat and we just re-point the connection at it — or it's a new
 * player, who gets a fresh lobby slot.  New players are turned away once a game
 * is underway: appending a slot mid-game would corrupt the lobby, and the
 * engine has no notion of a player joining a round in progress.
 */
function handleHello(peerId: string, token: string, name: string): void {
  if (!hostNet) return;
  let seat = seatTokens.get(token);

  if (seat === undefined) {
    if (get(gameState) !== null) {
      hostNet.send(peerId, { type: 'rejected', reason: 'game-in-progress' });
      return;
    }
    lobbyState.update((ls) => ({ ...ls, players: [...ls.players, { name, isBot: false }] }));
    seat = get(lobbyState).players.length - 1;
    seatTokens.set(token, seat);
  } else {
    // Returning player: forget the connection this token used to arrive on, so
    // a stale entry can't keep receiving their sanitized state.
    for (const [oldPeerId, t] of [...peerTokens]) {
      if (t === token && oldPeerId !== peerId) {
        peerTokens.delete(oldPeerId);
        peerPlayerIndex.delete(oldPeerId);
      }
    }
  }

  peerPlayerIndex.set(peerId, seat);
  peerTokens.set(peerId, token);
  setSeatConnected(seat, true);
  sendSnapshotsTo(peerId, seat);
  updateHostPolling();
}

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
  reseatAfterRemoval(index);
}

/**
 * Removing a lobby slot renumbers every seat below it, so the host's seat maps
 * and each affected peer's `myPlayerIndex` have to shift with it.  In practice
 * this fires when the host drops a bot from a lobby that peers have already
 * joined; without it those peers would keep pointing at their old index and
 * start the game as the wrong player.
 */
function reseatAfterRemoval(removed: number): void {
  if (!hostNet) return;
  const shift = (seat: number) => (seat > removed ? seat - 1 : seat);

  for (const [token, seat] of [...seatTokens]) {
    if (seat === removed) seatTokens.delete(token);
    else seatTokens.set(token, shift(seat));
  }
  for (const [peerId, seat] of [...peerPlayerIndex]) {
    if (seat === removed) {
      peerPlayerIndex.delete(peerId);
      peerTokens.delete(peerId);
      continue;
    }
    if (seat > removed) {
      peerPlayerIndex.set(peerId, seat - 1);
      hostNet.send(peerId, { type: 'slotAssignment', payload: { playerIndex: seat - 1 } });
    }
  }
  connectedSeats.set(
    get(connectedSeats).filter((s) => s !== removed).map(shift),
  );
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
    // Remember our own name so a reload can propose it again in `hello`.
    if (peerRoomId !== null && index === get(myPlayerIndex)) {
      rememberSeatName(peerRoomId, name);
    }
    sendToHost({ name: 'updateLobbyName', args: [index, name] });
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
    sendToHost({ name: 'initGame', args: [playerNames, startingChips, enforceTimeLimit] });
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
    sendToHost({ name: 'doForcedBets' });
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
    sendToHost({ name: 'doDeal', args: [phase] });
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
    sendToHost({ name: 'resolveDecision', args: [decision] });
    return;
  }
  const current = get(pendingDecision);
  if (current) current.resolve(decision);
}

// ─── Betting ──────────────────────────────────────────────────────────────────

export function doBettingAction(action: BettingAction): void {
  if (get(networkMode) === 'peer') {
    sendToHost({ name: 'doBettingAction', args: [action] });
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
    sendToHost({ name: 'submitEquation', args: [playerId, target, expression] });
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
    sendToHost({ name: 'unsubmitEquation', args: [playerId, target] });
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
  // Retracting withdraws readiness.  Otherwise a player who edits a submitted
  // equation stays ready, the host can advance the phase while they are still
  // mid-edit, and they reach results with a missing equation — which forfeits
  // that half of the pot.
  const withdrawn: CalculationState = {
    ...updated,
    readyPlayerIds: updated.readyPlayerIds.filter((id) => id !== playerId),
  };
  gameState.set(appendLog(withdrawn, `${player.name} retracted their ${target} equation`));
}

export function setPlayerReady(playerId: string): void {
  if (get(networkMode) === 'peer') {
    sendToHost({ name: 'setPlayerReady', args: [playerId] });
    return;
  }
  gameState.update((s) => {
    if (!s || s.phase !== 'calculation') return s;
    const cs = s as CalculationState;
    if (cs.readyPlayerIds.includes(playerId)) return s;
    // "Ready" asserts both equations are locked in — it can't outlive them.
    // The UI disables the button, but a late-arriving peer message could still
    // land after a retract, and the host is the one that has to be sure.
    const player = cs.players.find((p) => p.id === playerId);
    if (!player || player.lowEquation === null || player.highEquation === null) return s;
    return { ...cs, readyPlayerIds: [...cs.readyPlayerIds, playerId] };
  });
}

export function doAdvanceToBetting2(): void {
  if (get(networkMode) === 'peer') {
    sendToHost({ name: 'doAdvanceToBetting2' });
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
  const { state: next, allChosen } = recordBetChoice(state, playerId, choice);
  const pending = appendLog(next, `${player.name} submitted their bet`) as HighLowBetState;
  if (!allChosen) { gameState.set(pending); return; }
  // All players have chosen — now safe to reveal choices in the log.
  const summary = pending.players
    .filter((p) => !p.folded && p.betChoice !== null)
    .map((p) => `${p.name} chose ${p.betChoice}`)
    .join('; ');
  const withLog = appendLog(pending, summary) as HighLowBetState;
  gameState.set(advanceFromHighLowBet(withLog));
}

export function submitMyBetChoice(choice: 'high' | 'low' | 'swing'): void {
  const pid = get(localPlayerId);
  if (!pid) return;
  if (get(networkMode) === 'peer') {
    sendToHost({ name: 'submitMyBetChoice', args: [pid, choice] });
    return;
  }
  const state = get(gameState);
  if (!state || state.phase !== 'high-low-bet') return;
  applyOneChoice(state as HighLowBetState, pid, choice);
}

export function doSubmitBetChoices(choices: Map<string, DealtPlayer['betChoice']>): void {
  if (get(networkMode) === 'peer') {
    const obj = Object.fromEntries(choices) as Record<string, 'high' | 'low' | 'swing' | null>;
    sendToHost({ name: 'doSubmitBetChoices', args: [obj] });
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
    sendToHost({ name: 'doNextRound' });
    return;
  }
  const state = get(gameState);
  if (!state || state.phase !== 'results') return;
  gameState.set(advanceFromResults(state as ResultsState));
}

export function doPlayAgain(): void {
  stopBots?.();
  stopBots = null;
  // Seats and connections survive: the same players are going back to the same
  // lobby.  Clearing the peer maps here would orphan every live connection —
  // peers only say `hello` once per page load, so nothing would re-seat them.
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

export async function setupAsHost(roomId: string, workerUrl?: string, transport?: Transport): Promise<void> {
  if (hostNet) return;
  if (!transport) {
    // p2pcf pulls in browser-only modules — load it lazily so Node (tests)
    // never touches it.
    const { createP2pcfTransport } = await import('./p2pcfTransport');
    transport = await createP2pcfTransport(HOST_CLIENT_ID, roomId, workerUrl);
  }
  hostNet = new HostNetwork(transport);
  networkMode.set('host');
  myPlayerIndex.set(0);
  lobbyState.update((s) => ({ ...s, players: [{ name: '', isBot: false }] }));

  connectedSeats.set([0]); // the host is trivially present at its own seat

  hostNet.onMessage = (pid, msg) => {
    if (msg.type === 'hello') { handleHello(pid, msg.token, msg.name); return; }
    applyPeerAction(msg.payload);
  };

  // A connection alone earns nothing: seats are handed out by `hello`, which
  // carries the identity needed to tell a new player from a returning one.
  // The exception is a connection we already know — a link that blipped and
  // came back on the same transport id, whose peer won't re-say hello because
  // its first one was already acked.
  hostNet.onConnected = (pid) => {
    const seat = peerPlayerIndex.get(pid);
    if (seat === undefined) return;
    setSeatConnected(seat, true);
    sendSnapshotsTo(pid, seat);
    updateHostPolling();
  };

  hostNet.onDisconnected = (pid) => {
    const seat = peerPlayerIndex.get(pid);
    if (seat !== undefined) setSeatConnected(seat, false);
    updateHostPolling();
  };

  hostNet.start();
  heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  listenForConnectivityChanges();
}

export async function setupAsPeer(roomId: string, workerUrl?: string, transport?: Transport): Promise<void> {
  if (peerNet) return;
  if (!transport) {
    const { createP2pcfTransport } = await import('./p2pcfTransport');
    transport = await createP2pcfTransport(generateClientId(), roomId, workerUrl);
  }
  peerNet = new PeerNetwork(transport);
  networkMode.set('peer');
  peerRoomId = roomId;

  peerNet.onConnected = () => { noteHostAlive(); updatePeerPolling(); };
  peerNet.onDisconnected = () => { hostLinkUp.set(false); updatePeerPolling(); };
  peerNet.onPendingChange = (n) => queuedActionCount.set(n);

  peerNet.onMessage = (msg) => {
    // Any traffic at all proves the host is alive, even a snapshot we go on to
    // discard as stale.
    noteHostAlive();
    // Drop stale/duplicate versions — the host rebroadcasts snapshots
    // (heartbeat, reconnect) and only the newest of each type may apply.
    if (!hostMsgGate.accept(msg)) return;
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
              sendToHost({ name: 'resolveDecision', args: [d] });
            },
          });
        } else {
          pendingDecision.set(null);
        }
        break;
      case 'lobby':
        lobbyState.set(msg.payload);
        break;
      case 'connections':
        connectedSeats.set(msg.payload);
        break;
      case 'slotAssignment':
        myPlayerIndex.set(msg.payload.playerIndex);
        break;
      case 'proceedToSetup':
        pastLobby = true;
        updatePeerPolling();
        lobbyProceed.set(true);
        break;
      case 'rejected':
        joinRejected.set(msg.reason);
        break;
    }
  };

  peerNet.start();
  // Claim our seat.  Queued like any other message, so it survives a slow or
  // flaky connect and always reaches the host before our first action.
  peerNet.sendHello(seatToken(roomId), seatName(roomId));
  watchdogTimer = setInterval(hostSilenceWatchdog, HOST_WATCHDOG_TICK_MS);
  listenForConnectivityChanges();
}

/** Host calls this when clicking "Done" — signals all peers to advance past the lobby. */
export function hostProceed(): void {
  pastLobby = true;
  hostNet?.broadcast({ type: 'proceedToSetup' });
  updateHostPolling();
}

export function getConnectedPeerIds(): string[] {
  return hostNet?.getConnectedPeerIds() ?? [];
}

/**
 * Test-only: tear down networking and reset every module-level singleton so
 * each test starts from a clean slate.  Not called from production code.
 */
export function _resetNetworkForTests(): void {
  if (heartbeatTimer !== null) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (watchdogTimer !== null) { clearInterval(watchdogTimer); watchdogTimer = null; }
  stopListeningForConnectivityChanges();
  hostNet?.close();
  peerNet?.close();
  hostNet = null;
  peerNet = null;
  stopBots?.();
  stopBots = null;
  peerPlayerIndex.clear();
  peerTokens.clear();
  seatTokens.clear();
  pastLobby = false;
  peerRoomId = null;
  lastHostMsgAt = 0;
  msgVersions = new VersionCounter();
  hostMsgGate = new VersionGate();
  networkMode.set('standalone');
  gameState.set(null);
  isDealing.set(false);
  pendingDecision.set(null);
  lobbyProceed.set(false);
  localPlayerId.set(null);
  myPlayerIndex.set(null);
  connectedSeats.set([]);
  hostLinkUp.set(true);
  queuedActionCount.set(0);
  joinRejected.set(null);
  lobbyState.set({ players: [{ name: '', isBot: false }], startingChips: 50, enforceTimeLimit: false });
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
    case 'setPlayerReady': setPlayerReady(action.args[0]); break;
  }
}
