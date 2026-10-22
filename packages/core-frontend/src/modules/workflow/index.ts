/**
 * Workflow's public surface for other modules: the per-file edit hold the
 * editor takes, and the sentences and error type that come with it; and the
 * event bus's contract — the hook that subscribes to change events and the
 * canonical form of a workspace id those events carry. Other modules import
 * these from here rather than reaching into workflow's hooks, services and
 * state.
 */
export { useFileLock, type AcquireOutcome } from './hooks/useFileLock';
export { LockApiError, SELF_HOLD_MESSAGE } from './services/lock.api';
// The server's pushed events, for a component that shows one in place.
export { useEventBusSubscription } from './hooks/useEventBusSubscription';
export { canonicalizeWorkspaceId, useEventBus } from './state/event-bus.context';
// The one provider of that bus — the app shell mounts it once per tab, and a
// test that drives a component with server events mounts the same one over a
// stand-in EventSource.
export { EventBusProvider } from './state/EventBusProvider';
