/**
 * The workflow module's public surface for other modules: the event bus's
 * contract — the hook that subscribes to change events and the canonical form
 * of a workspace id those events carry. Other modules import them from here
 * rather than reaching into the workflow's files.
 */
export { canonicalizeWorkspaceId, useEventBus } from './state/event-bus.context';
