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
 * A "yes" is remembered for the session, PER SIGNED-IN USER — the record
 * hangs off the auth context's user object, which the session holds for as
 * long as that person is signed in — and every mounted reader hears it: the
 * page that saw the agent arrive hands the answer to the list it navigates
 * back to, instead of the list showing "not yet" until its own request
 * comes back. A "not yet" is never remembered — it is exactly the answer
 * expected to change. A fresh session starts from nothing.
 */

/**
 * The shortest gap between two asks prompted by coming back to the tab:
 * switching windows a dozen times a minute is not a dozen questions.
 */
export const AGENT_RECHECK_MS = 30_000;

interface Known {
  connection: AgentConnection | null;
  version: number;
  listeners: Set<() => void>;
  subscribe(listener: () => void): () => void;
  snapshot(): number;
}

const known = new WeakMap<object, Known>();

function knownFor(user: object): Known {
  const found = known.get(user);
  if (found) return found;
  const record: Known = {
    connection: null,
    version: 0,
    listeners: new Set(),
    subscribe(listener) {
      record.listeners.add(listener);
      return () => record.listeners.delete(listener);
    },
    snapshot: () => record.version,
  };
  known.set(user, record);
  return record;
}

function rememberConnected(record: Known, connection: AgentConnection): void {
  record.connection = connection;
  record.version++;
  record.listeners.forEach((l) => l());
}

const nobody = {
  subscribe: () => () => {},
  snapshot: () => 0,
};

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
  const user = auth?.user ?? null;
  const userId = user?.id ?? null;
  const record = user ? knownFor(user) : null;
  const bus = useEventBus();
  useSyncExternalStore(record?.subscribe ?? nobody.subscribe, record?.snapshot ?? nobody.snapshot, nobody.snapshot);
  // Keyed by the record, so a tab that switches accounts never shows one
  // person's answer to the next.
  const [answer, setAnswer] = useState<{ record: Known; state: AgentConnectionState } | null>(null);

  // The server's word, the moment it happens. The bus is already filtered to
  // this account's sessions; the check here covers a tab that switched
  // accounts while the subscription stood. An event older than what is
  // remembered (a replay on reconnect, a key's first use landing after a
  // newer connection's) changes nothing: the newest use names the client the
  // first-page prompt should address.
  useEffect(() => {
    if (!enabled || !record || !userId || !bus) return;
    return bus.subscribe('agent-connected', (event) => {
      if (event.forUserId !== userId) return;
      const current = record.connection;
      if (current?.at && event.at <= current.at) return;
      rememberConnected(record, { connected: true, at: event.at, client: event.client, kind: event.agentKind });
    });
  }, [enabled, record, userId, bus]);

  useEffect(() => {
    if (!enabled || !record || record.connection) return;
    let cancelled = false;
    let inFlight = false;
    let lastAsked = 0;

    const check = async () => {
      // Another reader may have heard the yes first; it is remembered for everyone.
      if (cancelled || inFlight || record.connection) return;
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
        rememberConnected(record, result);
        return;
      }
      setAnswer({ record, state: { connected: false, settled: true } });
    };

    /**
     * The person is back: the tab was shown, or the window focused. Asked
     * again if it has not been lately — an agent that connected while the
     * stream was down, or in a window this tab never heard from.
     */
    const onReturn = () => {
      if (document.hidden || inFlight || record.connection) return;
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
  }, [enabled, record]);

  if (!record) return UNKNOWN;
  if (record.connection) return { ...record.connection, connected: true, settled: true };
  return answer?.record === record ? answer.state : UNKNOWN;
}
