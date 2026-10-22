/**
 * Workflow's public surface for other modules: the per-file edit hold the
 * editor takes, and the sentences and error type that come with it. Other
 * modules import these from here rather than reaching into workflow's
 * hooks and services.
 */
export { useFileLock, type AcquireOutcome } from './hooks/useFileLock';
export { LockApiError, SELF_HOLD_MESSAGE } from './services/lock.api';
// Reached by other modules; exported here so they stop importing the files.
export { useEventBusSubscription } from './hooks/useEventBusSubscription';
export { canonicalizeWorkspaceId, useEventBus } from './state/event-bus.context';
