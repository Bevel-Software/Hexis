/**
 * Workflow's public surface for other modules: the per-file edit hold the
 * editor takes, and the sentences and error type that come with it. Other
 * modules import these from here rather than reaching into workflow's
 * hooks and services.
 */
export { useFileLock, type AcquireOutcome } from './hooks/useFileLock';
export { LockApiError, SELF_HOLD_MESSAGE } from './services/lock.api';
// The server's pushed events, for a component that shows one in place.
export { useEventBusSubscription } from './hooks/useEventBusSubscription';
export { canonicalizeWorkspaceId } from './state/event-bus.context';
// The one provider of that bus — the app shell mounts it once per tab, and a
// test that drives a component with server events mounts the same one over a
// stand-in EventSource.
export { EventBusProvider } from './state/EventBusProvider';
