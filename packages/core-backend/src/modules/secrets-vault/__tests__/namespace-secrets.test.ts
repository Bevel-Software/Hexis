import { describe, expect, it, vi } from 'vitest';
import { DbSecretsVaultService } from '../db-secrets-vault.service.js';
import { isKeyInNamespace } from '../secrets-vault.contract.js';
import { utcpNamespacePrefix } from '../../../shared/utcp-namespace.js';
import type { Database } from '../../database/connection.js';

/**
 * The secrets a tool deletion counts and wipes.
 *
 * The rule under test is the one that is easy to get wrong and expensive to
 * get wrong: namespacing DOUBLES underscores, so `foo`'s prefix `foo_` is also
 * the start of `foo_bar`'s `foo__bar_`. A plain prefix match would let one
 * tool's deletion take a differently-named tool's credentials with it.
 */

describe('isKeyInNamespace', () => {
  const foo = utcpNamespacePrefix('foo');

  it('takes the manual\'s own keys', () => {
    expect(foo).toBe('foo_');
    expect(isKeyInNamespace('foo_API_KEY', foo)).toBe(true);
    expect(isKeyInNamespace('foo_MCP_OAUTH', foo)).toBe(true);
  });

  it('leaves a longer name\'s keys alone', () => {
    const fooBar = utcpNamespacePrefix('foo_bar');
    expect(fooBar).toBe('foo__bar_');
    expect(isKeyInNamespace('foo__bar_API_KEY', foo)).toBe(false);
    expect(isKeyInNamespace('foo__bar_API_KEY', fooBar)).toBe(true);
  });

  it('never takes a `_`-leading remainder, not even for a manual that declares it', () => {
    // `foo` declaring `_X` and a manual named `foo_X` store under the same
    // key, and nothing about the key says which. Since the only use of this
    // predicate is counting and WIPING a namespace, the ambiguous row is left
    // standing — recoverable, where one wrongly deleted is not.
    expect(isKeyInNamespace('foo__X', foo)).toBe(false);
    expect(isKeyInNamespace('foo__bar_KEY', foo)).toBe(false);
  });

  it('is not the prefix itself, and not an unrelated key', () => {
    expect(isKeyInNamespace('foo_', foo)).toBe(false);
    expect(isKeyInNamespace('bar_API_KEY', foo)).toBe(false);
  });
});

/**
 * The delete's id list is the ONE condition this file has to read back, so
 * `inArray` is swapped for a plain carrier and everything else in drizzle
 * stays real.
 */
vi.mock('drizzle-orm', async (importOriginal) => {
  const real = await importOriginal<typeof import('drizzle-orm')>();
  return { ...real, inArray: (_col: unknown, values: string[]) => ({ ids: values }) };
});

type Row = { id: string; key: string; userId: string | null; kind: string };

/**
 * A drizzle chain over a MUTABLE store: `select…where` resolves whatever is
 * there now, `delete…where…returning` removes the ids it was given and reports
 * them. Mutable on purpose — `removeNamespace` re-scans until a pass comes
 * back empty, and a store frozen at the first read could never show that.
 */
function fakeDb(initial: Row[], onSelect?: (store: Row[]) => void) {
  let store = [...initial];
  const deleted: string[][] = [];
  const chain = (result: unknown) => {
    const c: Record<string, unknown> = {};
    const pass = vi.fn(() => c);
    c.from = pass;
    c.where = pass;
    c.then = (onF: (v: unknown) => unknown, onR: (e: unknown) => unknown) =>
      Promise.resolve(result).then(onF, onR);
    return c;
  };
  const db = {
    select: vi.fn(() => {
      const rows = [...store];
      // After the read, before the delete: the window a concurrent write lands in.
      onSelect?.(store);
      return chain(rows);
    }),
    delete: vi.fn(() => {
      const c = chain([]) as Record<string, unknown>;
      let gone: Row[] = [];
      c.where = vi.fn((cond: { ids?: string[] }) => {
        const ids = cond.ids ?? [];
        deleted.push(ids);
        gone = store.filter((r) => ids.includes(r.id));
        store = store.filter((r) => !ids.includes(r.id));
        return c;
      });
      c.returning = vi.fn(() =>
        // What the DELETE itself saw, not the scan's copy of it.
        Promise.resolve(gone.map((r) => ({ userId: r.userId, kind: r.kind }))),
      );
      return c;
    }),
  } as unknown as Database;
  return { db, deleted, add: (r: Row) => store.push(r), remaining: () => store };
}

