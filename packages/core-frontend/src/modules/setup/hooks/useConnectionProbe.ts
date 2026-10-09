import { useRef, useState } from 'react';
import { testConnection, type ConnectionTest } from '../services/setup.api';

/**
 * The connection test, as every screen that asks it keeps it: the first-run
 * storage screen and the full form. ONE mechanism for what a test needs
 * beyond the request itself — what the host last said about the answers ON
 * SCREEN; that editing one of those answers invalidates it; that an answer
 * landing after such an edit is stale, evidence about values no longer there,
 * and is never shown as if it were about the new ones; and whether a save may
 * lean on the answer on screen instead of asking again — so no two screens
 * can drift on any of them.
 */

/** The request itself failed: the endpoint is down, the request threw. Not an answer about the credentials. */
export class ConnectionProbeFailed extends Error {
  /** The answers were edited while the request was out: the failure describes values no longer on screen. */
  readonly stale: boolean;

  constructor(message: string, stale: boolean) {
    super(message);
    this.name = 'ConnectionProbeFailed';
    this.stale = stale;
  }
}

export interface ConnectionProbe {
  /** What the host said about the answers on screen: null until asked, and again after any edit to them. */
  result: ConnectionTest | null;
  /** A request is out. */
  testing: boolean;
  /** The host said yes about the answers on screen: a save may lean on it without asking again. */
  proven: boolean;
  /**
   * An answer the test proves was edited. The result on screen described the
   * old answers and goes; a request still out will land stale.
   */
  invalidate(): void;
  /**
   * Ask the host about `answers`. Resolves to the host's answer — a refusal is
   * an answer — and whether the answers were edited while the request was out
   * (`stale`). A stale answer is not shown; it is the caller's to use only
   * against the snapshot it sent. Rejects with {@link ConnectionProbeFailed}
   * when the request itself failed, flagged stale the same way.
   */
  ask(answers: Record<string, string>): Promise<{ result: ConnectionTest; stale: boolean }>;
}

export function useConnectionProbe(): ConnectionProbe {
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [testing, setTesting] = useState(false);
  /**
   * Which set of answers is on screen, bumped on every edit to one of them.
   * An answer carries the epoch its request left under; a different one by
   * the time it lands means the answers it describes are gone.
   */
  const epoch = useRef(0);
  const inFlight = useRef(0);

  const invalidate = () => {
    epoch.current++;
    setResult(null);
  };

  const ask = async (answers: Record<string, string>) => {
    const asked = epoch.current;
    inFlight.current++;
    setTesting(true);
    try {
      const answer = await testConnection(answers);
      const stale = asked !== epoch.current;
      if (!stale) setResult(answer);
      return { result: answer, stale };
    } catch (err) {
      throw new ConnectionProbeFailed(
        err instanceof Error ? err.message : 'Could not test the connection.',
        asked !== epoch.current,
      );
    } finally {
      inFlight.current--;
      if (inFlight.current === 0) setTesting(false);
    }
  };

  return { result, testing, proven: result?.ok === true, invalidate, ask };
}
