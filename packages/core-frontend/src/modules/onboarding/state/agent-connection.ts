import { useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AuthContext } from '../../auth/state/auth.context';
import { fetchAgentConnection, type AgentConnection } from '../services/agent-connection.api';

/**
 * "Is your agent connected yet?", shared by the connect-your-agent page
 * (which polls while someone sets up their client) and the Get set up list
 * (which asks on mount and again when someone comes back to the tab, so
 * connecting from anywhere counts).
 *
 * A "yes" is remembered for the session, per account, and every mounted
 * reader hears it: the page that saw the agent arrive hands the answer to the
 * list it navigates back to, instead of the list showing "not yet" until its
 * own request comes back. A "not yet" is never remembered — it is exactly the
 * answer expected to change.
 */

/** How long the page waits between two questions while nobody has connected. */
export const AGENT_POLL_MS = 3000;

/**
 * The longest the page waits after failed asks. Each failure in a row doubles
 * the wait from {@link AGENT_POLL_MS} up to this — a server that is down, or a
 * session that has expired, is not asked every three seconds.
 */
export const AGENT_BACKOFF_MAX_MS = 60_000;

/**
 * Failed asks in a row after which the page stops asking altogether, until
 * the person comes back to the tab (it is shown again, or focused).
 */
export const AGENT_MAX_FAILURES = 5;

/**
 * Without `poll`, the shortest gap between two asks prompted by coming back
 * to the tab: switching windows a dozen times a minute is not a dozen
 * questions.
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
 * `poll` keeps asking every {@link AGENT_POLL_MS} until the answer is yes —
 * one request at a time, each scheduled after the last one returned, so a
 * slow server is never stacked up on. It pauses while the tab is hidden (a
 * background tab asking every three seconds is load nobody is looking at)
 * and asks at once on return, since that is usually when someone comes back
 * from setting their agent up. A failed ask is not a "no": failures in a row
 * back off (doubling, up to {@link AGENT_BACKOFF_MAX_MS}) and, after
 * {@link AGENT_MAX_FAILURES}, stop until the tab is shown or focused again.
 *
 * Without `poll` it asks on mount, and again when the person comes back to
 * the tab — at most once per {@link AGENT_RECHECK_MS} — so an agent connected
 * in another window, or from the External agent access page, still ticks the
 * list without a reload.
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
    /** Failed asks in a row; any answer, yes or no, resets it. */
    let failures = 0;
    let lastAsked = 0;

    const schedule = () => {
      if (!poll || cancelled || document.hidden) return;
      // Given up until the person comes back to the tab (see `onReturn`).
      if (failures >= AGENT_MAX_FAILURES) return;
      const delay = failures === 0 ? AGENT_POLL_MS : Math.min(AGENT_POLL_MS * 2 ** failures, AGENT_BACKOFF_MAX_MS);
      timer = window.setTimeout(() => {
        timer = undefined;
        void check();
      }, delay);
    };

    const check = async () => {
      // Another reader may have heard the yes first; it is remembered for everyone.
      if (cancelled || inFlight || knownConnected.has(userId)) return;
      inFlight = true;
      lastAsked = Date.now();
      let result: AgentConnection;
      try {
        result = await fetchAgentConnection();
        failures = 0;
      } catch {
        // A refusal or a blip reads as "not yet" on screen, but counts
        // towards backing off: asking again in three seconds is the wrong
        // answer to a server that is down or a session that has expired.
        result = { connected: false };
        failures++;
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

    /**
     * The person is back: the tab was shown, or the window focused. A poll
     * that was waiting out a hidden tab, or had given up after failures,
     * starts again at once and afresh; a reader that does not poll asks
     * again if it has not lately.
     */
    const onReturn = () => {
      if (document.hidden || timer !== undefined || inFlight || knownConnected.has(userId)) return;
      if (poll) {
        failures = 0;
        void check();
      } else if (Date.now() - lastAsked >= AGENT_RECHECK_MS) {
        void check();
      }
    };

    const onVisibility = () => {
      if (document.hidden) {
        window.clearTimeout(timer);
        timer = undefined;
      } else {
        onReturn();
      }
    };

    void check();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onReturn);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onReturn);
    };
  }, [enabled, poll, userId]);

  if (!userId) return UNKNOWN;
  if (known) return { ...known, connected: true, settled: true };
  return answer?.userId === userId ? answer.state : UNKNOWN;
}
