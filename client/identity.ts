/**
 * identity.ts — the peer's persistent claim to a seat.
 *
 * A peer's transport client id is regenerated on every page load, so it can't
 * be what the host recognises a returning player by.  Instead each peer holds a
 * token that outlives the page, sends it in `hello`, and the host maps
 * token → seat.  A refresh (or a tab that was closed and reopened before the
 * host noticed) therefore reclaims the same seat, chips and cards.
 *
 * Storage is sessionStorage, not localStorage, and keyed per room:
 *  - sessionStorage survives a reload, which is the recovery case that matters,
 *    but is scoped to one tab — so two peer tabs in the same browser stay two
 *    distinct players.  With localStorage the second tab would claim the
 *    first's seat, which breaks both local playtesting and any household
 *    sharing one browser profile.
 *  - Keying by room means joining a different game never drags an old seat
 *    claim along.
 *
 * Every access is defensive: sessionStorage is absent in Node (tests) and can
 * throw in private-browsing modes.  Losing the token only costs a seat
 * reclaim, so failures degrade to "fresh player" rather than erroring.
 */

const TOKEN_KEY = (roomId: string) => `hilo:seat-token:${roomId}`;
const NAME_KEY = (roomId: string) => `hilo:seat-name:${roomId}`;

function read(key: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Storage unavailable — the seat simply won't survive a reload.
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * This tab's token for `roomId`, generated and persisted on first use so that
 * every later load in this tab presents the same identity.
 */
export function seatToken(roomId: string): string {
  const existing = read(TOKEN_KEY(roomId));
  if (existing) return existing;
  const token = randomToken();
  write(TOKEN_KEY(roomId), token);
  return token;
}

/**
 * The name this tab last used in `roomId`, proposed in `hello` so a player who
 * reloads before the game starts doesn't have to type it again.  The host
 * ignores it for seats it already knows.
 */
export function seatName(roomId: string): string {
  return read(NAME_KEY(roomId)) ?? '';
}

export function rememberSeatName(roomId: string, name: string): void {
  write(NAME_KEY(roomId), name);
}
