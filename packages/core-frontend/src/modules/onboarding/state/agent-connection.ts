import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AuthContext } from '../../auth/state/auth.context';
import { fetchAgentConnection, type AgentConnection } from '../services/agent-connection.api';

/**
 * "Is your agent connected yet?", shared by the connect-your-agent page
 * (which polls while someone sets up their client) and the Get set up list
 * (which asks once, so connecting from anywhere counts).
 *
 * A "yes" is remembered for the session, per account, and every mounted
 * reader hears it: the page that saw the agent arrive hands the answer to the
 * list it navigates back to, instead of the list showing "not yet" until its
 * own request comes back. A "not yet" is never remembered — it is exactly the
 * answer expected to change.
 */

/** How long the page waits between two questions while nobody has connected. */
export const AGENT_POLL_MS = 3000;

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
 * `poll` keeps asking every {@link AGENT_POLL_MS} until the answer is yes —
 * one request at a time, each scheduled after the last one returned, so a
 * slow server is never stacked up on. It pauses while the tab is hidden (a
 * background tab asking every three seconds is load nobody is looking at)
 * and asks at once on return, since that is usually when someone comes back
 * from setting their agent up. Without `poll` it asks once, on mount.
 *
 * Nothing is asked while `enabled` is false, or signed out.
 */
export function useAgentConnection({
  poll = false,
  enabled = true,
}: { poll?: boolean; enabled?: boolean } = {}): AgentConnectionState {
  const auth = useContext(AuthContext);
  const userId = auth?.user?.id ?? null;
  useSyncExternalStore(subscribe, snapshot, snapshot);
  // Keyed by account, so a tab that switches accounts never shows one
  // person's answer to the next.
  const [answer, setAnswer] = useState<{ userId: string; state: AgentConnectionState } | null>(null);
  const known = userId ? knownConnected.get(userId) : undefined;

  useEffect(() => {
    if (!enabled || !userId || knownConnected.has(userId)) return;
    let cancelled = false;
    let inFlight = false;
    let timer: number | undefined;

    const schedule = () => {
      if (!poll || cancelled || document.hidden) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void check();
      }, AGENT_POLL_MS);
    };

    const check = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      let result: AgentConnection;
      try {
        result = await fetchAgentConnection();
      } catch {
        // A refusal or a blip is "not yet", and the next poll asks again.
        result = { connected: false };
      }
      inFlight = false;
      if (cancelled) return;
      if (result.connected) {
        rememberConnected(userId, result);
        return;
      }
      setAnswer({ userId, state: { connected: false, settled: true } });
      schedule();
    };

    const onVisibility = () => {
      if (document.hidden) {
        window.clearTimeout(timer);
        timer = undefined;
      } else if (poll && timer === undefined && !inFlight) {
        void check();
      }
    };

    void check();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, poll, userId]);

  if (!userId) return UNKNOWN;
  if (known) return { ...known, connected: true, settled: true };
  return answer?.userId === userId ? answer.state : UNKNOWN;
}
