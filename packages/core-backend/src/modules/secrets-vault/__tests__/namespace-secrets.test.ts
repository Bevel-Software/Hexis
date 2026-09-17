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

  it('keeps a declared `_`-leading variable, which is the one legal exception', () => {
    expect(isKeyInNamespace('foo__X', foo)).toBe(false);
    expect(isKeyInNamespace('foo__X', foo, ['_X'])).toBe(true);
  });

  it('is not the prefix itself, and not an unrelated key', () => {
    expect(isKeyInNamespace('foo_', foo)).toBe(false);
    expect(isKeyInNamespace('bar_API_KEY', foo)).toBe(false);
  });
});

/** Minimal drizzle chain: `select…where` resolves rows, `delete…where` records. */
function fakeDb(rows: { id: string; key: string; userId: string | null; kind: string }[]) {
  const deleted: unknown[] = [];
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
    select: vi.fn(() => chain(rows)),
    delete: vi.fn(() => {
      const c = chain([]) as Record<string, unknown>;
      c.where = vi.fn((cond: unknown) => {
        deleted.push(cond);
        return c;
      });
      return c;
    }),
  } as unknown as Database;
  return { db, deleted };
}

describe('countNamespace / removeNamespace', () => {
  const rows = [
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
    const { db, deleted } = fakeDb(rows);
    const vault = new DbSecretsVaultService(db, '');
    const notified: (string | null)[] = [];
    vault.onMutation((u) => notified.push(u));
    await expect(vault.removeNamespace('foo_')).resolves.toEqual({ keys: 3, signIns: 2 });
    expect(deleted).toHaveLength(1);
    // Shared rows affect everyone; each user whose row went is told too.
    expect(notified).toEqual([null, 'u-1', 'u-2']);
  });

  it('deletes nothing when the namespace is empty', async () => {
    const { db, deleted } = fakeDb([]);
    const vault = new DbSecretsVaultService(db, '');
    await expect(vault.removeNamespace('foo_')).resolves.toEqual({ keys: 0, signIns: 0 });
    expect(deleted).toHaveLength(0);
  });
});
