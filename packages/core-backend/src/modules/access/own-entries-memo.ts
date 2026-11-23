import type { OwnEntries, ParsedEntry } from '../access-model/index.js';

/** What the memo may hold: how old a workspace's memo may grow, and how much it may keep. */
export interface OwnEntriesLimits {
  readonly ttlMs: number;
  readonly maxWorkspaces: number;
  readonly maxEntries: number;
}

/**
 * The deployment's limits, for one memo. The age is only a backstop:
 * `invalidate()`, called on commit, push, pull and branch switch, is what
 * keeps a memo fresh.
 *
 * The bounds are per service graph, not per process: the composition root
 * makes one memo per `createCoreServices` call, and a host that runs one
 * graph per tenant holds one memo per active tenant, each within these
 * bounds. A tenant's memo goes with its graph when the host stops it.
 */
export const OWN_ENTRIES_LIMITS: OwnEntriesLimits = {
  ttlMs: 5 * 60_000,
  maxWorkspaces: 32,
  maxEntries: 200_000,
};

/**
 * The contract the access service keeps its per-workspace memo of what files
 * declare for themselves through. {@link OwnEntriesMemo} is the implementation
 * the composition root wires.
 */
export interface IOwnEntriesMemo {
  /** The memo for `workspaceId`, to read and fill for one batch. */
  open(workspaceId: string): WorkspaceOwnEntries;
  /** Drop `workspaceId`'s memo now (its working tree changed). */
  drop(workspaceId: string): void;
}

/**
 * The per-workspace memo of what files declare for themselves, for the batch
 * checks (see `AccessControlService.cachedOwnEntriesBatch`), with its size
 * bounded by what it holds rather than by how long the process has run:
 *
 * - a workspace's memo lives `ttlMs` from when it was started. Every `open`
 *   and `drop`, for any workspace, first drops every memo past that age, so a
 *   workspace that is never asked again is dropped by the next batch check
 *   or invalidation on any workspace. Nothing runs while nothing is asked:
 *   an idle process keeps what it held, within the bounds below;
 * - at most `maxWorkspaces` memos and `maxEntries` entries across all of
 *   them. Past either bound the oldest memo goes first; a memo that is the
 *   only one left stops growing instead of dropping what it holds.
 *
 * A dropped memo costs only the re-read it was saving. A handle whose memo
 * was dropped (by age, by a bound, or by `drop`) answers nothing and stores
 * nothing, so a read that started before an invalidation never lands where
 * a later batch reads it.
 *
 * Keys and values are copied into strings of their own before they are kept:
 * a path cut from an absolute path, or a role name cut from a file's text,
 * would otherwise keep the whole of that longer string alive.
 *
 * The composition root makes one memo per service graph and hands it to
 * that graph's `AccessControlService`, with the clock the service reads.
 */
export class OwnEntriesMemo implements IOwnEntriesMemo {
  /** In the order the memos were started, which is the order they expire in. */
  private readonly workspaces = new Map<string, WorkspaceMemo>();
  private entries = 0;

  constructor(
    /** The clock the age limit reads. */
    private readonly now: () => number = Date.now,
    private readonly limits: OwnEntriesLimits = OWN_ENTRIES_LIMITS,
  ) {}

  /** The memo for `workspaceId`: the one held, or a fresh one when none is held or it expired. */
  open(workspaceId: string): WorkspaceOwnEntries {
    this.sweep();
    let memo = this.workspaces.get(workspaceId);
    if (!memo) {
      memo = { startedAt: this.now(), live: true, byPath: new Map() };
      this.workspaces.set(workspaceId, memo);
      while (this.workspaces.size > this.limits.maxWorkspaces) this.dropOldest();
    }
    const held = memo;
    return {
      get: (relativePath) => (held.live ? held.byPath.get(relativePath) : undefined),
      set: (relativePath, own) => this.store(held, relativePath, own),
    };
  }

  /** Drop `workspaceId`'s memo now (its working tree changed). */
  drop(workspaceId: string): void {
    const held = this.workspaces.get(workspaceId);
    if (held) this.remove(workspaceId, held);
    this.sweep();
  }

  private store(memo: WorkspaceMemo, relativePath: string, own: OwnEntries | null): void {
    if (!memo.live || memo.byPath.has(relativePath)) return;
    while (this.entries >= this.limits.maxEntries) {
      const oldest = this.workspaces.values().next().value;
      if (oldest === undefined || oldest === memo) return;
      this.dropOldest();
    }
    memo.byPath.set(detach(relativePath), detachEntries(own));
    this.entries++;
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, memo] of this.workspaces) {
      if (now - memo.startedAt <= this.limits.ttlMs) break;
      this.remove(id, memo);
    }
  }

  private dropOldest(): void {
    const first = this.workspaces.entries().next().value;
    if (first) this.remove(first[0], first[1]);
  }

  private remove(id: string, memo: WorkspaceMemo): void {
    this.workspaces.delete(id);
    this.entries -= memo.byPath.size;
    memo.live = false;
    memo.byPath.clear();
  }
}

/** One workspace's memo, as the batch checks read and fill it. */
export interface WorkspaceOwnEntries {
  /** What is held for `relativePath`: `undefined` when nothing is (or the memo was dropped). */
  get(relativePath: string): OwnEntries | null | undefined;
  /** Remember `own` for `relativePath`, unless the memo was dropped or a bound refuses it. */
  set(relativePath: string, own: OwnEntries | null): void;
}

interface WorkspaceMemo {
  readonly startedAt: number;
  live: boolean;
  readonly byPath: Map<string, OwnEntries | null>;
}

/**
 * A copy of `s` that shares no memory with it. Through UTF-16, which carries
 * every string unchanged, a lone surrogate included.
 */
function detach(s: string): string {
  return Buffer.from(s, 'utf16le').toString('utf16le');
}

function detachEntries(own: OwnEntries | null): OwnEntries | null {
  if (own === null) return null;
  const out = {} as OwnEntries;
  for (const verb of Object.keys(own) as (keyof OwnEntries)[]) {
    out[verb] = own[verb].map(detachEntry);
  }
  return out;
}

function detachEntry(entry: ParsedEntry): ParsedEntry {
  return entry.kind === 'role'
    ? { kind: 'role', role: detach(entry.role), displayRole: detach(entry.displayRole), deny: entry.deny }
    : { kind: 'user', email: detach(entry.email), displayName: detach(entry.displayName), deny: entry.deny };
}
