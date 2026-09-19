import type { Database } from '../../database/connection.js';

/**
 * A `Database` double answering the only queries the access routes make of
 * it: the `users` reads behind "has this person signed in yet" — the access
 * view's `inArray` lookup over the emails it names, and the suggest route's
 * full-table read.
 *
 * `accounts` is the roster of accounts that EXIST; every other address the
 * routes ask about comes back without one, which is what makes the share
 * dialog label it "hasn't signed in yet". The `where` clause is not
 * evaluated — the double answers with the whole roster and the caller
 * narrows it by membership, exactly as it does with the real query's result.
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
      where: () => Promise<typeof rows>;
    };
    query.where = async () => rows;
    return query;
  };
  return { select: () => ({ from }) } as unknown as Database;
}
