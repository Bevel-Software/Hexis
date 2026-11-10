import { randomBytes } from 'node:crypto';
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
 */
export function realDeploymentSettings(env: NodeJS.ProcessEnv = {}): Settings {
  const rows: { key: string; value: string; encrypted: boolean }[] = [];
  const db = {
    select: () => ({ from: () => Promise.resolve(rows.map((r) => ({ ...r }))) }),
    insert: () => ({
      values: (v: { key: string; value: string; encrypted: boolean }) => ({
        onConflictDoUpdate: () => {
          const existing = rows.find((r) => r.key === v.key);
          if (existing) Object.assign(existing, v);
          else rows.push({ key: v.key, value: v.value, encrypted: v.encrypted });
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Database;
  return new DeploymentSettingsService(db, randomBytes(32).toString('base64'), undefined, { env });
}
