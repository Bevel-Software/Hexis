import { randomUUID } from 'node:crypto';
import type {
  ClaimedJoinRequest,
  JoinRequestRecord,
  JoinRequestStore,
} from '../join-request-records.store.js';

/**
 * An in-memory stand-in for the `plugin_join_requests` table.
 *
 * A spy that recorded calls could not answer what these tests ask — "how many
 * requests does clicking twice leave behind, and which one does the second
 * click get" — because the answer lives in the table's uniqueness key. So this
 * keeps actual rows behind `(requesterEmail, pluginKey)` and honours the two
 * behaviours the service leans on: a second `record` finds the first one's
 * row, and a `failed` row is revived to `pending` by it rather than replaced.
 */
export class FakeJoinRequestStore implements JoinRequestStore {
  private readonly rows = new Map<string, JoinRequestRecord>();
  private nextId = 1;

  /**
   * Seed a row as if it had been written before this process started.
   *
   * The address is lowercased HERE, exactly as the real store lowercases it
   * on insert. Storing it verbatim would let a seeded `Ali@x.io` be found by
   * `byId` and returned by `pending`, yet never by `forRequester` — a split
   * the table cannot produce, and one a test could accidentally rely on.
   */
  seed(
    record: Omit<JoinRequestRecord, 'id' | 'claimToken'> & { id?: string; claimToken?: string | null },
  ): JoinRequestRecord {
    const row: JoinRequestRecord = {
      claimToken: null,
      ...record,
      id: record.id ?? `jr-${this.nextId++}`,
      requesterEmail: record.requesterEmail.toLowerCase(),
    };
    this.rows.set(keyOf(row.requesterEmail, row.pluginKey), row);
    return { ...row };
  }

  /**
   * Delete a row behind the service's back, the way account erasure does it:
   * one statement against the table, with no idea whether a job is mid-flight
   * against it. The test seam for "the row went away under a running job".
   */
  deleteFor(requesterEmail: string, pluginKey: string): boolean {
    return this.rows.delete(keyOf(requesterEmail, pluginKey));
  }

  /** Every row, in insertion order — what an assertion counts. */
  all(): JoinRequestRecord[] {
    return [...this.rows.values()];
  }

  async record(input: {
    requesterEmail: string;
    requesterName: string;
    pluginKey: string;
  }): Promise<JoinRequestRecord> {
    const existing = this.rows.get(keyOf(input.requesterEmail, input.pluginKey));
    if (existing) {
      existing.requesterName = input.requesterName;
      if (existing.status === 'failed') {
        existing.status = 'pending';
        existing.failureReason = null;
        existing.claimedAt = null;
        existing.claimToken = null;
      }
      return { ...existing };
    }
    return this.seed({
      requesterEmail: input.requesterEmail.toLowerCase(),
      requesterName: input.requesterName,
      pluginKey: input.pluginKey,
      status: 'pending',
      failureReason: null,
      changeRequestNumber: null,
      claimedAt: null,
      claimToken: null,
    });
  }

  async byId(id: string): Promise<JoinRequestRecord | null> {
    const row = this.rowById(id);
    return row ? { ...row } : null;
  }

  async forRequester(requesterEmail: string): Promise<JoinRequestRecord[]> {
    return this.all()
      .filter((r) => r.requesterEmail === requesterEmail.toLowerCase())
      .map((r) => ({ ...r }));
  }

  async pending(): Promise<JoinRequestRecord[]> {
    return this.all()
      .filter((r) => r.status === 'pending')
      .map((r) => ({ ...r }));
  }

  async claim(id: string, staleAfterMs: number): Promise<ClaimedJoinRequest | null> {
    const row = this.rowById(id);
    if (!row || row.status !== 'pending') return null;
    const held = row.claimedAt;
    if (held && Date.now() - held.getTime() < staleAfterMs) return null;
    row.claimedAt = new Date();
    // Fresh per claim, exactly as `gen_random_uuid()` makes it in the table —
    // so a test that takes a row over really does invalidate the previous
    // holder's token rather than handing out the same one twice.
    const claimToken = randomUUID();
    row.claimToken = claimToken;
    return { ...row, claimToken };
  }

  async heartbeat(id: string, claimToken: string): Promise<boolean> {
    const row = this.rowById(id);
    if (!row || row.status !== 'pending' || !row.claimedAt) return false;
    if (row.claimToken !== claimToken) return false;
    row.claimedAt = new Date();
    return true;
  }

  async release(id: string, claimToken: string): Promise<void> {
    const row = this.rowById(id);
    if (!row || row.status !== 'pending' || row.claimToken !== claimToken) return;
    row.claimedAt = null;
    row.claimToken = null;
  }

  async markOpened(id: string, claimToken: string, changeRequestNumber: number): Promise<void> {
    const row = this.rowById(id);
    if (!row || row.claimToken !== claimToken) return;
    row.status = 'opened';
    row.changeRequestNumber = changeRequestNumber;
    row.failureReason = null;
    row.claimedAt = null;
    row.claimToken = null;
  }

  async markFailed(id: string, claimToken: string, reason: string): Promise<void> {
    const row = this.rowById(id);
    if (!row || row.claimToken !== claimToken) return;
    row.status = 'failed';
    row.failureReason = reason;
    row.claimedAt = null;
    row.claimToken = null;
  }

  async reopen(id: string, changeRequestNumber: number): Promise<JoinRequestRecord | null> {
    const row = this.rowById(id);
    if (!row) return null;
    if (row.status === 'opened' && row.changeRequestNumber === changeRequestNumber) {
      row.status = 'pending';
      row.changeRequestNumber = null;
      row.failureReason = null;
      row.claimedAt = null;
      row.claimToken = null;
    }
    return { ...row };
  }

  private rowById(id: string): JoinRequestRecord | undefined {
    return this.all().find((r) => r.id === id);
  }
}

/** The table's uniqueness key, as one string no pair can collide on. */
function keyOf(email: string, pluginKey: string): string {
  return JSON.stringify([email.toLowerCase(), pluginKey]);
}
