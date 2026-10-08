import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AuthContext } from '../../auth/state/auth.context';
import { useEventBus } from '../../workflow/state/event-bus.context';
import { fetchAgentConnection, type AgentConnection } from '../services/agent-connection.api';

/**
 * "Is your agent connected yet?", shared by the connect-your-agent page and
 * the Get set up list.
 *
 * The server SAYS when it happens: an agent's first authenticated request
 * stamps its connection or key, and the stamp paths emit `agent-connected`
 * for the owner over the event stream every tab holds. So this hook listens,
 * and asks the server only on arrival and when the person comes back to the
 * tab — for an agent that connected before this tab existed, or while its
 * stream was down. Never on a timer.
 *
 * A "yes" is remembered for the session, per account, and every mounted
 * reader hears it: the page that saw the agent arrive hands the answer to the
 * list it navigates back to, instead of the list showing "not yet" until its
 * own request comes back. A "not yet" is never remembered — it is exactly the
 * answer expected to change.
 */

/**
 * The shortest gap between two asks prompted by coming back to the tab:
 * switching windows a dozen times a minute is not a dozen questions.
 */
export const AGENT_RECHECK_MS = 30_000;

const knownConnected = new Map<string, AgentConnection>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => version;

function rememberConnected(userId: string, connection: AgentConnection): void {
  knownConnected.set(userId, connection);
  version++;
  listeners.forEach((l) => l());
}

/** Test seam: forget every remembered connection. */
export function resetAgentConnectionForTests(): void {
  knownConnected.clear();
  version++;
  listeners.forEach((l) => l());
}

export interface AgentConnectionState extends AgentConnection {
  /** The first answer is in (a failed request counts as "not yet"). */
  settled: boolean;
}

const UNKNOWN: AgentConnectionState = { connected: false, settled: false };

/**
 * The signed-in person's agent connection.
 *
 * Told by the server's `agent-connected` event the moment an agent of theirs
 * makes its first call. Asked once on mount, and again when the person comes
 * back to the tab — at most once per {@link AGENT_RECHECK_MS} — so an agent
 * connected before this tab opened, or while its event stream was down, still
 * counts. A failed ask reads as "not yet".
 *
 * Nothing is asked or listened for while `enabled` is false, or signed out.
 */
export function useAgentConnection({ enabled = true }: { enabled?: boolean } = {}): AgentConnectionState {
  const auth = useContext(AuthContext);
  const userId = auth?.user?.id ?? null;
  const bus = useEventBus();
  useSyncExternalStore(subscribe, snapshot, snapshot);
  // Keyed by account, so a tab that switches accounts never shows one
  // person's answer to the next.
  const [answer, setAnswer] = useState<{ userId: string; state: AgentConnectionState } | null>(null);
  const known = userId ? knownConnected.get(userId) : undefined;

  // The server's word, the moment it happens. The bus is already filtered to
  // this account's sessions; the check here covers a tab that switched
  // accounts while the subscription stood.
  useEffect(() => {
    if (!enabled || !userId || !bus) return;
    return bus.subscribe('agent-connected', (event) => {
      if (event.forUserId !== userId) return;
      rememberConnected(userId, { connected: true, at: event.at, client: event.client, kind: event.agentKind });
    });
  }, [enabled, userId, bus]);

  useEffect(() => {
    if (!enabled || !userId || knownConnected.has(userId)) return;
    let cancelled = false;
    let inFlight = false;
    let lastAsked = 0;

    const check = async () => {
      // Another reader may have heard the yes first; it is remembered for everyone.
      if (cancelled || inFlight || knownConnected.has(userId)) return;
      inFlight = true;
      lastAsked = Date.now();
      let result: AgentConnection;
      try {
        result = await fetchAgentConnection();
      } catch {
        // A refusal or a blip reads as "not yet" on screen; the event, or
        // the next return to the tab, says otherwise.
        result = { connected: false };
      }
      inFlight = false;
      if (cancelled) return;
      if (result.connected) {
        rememberConnected(userId, result);
        return;
      }
      setAnswer({ userId, state: { connected: false, settled: true } });
    };

    /**
     * The person is back: the tab was shown, or the window focused. Asked
     * again if it has not been lately — an agent that connected while the
     * stream was down, or in a window this tab never heard from.
     */
    const onReturn = () => {
      if (document.hidden || inFlight || knownConnected.has(userId)) return;
      if (Date.now() - lastAsked >= AGENT_RECHECK_MS) void check();
    };

    void check();
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
    };
  }, [enabled, userId]);

  if (!userId) return UNKNOWN;
  if (known) return { ...known, connected: true, settled: true };
  return answer?.userId === userId ? answer.state : UNKNOWN;
}
