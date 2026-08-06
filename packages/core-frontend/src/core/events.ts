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
 * CustomEvent carrying a `PullRequestSummary` the CLIENT just made true —
 * a suggestion-routed upload committed these files to the caller's branch,
 * so their suggestion rows must show NOW. The server's own list catches up
 * asynchronously (the touched-path diff can trail the background commit
 * worker by many seconds), and the {@link PR_STALE_EVENT} refetch alone left
 * exactly that gap: nothing visible where the user just dropped a folder.
 * `OpenChangeRequestsProvider` merges the payload until a real fetch covers
 * its paths, then drops it.
 */
export const SUGGESTIONS_OPTIMISTIC_EVENT = 'bevel:suggestions-optimistic';

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
