import { and, eq } from 'drizzle-orm';
import type { Database } from '../database/connection.js';
import { skippedTools } from '../database/schema.js';

/**
 * The tools each person took out of their agent on the Connect page.
 *
 * A skip is a STANDING choice, not a side effect of deleting a credential: the
 * page used to wipe the keys and keep "skipped" in component state, so a reload
 * or a second session showed the tool as needing a sign-in again, and nothing
 * kept it off the agent's tool list once the person signed back in elsewhere.
 * This is where the choice is kept; the Connect listing reports it and the
 * agent catalog leaves a skipped manual out for that person.
 *
 * Keyed by the manual's catalog NAME — the namespace its secrets are stored
 * under — which is also the `name` every agent-facing call template carries.
 */
export interface ISkippedToolsService {
  /** The catalog names of every manual `userId` skipped. */
  skippedBy(userId: string): Promise<ReadonlySet<string>>;
  /** Take `manual` out of `userId`'s agent. Skipping twice is one skip. */
  skip(userId: string, manual: string): Promise<void>;
  /** Put `manual` back. Including a tool that was never skipped is a no-op. */
  include(userId: string, manual: string): Promise<void>;
}

export class DbSkippedToolsService implements ISkippedToolsService {
  constructor(private readonly db: Database) {}

  async skippedBy(userId: string): Promise<ReadonlySet<string>> {
    const rows = await this.db
      .select({ manual: skippedTools.manual })
      .from(skippedTools)
      .where(eq(skippedTools.userId, userId));
    return new Set(rows.map((r) => r.manual));
  }

  async skip(userId: string, manual: string): Promise<void> {
    await this.db.insert(skippedTools).values({ userId, manual }).onConflictDoNothing();
  }

  async include(userId: string, manual: string): Promise<void> {
    await this.db
      .delete(skippedTools)
      .where(and(eq(skippedTools.userId, userId), eq(skippedTools.manual, manual)));
  }
}
