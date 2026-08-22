/**
 * online.ts — "does this device currently have a network link?"
 *
 * Used to keep the lobby from offering (or silently attempting) things that
 * cannot work with no connection.  Hosting and joining both need the signalling
 * worker, which is on the internet; a local game needs nothing.
 *
 * Important caveat, and the reason nothing here hard-blocks anything:
 * `navigator.onLine === true` only means the device has *a* link — a captive
 * portal, or a hotspot with no upstream, both report online.  The reverse is
 * more trustworthy: false really does mean nothing will connect.  So this store
 * drives explanation and emphasis, never a locked door, and the lobby's
 * existing 30-second timeout stays the real failure detector.
 *
 * Written defensively because `navigator` is absent under Node (vitest imports
 * parts of the client tree directly); losing the signal degrades to "assume
 * online", which is the pre-existing behaviour.
 */

import { readable } from 'svelte/store';

function currentlyOnline(): boolean {
  return globalThis.navigator?.onLine ?? true;
}

export const online = readable(currentlyOnline(), (set) => {
  if (typeof globalThis.addEventListener !== 'function') return;

  const update = () => set(currentlyOnline());
  globalThis.addEventListener('online', update);
  globalThis.addEventListener('offline', update);

  // The events can fire between the initial read above and this subscription.
  update();

  return () => {
    globalThis.removeEventListener('online', update);
    globalThis.removeEventListener('offline', update);
  };
});
