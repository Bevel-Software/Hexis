import { randomBytes } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Database } from '../modules/database/index.js';
import type { DeploymentSettingsService as Settings } from '../modules/settings/index.js';
import { DeploymentSettingsService } from '../modules/settings/deployment-settings.service.js';

/**
 * Deployment settings, built the way the composition root builds them
 * (`core/create-core-services.ts`: one `DeploymentSettingsService` over the
 * database, the secrets key and the environment it reads), over an in-memory
 * stand-in for the `deployment_settings` table that starts empty. A module's
 * suite that needs settings for real (a saved value read live, an environment
 * value refusing a save) takes them from HERE rather than constructing another
 * module's implementation itself: the service is on the settings entry as a
 * type only, by design, and this fixture stands in for the root, as
 * `real-disk.ts` does for the disk.
 *
 * `env` is the environment the service reads, empty unless the test passes
 * one, so no suite has to clear or restore `process.env`.
 *
 * The table answers the statements this service sends, by the table's own
 * rule (one row per key) and each statement's bound values: an upsert, an
 * insert that yields to a row already there, a read of every row or of one
 * key's, a delete by key (every value the statement binds is taken as a key),
 * and the conditional delete and update that match on key AND value. It is
 * not a SQL engine: a statement of another shape is not modelled.
 * `real-settings.test.ts` drives each of these through the service.
 */
export function realDeploymentSettings(env: NodeJS.ProcessEnv = {}): Settings {
  return new DeploymentSettingsService(settingsTable(), randomBytes(32).toString('base64'), undefined, { env });
}

interface Row {
  key: string;
  value: string;
  encrypted: boolean;
}

/** The values a drizzle predicate binds, in order: what the table matches on. */
function bound(predicate: unknown): unknown[] {
  return new PgDialect().sqlToQuery(predicate as SQL).params;
}

/**
 * A statement that runs when it is awaited and not before, as a query builder
 * does: `delete().where(p)` deletes if awaited as it stands, and does
 * something else if `.returning()` is called on it first.
 */
function statement<T>(run: () => T): PromiseLike<T> {
  return { then: (resolved, rejected) => Promise.resolve().then(run).then(resolved, rejected) };
}

function settingsTable(): Database {
  const rows: Row[] = [];
  const copies = (of: Row[]) => of.map((row) => ({ ...row }));
  return {
    select: () => ({
      from: () =>
        Object.assign(
          statement(() => copies(rows)),
          // `where key = ?`: that key's row.
          { where: (predicate: unknown) => statement(() => copies(rows.filter((row) => row.key === bound(predicate)[0]))) },
        ),
    }),
    insert: () => ({
      values: (v: Row) => {
        const insertIfAbsent = () => {
          if (rows.some((row) => row.key === v.key)) return [];
          rows.push({ key: v.key, value: v.value, encrypted: v.encrypted });
          return [{ key: v.key }];
        };
        return {
          onConflictDoUpdate: () =>
            statement(() => {
              const existing = rows.find((row) => row.key === v.key);
              if (existing) Object.assign(existing, { value: v.value, encrypted: v.encrypted });
              else rows.push({ key: v.key, value: v.value, encrypted: v.encrypted });
            }),
          onConflictDoNothing: () => Object.assign(statement(() => void insertIfAbsent()), { returning: () => statement(insertIfAbsent) }),
        };
      },
    }),
    delete: () => ({
      where: (predicate: unknown) =>
        Object.assign(
          // `where key = ?` or `where key in (…)`: every bound value is a key.
          statement(() => {
            const keys = bound(predicate);
            for (let at = rows.length - 1; at >= 0; at -= 1) if (keys.includes(rows[at].key)) rows.splice(at, 1);
          }),
          // `where key = ? and value = ? returning`: the conditional delete.
          {
            returning: () =>
              statement(() => {
                const [key, value] = bound(predicate);
                const at = rows.findIndex((row) => row.key === key && row.value === value);
                if (at === -1) return [];
                rows.splice(at, 1);
                return [{ key }];
              }),
          },
        ),
    }),
    update: () => ({
      set: (v: { value: string }) => ({
        // `where key = ? and value = ? returning`: the conditional update.
        where: (predicate: unknown) => ({
          returning: () =>
            statement(() => {
              const [key, value] = bound(predicate);
              const row = rows.find((candidate) => candidate.key === key && candidate.value === value);
              if (!row) return [];
              row.value = v.value;
              return [{ key }];
            }),
        }),
      }),
    }),
  } as unknown as Database;
}
