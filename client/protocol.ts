/**
 * protocol.ts — the reliability layer over the raw transport.  Pure logic, no
 * I/O and no timers; `network.ts` owns the sockets and the clock.
 *
 * Two halves, one per direction:
 *
 * host → peer (versioned snapshots).  The host stamps every
 * state/pendingDecision/lobby message with a per-message-type monotonic
 * version; peers apply a message only if its version is newer than the last
 * one applied for that type.  This makes state sync level-triggered instead of
 * edge-triggered: the host can rebroadcast the current snapshot at any time
 * (heartbeat, reconnect) and peers drop the duplicates, so a peer that missed a
 * broadcast self-heals within one heartbeat instead of freezing forever.
 * Versions are per message type, not global, so a lobby update can never shadow
 * a missed state update.
 *
 * peer → host (acked, deduplicated actions).  Every action carries a unique
 * `actionId` and sits in the peer's outbound queue until the host acks it —
 * sends while the link is down are queued instead of silently dropped, and
 * retried with backoff.  Because retries mean the host can see the same action
 * twice, the host runs every arrival past `InboundActionFilter` first: only
 * exactly-once, in-order arrivals are dispatched, duplicates are re-acked
 * without being applied (a double-applied "call" would act as the next
 * player).
 */

import type { HostMsg, ActionMsg, SerializedAction } from './network';

// ─── host → peer: versioned snapshots ────────────────────────────────────────

/** Host → peer message types that carry a version stamp. */
export type VersionedMsgType = 'state' | 'pendingDecision' | 'lobby';

const VERSIONED_TYPES: ReadonlySet<string> = new Set<VersionedMsgType>([
  'state', 'pendingDecision', 'lobby',
]);

export function isVersionedMsg(
  msg: HostMsg,
): msg is Extract<HostMsg, { type: VersionedMsgType }> {
  return VERSIONED_TYPES.has(msg.type);
}

/** Interval at which the host rebroadcasts its current snapshots. */
export const HEARTBEAT_INTERVAL_MS = 3000;

/**
 * Host side: hands out version numbers.  `next` stamps a NEW snapshot;
 * `current` re-stamps the existing snapshot for rebroadcast (heartbeat,
 * late-joining peer) so peers that already applied it drop the duplicate.
 */
export class VersionCounter {
  private versions: Record<VersionedMsgType, number> = {
    state: 0,
    pendingDecision: 0,
    lobby: 0,
  };

  next(type: VersionedMsgType): number {
    return ++this.versions[type];
  }

  current(type: VersionedMsgType): number {
    return this.versions[type];
  }
}

/**
 * Peer side: filters incoming host messages.  `accept` returns true when the
 * message should be applied, false when it is a stale or duplicate delivery.
 * Unversioned message types always pass.
 */
export class VersionGate {
  private lastApplied: Record<VersionedMsgType, number> = {
    state: 0,
    pendingDecision: 0,
    lobby: 0,
  };

  accept(msg: HostMsg): boolean {
    if (!isVersionedMsg(msg)) return true;
    if (msg.v <= this.lastApplied[msg.type]) return false;
    this.lastApplied[msg.type] = msg.v;
    return true;
  }
}

// ─── peer → host: acked, deduplicated actions ────────────────────────────────

/** How often the peer wakes up to look for retries that have come due. */
export const ACTION_RETRY_TICK_MS = 250;
/** Delay before the first retry; doubles per round up to ACTION_RETRY_MAX_MS. */
export const ACTION_RETRY_BASE_MS = 500;
export const ACTION_RETRY_MAX_MS = 4000;

function backoffDelay(attempts: number): number {
  return Math.min(ACTION_RETRY_BASE_MS * 2 ** (attempts - 1), ACTION_RETRY_MAX_MS);
}

/** Action ids are `<clientId>:<counter>` — unique per peer, monotonic per peer. */
export function makeActionId(clientId: string, counter: number): string {
  return `${clientId}:${counter}`;
}

export function parseActionId(actionId: string): { clientId: string; counter: number } | null {
  const sep = actionId.lastIndexOf(':');
  if (sep <= 0) return null;
  const counter = Number(actionId.slice(sep + 1));
  if (!Number.isInteger(counter) || counter < 1) return null;
  return { clientId: actionId.slice(0, sep), counter };
}

/**
 * Peer side: actions waiting to be acked by the host.
 *
 * The queue is flushed as a unit, oldest first, so the host receives an
 * unbroken counter run even when a send is lost — anything it can't apply yet
 * arrives again on the next retry.  Backoff is per queue rather than per
 * action for the same reason: staggered per-action timers would let a newer
 * action overtake an older one and open a gap the host would have to buffer.
 */
export class OutboundActionQueue {
  private counter = 0;
  private pending: ActionMsg[] = [];
  private attempts = 0;
  private nextAttemptAt = 0;

  constructor(private clientId: string) {}

  /** Append an action and make the whole queue due immediately. */
  enqueue(payload: SerializedAction, playerId: string | null): ActionMsg {
    const msg: ActionMsg = {
      type: 'action',
      actionId: makeActionId(this.clientId, ++this.counter),
      playerId,
      payload,
    };
    this.pending.push(msg);
    this.attempts = 0;
    this.nextAttemptAt = 0;
    return msg;
  }

  /**
   * The messages to send now (oldest first), or `[]` if nothing is due yet.
   * Calling this arms the next backoff interval, so callers must actually send
   * what it returns.
   */
  due(now: number): ActionMsg[] {
    if (this.pending.length === 0 || now < this.nextAttemptAt) return [];
    this.attempts += 1;
    this.nextAttemptAt = now + backoffDelay(this.attempts);
    return [...this.pending];
  }

  /** Retire an acked action.  Returns false for an ack we no longer expect. */
  ack(actionId: string): boolean {
    const i = this.pending.findIndex((m) => m.actionId === actionId);
    if (i === -1) return false;
    this.pending.splice(i, 1);
    this.attempts = 0; // the link is working — restart the backoff ramp
    return true;
  }

  /** Called when the host link comes back: retry everything at once. */
  resetBackoff(): void {
    this.attempts = 0;
    this.nextAttemptAt = 0;
  }

  get size(): number {
    return this.pending.length;
  }

  pendingIds(): string[] {
    return this.pending.map((m) => m.actionId);
  }
}

/**
 * What the host should do with an arriving action.
 *  apply     — next in sequence; dispatch it, then ack.
 *  duplicate — already applied; ack again (the first ack was lost) but do NOT
 *              re-apply.
 *  gap       — an earlier action from this sender is still missing; drop it
 *              silently so the peer's next retry redelivers both in order.
 *  invalid   — unparseable action id; drop it.
 */
export type ActionVerdict = 'apply' | 'duplicate' | 'gap' | 'invalid';

/**
 * Host side: exactly-once, in-order admission of peer actions, keyed by the
 * sending connection rather than by the id's own client prefix (the transport
 * is the authority on who sent what).  Counters persist across link drops —
 * the peer keeps counting — so this must outlive `peerclose`.
 */
export class InboundActionFilter {
  private lastApplied = new Map<string, number>();

  /** Classify an arrival; advances the sender's counter on 'apply'. */
  admit(senderId: string, actionId: string): ActionVerdict {
    const parsed = parseActionId(actionId);
    if (!parsed) return 'invalid';
    const last = this.lastApplied.get(senderId) ?? 0;
    if (parsed.counter <= last) return 'duplicate';
    if (parsed.counter > last + 1) return 'gap';
    this.lastApplied.set(senderId, parsed.counter);
    return 'apply';
  }
}
