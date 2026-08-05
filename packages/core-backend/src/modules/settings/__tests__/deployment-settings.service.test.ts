import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  DeploymentSettingsService,
  SettingsValidationError,
  CORE_SETTINGS,
} from '../deployment-settings.service.js';
import type { Database } from '../../database/connection.js';

const ENC_KEY = randomBytes(32).toString('base64');

/**
 * An in-memory stand-in for the one table this service owns. Enough of the
 * drizzle surface to exercise load/save round-trips without a live Postgres —
 * the SQL itself is one insert with an upsert target, which the migration
 * covers.
 */
function makeDb() {
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
  return { db, rows };
}

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  for (const def of CORE_SETTINGS) delete process.env[def.envVar];
  delete process.env.GITHUB_TOKEN;
});
afterEach(() => {
  process.env = saved;
});

describe('DeploymentSettingsService — precedence', () => {
  /**
   * The rule the whole design rests on: a stored row is a FALLBACK for a
   * variable nobody set, never an override of one they did. It is what lets an
   * existing deployment adopt this table with no behaviour change, and what
   * stops a value typed into a browser outranking the infrastructure config
   * someone is reviewing in a repo.
   */
  it('lets the environment win over a stored value', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ kbRepoUrl: 'https://example.com/stored.git' }, null);

    process.env.KB_REPO_URL = 'https://example.com/from-env.git';
    expect(settings.resolve('kbRepoUrl')).toBe('https://example.com/from-env.git');
    expect(settings.sourceOf('kbRepoUrl')).toBe('env');

    delete process.env.KB_REPO_URL;
    expect(settings.resolve('kbRepoUrl')).toBe('https://example.com/stored.git');
    expect(settings.sourceOf('kbRepoUrl')).toBe('stored');
  });

  /**
   * Refused, not silently accepted. Storing it would write a row that can never
   * take effect, and leave the screen implying it had.
   */
  it('refuses to store a setting the environment already supplies', async () => {
    process.env.KB_REPO_URL = 'https://example.com/from-env.git';
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await expect(
      settings.save({ kbRepoUrl: 'https://example.com/other.git' }, null),
    ).rejects.toBeInstanceOf(SettingsValidationError);
  });
});

describe('DeploymentSettingsService — secrets', () => {
  it('stores the token as ciphertext and reads it back', async () => {
    const { db, rows } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ gitToken: 'ghp_verysecret' }, null);

    const row = rows.find((r) => r.key === 'gitToken');
    expect(row?.encrypted).toBe(true);
    expect(row?.value).not.toContain('ghp_verysecret');

    // A fresh instance decrypts from the same rows — the round trip, not just
    // the in-memory cache.
    const reloaded = new DeploymentSettingsService(db, ENC_KEY);
    await reloaded.load();
    expect(reloaded.resolve('gitToken')).toBe('ghp_verysecret');
  });

  it('never puts a secret value in what the screen is sent', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ gitToken: 'ghp_verysecret' }, null);

    const described = settings.describe();
    expect(JSON.stringify(described)).not.toContain('ghp_verysecret');
    const token = described.find((s) => s.key === 'gitToken');
    // Configured is all a client learns — enough to render "replace it?".
    expect(token).toMatchObject({ secret: true, configured: true });
    expect(token).not.toHaveProperty('value');
  });

  it('publishes a stored token as GITHUB_TOKEN, which is what git reads', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ gitToken: 'ghp_fromsetup' }, null);
    expect(process.env.GITHUB_TOKEN).toBe('ghp_fromsetup');
  });

  it('does not overwrite a git token the environment supplied', async () => {
    process.env.GIT_TOKEN = 'ghp_fromenv';
    process.env.GITHUB_TOKEN = 'ghp_fromenv';
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    settings.syncGitTokenEnv();
    expect(process.env.GITHUB_TOKEN).toBe('ghp_fromenv');
  });

  it('refuses to store a secret with no encryption key rather than writing plaintext', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, '');
    await expect(settings.save({ gitToken: 'ghp_verysecret' }, null)).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
  });

  /**
   * A rotated or mistyped key must not stop the server booting — the screen
   * where it gets fixed is on the other side of that boot.
   */
  it('survives an undecryptable row instead of failing to start', async () => {
    const { db, rows } = makeDb();
    rows.push({ key: 'gitToken', value: 'not-a-valid-blob', encrypted: true });
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(settings.load()).resolves.toBeUndefined();
    expect(settings.resolve('gitToken')).toBe('');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('DeploymentSettingsService — validation', () => {
  it('rejects the whole batch when one field is wrong', async () => {
    const { db, rows } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await expect(
      settings.save({ kbRepoUrl: 'not-a-url', gitToken: 'ghp_ok' }, null),
    ).rejects.toBeInstanceOf(SettingsValidationError);
    // Nothing written: a URL saved without its token is a deployment that
    // fails at the first clone.
    expect(rows).toHaveLength(0);
  });

  it('rejects a non-https remote', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await expect(
      settings.save({ kbRepoUrl: 'git@github.com:acme/kb.git' }, null),
    ).rejects.toThrow(/Invalid settings/);
  });

  it('rejects a directory name that could escape the workspace', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await expect(settings.save({ kbDirName: '../elsewhere' }, null)).rejects.toThrow(
      /Invalid settings/,
    );
  });

  it('rejects a username that would break out of the credential-helper snippet', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await expect(settings.save({ gitUsername: 'x"; rm -rf /; #' }, null)).rejects.toThrow(
      /Invalid settings/,
    );
  });

  /**
   * A blank field means "leave it alone". Treating it as a delete would let a
   * stray Enter on a half-filled form unconfigure a running deployment.
   */
  it('treats a blank field as no change, not as an erase', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ gitToken: 'ghp_keepme' }, null);
    await settings.save({ gitToken: '   ' }, null);
    expect(settings.resolve('gitToken')).toBe('ghp_keepme');
  });

  it('reports a restart only for a setting a running server cannot pick up', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    const live = await settings.save({ kbRepoUrl: 'https://example.com/kb.git' }, null);
    expect(live.restartRequired).toBe(false);
    const staged = await settings.save({ kbDirName: 'company-brain' }, null);
    expect(staged.restartRequired).toBe(true);
  });
});
