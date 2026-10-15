import type { ISkippedToolsService } from '../skipped-tools.service.js';

/**
 * An in-memory stand-in for the `skipped_tools` table, for route tests that
 * share one store across several servers the way every request of a
 * deployment does. It honours the two behaviours the routes lean on — a skip
 * is one row per person and tool however often it is made, and including a
 * tool that was never skipped is a no-op. That those hold on the real table is
 * pinned by the real-Postgres block of `skipped-tool.route.test.ts`.
 */
export class FakeSkippedToolsService implements ISkippedToolsService {
  private readonly byUser = new Map<string, Set<string>>();

  async skippedBy(userId: string): Promise<ReadonlySet<string>> {
    return new Set(this.byUser.get(userId) ?? []);
  }

  async skip(userId: string, manual: string): Promise<void> {
    const set = this.byUser.get(userId) ?? new Set<string>();
    set.add(manual);
    this.byUser.set(userId, set);
  }

  async include(userId: string, manual: string): Promise<void> {
    this.byUser.get(userId)?.delete(manual);
  }
}
