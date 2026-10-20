/**
 * Workflow's public surface for other modules: the per-file edit hold the
 * editor takes, and the sentences and error type that come with it. Other
 * modules import these from here rather than reaching into workflow's
 * hooks and services.
 */
export { useFileLock, type AcquireOutcome } from './hooks/useFileLock';
export { LockApiError, SELF_HOLD_MESSAGE } from './services/lock.api';

/**
 * The rest of what the shell and other modules use from workflow, grouped by
 * the file that defines it.
 */
export { useEventBusSubscription } from './hooks/useEventBusSubscription';
export { ChangeRequestStaleBinder } from './state/ChangeRequestStaleBinder';
export { EventBusFocusBinder } from './state/EventBusFocusBinder';
export { EventBusProvider } from './state/EventBusProvider';
export { canonicalizeWorkspaceId, useEventBus } from './state/event-bus.context';
