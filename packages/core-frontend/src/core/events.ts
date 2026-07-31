/**
 * Window-level custom-event names shared across modules. Centralised here so
 * core and registry-contributed (enterprise) modules agree on the same wire
 * names without importing each other's components.
 */

/**
 * Fired whenever something in the app may have mutated the change-request
 * list (a merge/apply completed, the agent opened or closed a CR via `gh`,
 * a pull brought in teammates' merges, a cancel went through). Listeners
 * (the "Change requests for you" sidebar) refetch immediately instead of
 * waiting for their next poll tick.
 */
export const PR_STALE_EVENT = 'bevel:pr-stale';

/**
 * Custom event the chat-side `compare_files` tool-card dispatches to deep-link
 * into the comparison panel. The FileViewer listens for this and forwards
 * `path` to the workspace open-file flow plus the from/to refs to the
 * FileComparisonPanel.
 */
export const OPEN_COMPARISON_EVENT = 'bevel:open-comparison';

/** Payload carried by {@link OPEN_COMPARISON_EVENT}. */
export interface OpenComparisonDetail {
  path: string;
  fromBranch: string;
  toBranch: string;
}
