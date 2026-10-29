import type { ConnectToolOAuth } from '../services/connect.api';

/**
 * The state a managed connector card shows, in the Library's vocabulary:
 *  - unavailable      the deployment is not connected to a broker yet (the admin's job)
 *  - owner-only       a workspace connection a reader cannot make
 *  - ready            nothing stored yet
 *  - connected        a token is stored (the card adds the account when known)
 *  - needs-reconnect  stored, but it no longer covers what the tool asks for
 *
 * "Connected" means a token is STORED, the same claim every sign-in row on
 * the Connect page makes; a call that works is proved elsewhere.
 */
export type ManagedCardState = 'unavailable' | 'owner-only' | 'ready' | 'connected' | 'needs-reconnect';

export function managedCardState(o: ConnectToolOAuth): ManagedCardState {
  const m = o.managed!;
  // An owner's own app makes the deployment's own flow apply: no broker needed.
  if (!m.ownApp && !m.available) return 'unavailable';
  if (o.ownerOnly) return 'owner-only';
  if (o.authorized && o.needsReauth) return 'needs-reconnect';
  if (o.authorized) return 'connected';
  return 'ready';
}
