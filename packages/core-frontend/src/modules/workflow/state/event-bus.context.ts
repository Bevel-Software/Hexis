import { createContext, useContext } from 'react';
import type { WorkflowEvent } from '@bevel-software/shared';

/**
 * Handler signature for an event-bus subscription. The handler runs
 * synchronously inside the React render pass — keep it side-effect-light
 * (state updates, callbacks); long-running work should be deferred via
 * `useEffect` / setState batching.
 */
export type EventHandler<K extends WorkflowEvent['kind']> = (
  event: Extract<WorkflowEvent, { kind: K }>,
) => void;

/**
 * Public API of the event bus exposed via React context. Two responsibilities:
 *
 *   - `subscribe(kind, handler)` — register a typed handler for a single
 *     event kind. Returns the unsubscribe fn. Multiple handlers per kind
 *     are supported; they all fire in registration order on each event.
 *
 *   - `setFocus(workspaceId)` — tell the backend which workspace's
 *     broadcast events this session wants. Called by hooks that follow
 *     the active branch (typically `useEventBusFocus` driven from
 *     `useWorkspaceState`). Setting `null` clears the focus — the session
 *     stays alive but receives no workspace-scoped events.
 *
 * The provider owns one EventSource per tab; this interface intentionally
 * doesn't expose connection state — consumers shouldn't care whether the
 * underlying stream is open, reconnecting, or replaying. If a feature
 * needs to know (e.g. a status banner), we'll add it then.
 */
export interface EventBusContextValue {
  subscribe<K extends WorkflowEvent['kind']>(kind: K, handler: EventHandler<K>): () => void;
  setFocus(workspaceId: string | null): void;
}

export const EventBusContext = createContext<EventBusContextValue | null>(null);

/**
 * Read the event-bus context. Returns `null` when used outside the provider
 * — consumers should null-check (or use the typed hooks below which are
 * no-ops in tests that don't mount the provider). Throwing here would
 * force every test of every component to mount the provider, which is
 * worse than the null check at the consumer.
 */
export function useEventBus(): EventBusContextValue | null {
  return useContext(EventBusContext);
}

/**
 * Decode-once (idempotent on already-decoded input). Used in every SSE
 * handler that compares `event.workspaceId` to a local `workspaceId`
 * prop / state. The two sides arrive in DIFFERENT encodings:
 *
 *   - Local state / `workspace.id` is the URL-encoded form
 *     (`encodeURIComponent(branch)` → `razvan-radulescu%2Fsc`) because
 *     that's what `workspaceIdForBranch` returns and what we put in URLs.
 *   - `event.workspaceId` on incoming events is the URL-DECODED form
 *     (`razvan-radulescu/sc`) because the backend extracts it via
 *     `req.params.id` which Express auto-decodes.
 *
 * Without canonicalisation, every `event.workspaceId !== workspaceId`
 * check silently fails for branches containing a `/` (every feature
 * branch under the `<email-localpart>/<kebab-slug>` convention) — the
 * handler appears subscribed but bails before doing any work, which is
 * exactly what made lock banners / live content refresh look broken
 * on feature branches.
 */
export function canonicalizeWorkspaceId(workspaceId: string): string {
  try {
    return decodeURIComponent(workspaceId);
  } catch {
    return workspaceId;
  }
}
