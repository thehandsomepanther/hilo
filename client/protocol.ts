/**
 * protocol.ts — message versioning for host → peer state sync.
 *
 * The host stamps every state/pendingDecision/lobby message with a
 * per-message-type monotonic version.  Peers apply a message only if its
 * version is newer than the last one applied for that type.
 *
 * This makes state sync level-triggered instead of edge-triggered:
 *  - The host can rebroadcast the current snapshot at any time (heartbeat,
 *    reconnect) without causing redundant re-renders on peers that already
 *    have it — they drop the duplicate by version.
 *  - A peer that missed a broadcast (connection blip, silent send drop)
 *    self-heals on the next heartbeat instead of freezing forever.
 *
 * Versions are per message type, not global, so a lobby update can never
 * shadow a missed state update.
 */

import type { HostMsg } from './network';

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