describe('countNamespace / removeNamespace', () => {
  const rows: Row[] = [
    { id: '1', key: 'foo_API_KEY', userId: null, kind: 'static' },
    { id: '2', key: 'foo_API_KEY', userId: 'u-1', kind: 'static' },
    { id: '3', key: 'foo_MCP_OAUTH', userId: 'u-1', kind: 'oauth' },
    { id: '4', key: 'foo_MCP_OAUTH', userId: 'u-2', kind: 'oauth' },
    // The shared client secret of an oauth variable — a stored key, not a sign-in.
    { id: '5', key: 'foo_MCP_OAUTH', userId: null, kind: 'oauth' },
    // Another manual whose prefix merely starts the same way.
    { id: '6', key: 'foo__bar_API_KEY', userId: 'u-1', kind: 'static' },
  ];

  it('counts sign-ins apart from keys, and never counts a neighbour\'s', async () => {
    const { db } = fakeDb(rows);
    const vault = new DbSecretsVaultService(db, '');
    await expect(vault.countNamespace('foo_')).resolves.toEqual({ keys: 3, signIns: 2 });
  });

  it('deletes exactly the namespace\'s rows and tells every affected tier', async () => {
    const { db, deleted, remaining } = fakeDb(rows);
    const vault = new DbSecretsVaultService(db, '');
    const notified: (string | null)[] = [];
    vault.onMutation((u) => notified.push(u));
    await expect(vault.removeNamespace('foo_')).resolves.toEqual({ keys: 3, signIns: 2 });
    expect(deleted).toHaveLength(1);
    // The neighbour survives.
    expect(remaining().map((r) => r.id)).toEqual(['6']);
    // Shared rows affect everyone; each user whose row went is told too.
    expect(notified).toEqual([null, 'u-1', 'u-2']);
  });

  it('tells only the affected users when nothing SHARED went', async () => {
    // The `null` sentinel closes every user's pooled MCP connection. A
    // namespace of nothing but per-user rows has not earned that.
    const { db } = fakeDb([
      { id: '1', key: 'foo_API_KEY', userId: 'u-1', kind: 'static' },
      { id: '2', key: 'foo_API_KEY', userId: 'u-2', kind: 'static' },
    ]);
    const vault = new DbSecretsVaultService(db, '');
    const notified: (string | null)[] = [];
    vault.onMutation((u) => notified.push(u));
    await vault.removeNamespace('foo_');
    expect(notified).toEqual(['u-1', 'u-2']);
  });

  it('takes a row written between the scan and the delete', async () => {
    // The membership rule cannot be said in SQL, so the ids are read before
    // they are deleted. A credential landing in that window would otherwise
    // outlive the namespace it belongs to — unreachable and unremovable.
    let wrote = false;
    const { db, deleted, remaining } = fakeDb(
      [{ id: '1', key: 'foo_API_KEY', userId: null, kind: 'static' }],
      (store) => {
        if (wrote) return;
        wrote = true;
        store.push({ id: '2', key: 'foo_LATE_KEY', userId: 'u-9', kind: 'static' });
      },
    );
    const vault = new DbSecretsVaultService(db, '');
    await expect(vault.removeNamespace('foo_')).resolves.toEqual({ keys: 2, signIns: 0 });
    expect(deleted).toHaveLength(2);
    expect(remaining()).toEqual([]);
  });

  it('deletes nothing when the namespace is empty', async () => {
    const { db, deleted } = fakeDb([]);
    const vault = new DbSecretsVaultService(db, '');
    await expect(vault.removeNamespace('foo_')).resolves.toEqual({ keys: 0, signIns: 0 });
    expect(deleted).toHaveLength(0);
  });
});

describe('removeNamespace under a database that misbehaves', () => {
  it('counts what the DELETE returned, not what the scan saw', async () => {
    // A same-key upsert between the scan and the delete can change a row's
    // `kind`. The scan's copy would then misreport a sign-in as a stored key.
    const scanned = { id: '1', key: 'foo_MCP_OAUTH', userId: 'u-1', kind: 'static' };
    const { db } = fakeDb([scanned]);
    // The row is an oauth row by the time it is deleted.
    scanned.kind = 'oauth';
    const vault = new DbSecretsVaultService(db, '');
    await expect(vault.removeNamespace('foo_')).resolves.toEqual({ keys: 0, signIns: 1 });
  });

  it('still tells the listeners about the rows an interrupted run did delete', async () => {
    // Those rows ARE gone. A listener that never heard would keep serving a
    // pooled connection for a credential that no longer exists.
    let scans = 0;
    const { db } = fakeDb([{ id: '1', key: 'foo_API_KEY', userId: 'u-1', kind: 'static' }], () => {
      scans += 1;
      if (scans === 2) throw new Error('connection reset');
    });
    const vault = new DbSecretsVaultService(db, '');
    const notified: (string | null)[] = [];
    vault.onMutation((u) => notified.push(u));
    await expect(vault.removeNamespace('foo_')).rejects.toThrow('connection reset');
    expect(notified).toEqual(['u-1']);
  });
});
