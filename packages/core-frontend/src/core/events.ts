/**
 * Window-level custom-event names — and the one announcer that goes with one —
 * shared across modules. Centralised here so core and registry-contributed
 * (enterprise) modules agree on the same wire names without importing each
 * other's components.
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
 * The fallback window for a {@link PR_STALE_EVENT} that never came — the bus
 * dropped the merge or rejection that would have triggered it. Change-request
 * lists re-read the server on this cadence while the tab is visible, so a lost
 * event leaves a request pending for at most this long, never until a reload.
 */
export const PR_STALE_FALLBACK_MS = 60_000;

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

/**
 * A tool credential LANDED — a key stored or removed, an OAuth round-trip
 * returned. Every surface that can write one (the tool page, "Connect your
 * tools", the Secrets vault, the `.tool` editor's panel) announces it, and the
 * Library reloads its catalog AND its plugin summaries in response: the cards,
 * the plugin banner and the sidebar count all read "needs setup" off that
 * catalog, so without the reload they keep describing the state from before
 * the write until the reader reaches for the browser's own reload button.
 *
 * An event rather than a direct call because the writing surfaces do not all
 * live under the Library's provider: `/connect` and `/secrets` are shell
 * routes of their own, so there is nothing to reach for from inside them.
 * Announcing regardless keeps ONE rule for every surface — with no listener
 * the announcement is simply unheard, which is the right outcome for a
 * provider that will refetch on its next mount anyway.
 */
export const TOOL_CREDENTIALS_STALE_EVENT = 'bevel:tool-credentials-stale';

/**
 * Announce a landed credential change.
 *
 * Call it ONLY once the write has SUCCEEDED. A failed save changed nothing,
 * and a reload triggered by one would make every card and banner in the
 * Library blink for no reason — worse, it would teach the reader that the
 * blink means something happened.
 */
export function announceToolCredentialsChanged(): void {
  window.dispatchEvent(new Event(TOOL_CREDENTIALS_STALE_EVENT));
}
