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
export { canonicalizeWorkspaceId, useEventBus } from './state/event-bus.context';
