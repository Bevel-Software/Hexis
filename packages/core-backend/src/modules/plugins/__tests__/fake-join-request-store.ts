import type {
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

  /** Seed a row as if it had been written before this process started. */
  seed(record: Omit<JoinRequestRecord, 'id'> & { id?: string }): JoinRequestRecord {
    const row: JoinRequestRecord = { id: record.id ?? `jr-${this.nextId++}`, ...record };
    this.rows.set(keyOf(row.requesterEmail, row.pluginKey), row);
    return { ...row };
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

  async markOpened(id: string, changeRequestNumber: number): Promise<void> {
    const row = this.rowById(id);
    if (!row) return;
    row.status = 'opened';
    row.changeRequestNumber = changeRequestNumber;
    row.failureReason = null;
  }

  async markFailed(id: string, reason: string): Promise<void> {
    const row = this.rowById(id);
    if (!row) return;
    row.status = 'failed';
    row.failureReason = reason;
  }

  private rowById(id: string): JoinRequestRecord | undefined {
    return this.all().find((r) => r.id === id);
  }
}

/** The table's uniqueness key, as one string no pair can collide on. */
function keyOf(email: string, pluginKey: string): string {
  return JSON.stringify([email.toLowerCase(), pluginKey]);
}
