/**
 * pwa.ts — service-worker registration and the update handshake.
 *
 * The worker precaches the entire app shell (see the VitePWA block in
 * vite.config.ts), which is what makes an offline standalone game possible: a
 * cold launch with no network still has every asset it needs.
 *
 * Updates are deliberately *not* applied automatically.  A new worker taking
 * over reloads the tab, and a standalone game exists only in memory — so an
 * automatic reload mid-round silently destroys the game.  Instead `updateReady`
 * goes true, the UI offers a button, and the player picks the moment.
 *
 * In dev the virtual module compiles to a no-op, so none of this runs under
 * `vite dev` or vitest.
 */

import { writable } from 'svelte/store';
import { registerSW } from 'virtual:pwa-register';

/** True once a newer build is installed and waiting for a reload. */
export const updateReady = writable(false);

let applyUpdate: ((reloadPage?: boolean) => Promise<void>) | null = null;

/** Register the worker.  Called once from main.ts. */
export function initPwa(): void {
  applyUpdate = registerSW({
    onNeedRefresh() {
      updateReady.set(true);
    },
  });
}

/** Activate the waiting worker and reload into the new build. */
export function applyPendingUpdate(): void {
  void applyUpdate?.(true);
}
