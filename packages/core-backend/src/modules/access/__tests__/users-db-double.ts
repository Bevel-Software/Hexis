import { Param } from 'drizzle-orm';

import type { Database } from '../../database/connection.js';

/**
 * Every literal bound into a drizzle condition, in order — for
 * `inArray(users.email, emails)` that is exactly `emails`.
 *
 * A drizzle `SQL` is a tree of chunks; the bound values sit in it as `Param`
 * nodes (an `inArray` puts them in a nested array chunk). Reading them back is
 * what lets the double ANSWER the where clause instead of ignoring it, so a
 * test fails when the predicate itself regresses — the wrong column, a dropped
 * filter, or emails passed in a form the canonical rows cannot match.
 */
function boundValues(node: unknown, depth = 0): string[] {
  if (depth > 8 || node === null || node === undefined) return [];
  if (node instanceof Param) return typeof node.value === 'string' ? [node.value] : [];
  if (Array.isArray(node)) return node.flatMap((c) => boundValues(c, depth + 1));
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  return Array.isArray(chunks) ? chunks.flatMap((c) => boundValues(c, depth + 1)) : [];
}

/**
 * A `Database` double answering the only queries the access routes make of
 * it: the `users` reads behind "has this person signed in yet" — the access
 * view's `inArray` lookup over the emails it names, and the suggest route's
 * full-table read.
 *
 * `accounts` is the roster of accounts that EXIST; every other address the
 * routes ask about comes back without one, which is what makes the share
 * dialog label it "hasn't signed in yet".
 *
 * The `where` clause IS evaluated: the values bound into it are matched
 * against the roster the same way Postgres would. The email column is
 * randomized ciphertext, so the routes compare its blind index
 * (`email_bidx`), which they bind the ADDRESSES to — the database handle
 * turns each into its index, over the canonical (trimmed, lowercased)
 * address. The double does what the index does: a caller that stopped
 * lowering the emails it asks about still matches here, as it does in
 * Postgres.
 */
const canonical = (email: string) => email.trim().toLowerCase();

export function usersDbDouble(
  accounts: readonly (string | { email: string; name?: string })[] = [],
): Database {
  const rows = accounts.map((a) => {
    const email = typeof a === 'string' ? a : a.email;
    const name = typeof a === 'string' ? undefined : a.name;
    return { id: `u-${email}`, email, name: name ?? email.split('@')[0] };
  });
  const from = () => {
    // Thenable so a bare `await db.select().from(users)` resolves, with
    // `.where()` hung off it for the narrowed form. Drizzle's builder is
    // shaped the same way.
    const query = Promise.resolve(rows) as Promise<typeof rows> & {
      where: (condition: unknown) => Promise<typeof rows>;
    };
    query.where = async (condition: unknown) => {
      const asked = new Set(boundValues(condition).map(canonical));
      return rows.filter((r) => asked.has(canonical(r.email)));
    };
    return query;
  };
  return { select: () => ({ from }) } as unknown as Database;
}
