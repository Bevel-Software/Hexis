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
 * The `where` clause IS evaluated: the emails bound into it are matched
 * against the roster the same way Postgres would — against the stored rows as
 * written, with no re-canonicalisation on the double's side. Real rows are
 * canonical (the auth service lowercases every address it writes), so a
 * caller that stopped lowering the emails it asks about would match nothing
 * here, exactly as it would match nothing in Postgres. A double that answered
 * with the whole roster could not tell those two apart.
 */
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
      const asked = new Set(boundValues(condition));
      return rows.filter((r) => asked.has(r.email));
    };
    return query;
  };
  return { select: () => ({ from }) } as unknown as Database;
}
