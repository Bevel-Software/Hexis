import type { ConnectToolOAuth, ManagedSignIn } from '../services/connect.api';

/** A sign-in row that IS managed: the card's input, narrowed once where rows are filtered. */
export type ManagedToolOAuth = ConnectToolOAuth & { managed: ManagedSignIn };

export function isManagedRow(o: ConnectToolOAuth): o is ManagedToolOAuth {
  return o.managed != null;
}

/**
 * The state a managed connector card shows, in the Library's vocabulary:
 *  - unavailable      nothing stored, and no way to open a sign-in from here (the admin's job)
 *  - owner-only       a workspace connection a reader cannot make
 *  - ready            nothing stored yet
 *  - connected        a token is stored (the card adds the account when known)
 *  - needs-reconnect  stored, but it no longer covers what the tool asks for
 *
 * A stored token is reported as such even while the broker is unreachable:
 * what is stored still works, and the card withholds Connect and Reconnect
 * instead (see `canStartSignIn`). "Connected" means a token is STORED, the
 * same claim every sign-in row on the Connect page makes; a call that works
 * is proved elsewhere.
 */
export type ManagedCardState = 'unavailable' | 'owner-only' | 'ready' | 'connected' | 'needs-reconnect';

export function managedCardState(o: ManagedToolOAuth): ManagedCardState {
  if (!canStartSignIn(o) && !o.authorized) return 'unavailable';
  if (o.ownerOnly) return 'owner-only';
  if (o.authorized && o.needsReauth) return 'needs-reconnect';
  if (o.authorized) return 'connected';
  return 'ready';
}

/**
 * Whether a sign-in can be opened from this deployment. A personal one goes
 * through the broker, or through an owner's own app pinned in its place. A
 * WORKSPACE connection goes through the broker alone: an owner's own app
 * would sign the owner in to their own row, which nobody reads for it, so
 * that combination is not offered (the server refuses it too).
 */
export function canStartSignIn(o: ManagedToolOAuth): boolean {
  if (o.managed.tokenScope === 'shared') return o.managed.available && !o.managed.ownApp;
  return o.managed.ownApp || o.managed.available;
}

/** Whether "use our own app" is offered: a writer, on a personal connection (see `canStartSignIn`). */
export function canBringOwnApp(o: ManagedToolOAuth): boolean {
  return o.canWrite === true && o.managed.tokenScope === 'user';
}
