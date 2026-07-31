import { randomUUID } from 'node:crypto';

/**
 * Port behind `start_session` (workspace.tools.ts): mints the session id an
 * external agent scopes its ontology boundary under. The workspace module owns
 * the port; WHAT backs the id is the composition root's choice:
 *
 * - Core default ({@link UuidSessionSink}): a bare random id — sufficient for
 *   the session-ontology gate, with no app-side session record.
 * - The enterprise app substitutes a sink that mints a REAL chat thread, so the
 *   same id also works end to end with `ask` (its sessionId IS a chat thread).
 *   See the `start_session` comment in workspace.tools.ts for why that
 *   unification matters.
 */
export interface ISessionSink {
  /** Mint a session id for an external agent run started at `startedAt`. */
  createSession(userId: string, startedAt: Date): Promise<{ sessionId: string }>;
}

/** Core default: a bare random id — no app-side session record. */
export class UuidSessionSink implements ISessionSink {
  async createSession(): Promise<{ sessionId: string }> {
    return { sessionId: randomUUID() };
  }
}
