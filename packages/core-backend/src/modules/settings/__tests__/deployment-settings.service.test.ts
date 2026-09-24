import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  DeploymentSettingsService,
  SettingsValidationError,
  CORE_SETTINGS,
  LEGACY_LAYOUT_ENV_VARS,
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
  for (const def of CORE_SETTINGS) if (def.envVar) delete process.env[def.envVar];
  // Retired, and so no longer in the catalogue — but a test about the import
  // has to start from a process that is not already carrying one.
  for (const envVar of Object.values(LEGACY_LAYOUT_ENV_VARS)) delete process.env[envVar];
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

describe('DeploymentSettingsService — a blank that means the default', () => {
  /**
   * The rule everywhere else: a blank field leaves a setting alone. The Audit
   * log's retention window is the exception that declares itself — its
   * readers already treat "unset" as the default, so clearing the field is
   * the one way back to that default, and a blank saves as a clear.
   */
  it('clears a blank-means-default setting on a blank save and leaves every other blank alone', async () => {
    const { db, rows } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ auditRetentionDays: '30', kbRepoUrl: 'https://example.com/stored.git' }, null);
    expect(settings.resolve('auditRetentionDays')).toBe('30');

    await settings.save({ auditRetentionDays: '', kbRepoUrl: '' }, null);

    expect(settings.resolve('auditRetentionDays')).toBe('');
    expect(settings.sourceOf('auditRetentionDays')).toBe('unset');
    // The repository address was blank too, and blank still means "leave it".
    expect(settings.resolve('kbRepoUrl')).toBe('https://example.com/stored.git');
    expect(rows.some((r) => r.key === 'kbRepoUrl')).toBe(true);
  });

  it('holds the retention window to the same rule on save as the runtime reader does', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    for (const bad of ['1.5', 'lots', 'ten days']) {
      await expect(settings.save({ auditRetentionDays: bad }, null)).rejects.toBeInstanceOf(SettingsValidationError);
    }
    // A number of days, or zero / negative for "forever" — the reader's rule.
    for (const ok of ['3650', '0', '-1', '99999']) {
      await expect(settings.save({ auditRetentionDays: ok }, null)).resolves.toBeDefined();
    }
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

describe('DeploymentSettingsService — KB layout', () => {
  it('resolves the four names to their defaults when nothing names them', () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    expect(settings.resolveKbLayout()).toEqual({
      knowledgeBaseDir: 'KnowledgeBase',
      skillsDir: 'Skills',
      pluginsDir: 'Plugins',
      agentsFile: 'AGENTS.md',
    });
    // The pointer is on until someone says otherwise.
    expect(settings.resolveAgentsFileLink()).toBe(true);
  });

  /**
   * The checkout folder may not be named like a repository root: every path
   * under that root would then read as the checkout itself. Setup applies a
   * saved layout to the running process without a restart, so the collision
   * has to be refused at save time, whichever side of it the operator typed.
   */
  it('refuses a layout root named like the checkout folder, and a checkout folder named like a root', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    // The knowledge root renamed onto the checkout's default name.
    await expect(settings.save({ knowledgeBaseDir: 'knowledge-base' }, null)).rejects.toMatchObject({
      problems: { knowledgeBaseDir: expect.stringContaining('knowledgeBaseDir ("knowledge-base")') },
    });
    // The checkout renamed onto the knowledge root's name, in another case.
    await expect(settings.save({ kbDirName: 'knowledgebase' }, null)).rejects.toMatchObject({
      problems: { kbDirName: expect.stringContaining('knowledgeBaseDir ("KnowledgeBase")') },
    });
    // Nothing was written by either refusal, and an unrelated rename still lands.
    expect(settings.resolveKbLayout().knowledgeBaseDir).toBe('KnowledgeBase');
    await expect(settings.save({ kbDirName: 'checkout' }, null)).resolves.toBeTruthy();
  });

  /**
   * The layout is entered in the app and nowhere else now. A variable still
   * sitting in the environment cannot outrank the saved answer, and cannot
   * lock the field the way an environment-backed setting does.
   */
  it('ignores the environment for the four layout names', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ skillsDir: 'skills', pluginsDir: 'plugins', agentsFile: 'HEXIS.md' }, null);
    process.env.KB_SKILLS_DIR = 'capabilities';
    expect(settings.resolveKbLayout()).toMatchObject({ skillsDir: 'skills', agentsFile: 'HEXIS.md' });
    expect(settings.sourceOf('skillsDir')).toBe('stored');
    // Not locked: the field stays editable in the app, and a save of it is
    // accepted rather than refused as 'set by the environment'.
    await expect(settings.save({ skillsDir: 'abilities' }, null)).resolves.toBeTruthy();
    expect(settings.resolveKbLayout().skillsDir).toBe('abilities');
    // The catalogue no longer advertises a variable for them at all.
    const described = settings.describe().find((d) => d.key === 'skillsDir');
    expect(described?.envVar).toBeUndefined();
    expect(described?.source).toBe('stored');
  });

  /**
   * The upgrade path for a deployment that set the roots in its environment:
   * one import, then the environment is over.
   */
  describe('the one-time import of the retired layout variables', () => {
    it('saves a still-set variable when nothing is saved, and says the variable can go', async () => {
      const { db, rows } = makeDb();
      const settings = new DeploymentSettingsService(db, ENC_KEY);
      await settings.load();
      process.env.KB_PLUGINS_DIR = 'plugins';
      const noted = vi.spyOn(console, 'log').mockImplementation(() => {});
      await settings.importLegacyLayoutEnv();
      expect(rows).toContainEqual(expect.objectContaining({ key: 'pluginsDir', value: 'plugins' }));
      // The layout is unchanged by the import — that is the whole point.
      expect(settings.resolveKbLayout().pluginsDir).toBe('plugins');
      expect(noted.mock.calls.flat().join(' ')).toMatch(/KB_PLUGINS_DIR[\s\S]*can be removed/);
      noted.mockRestore();
    });

    it('keeps a differing saved value and warns that the variable is ignored', async () => {
      const { db, rows } = makeDb();
      const settings = new DeploymentSettingsService(db, ENC_KEY);
      await settings.save({ pluginsDir: 'Plugins' }, null);
      process.env.KB_PLUGINS_DIR = 'plugins';
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await settings.importLegacyLayoutEnv();
      expect(settings.resolveKbLayout().pluginsDir).toBe('Plugins');
      expect(rows.filter((r) => r.key === 'pluginsDir')).toEqual([
        expect.objectContaining({ value: 'Plugins' }),
      ]);
      expect(warned.mock.calls.flat().join(' ')).toMatch(/KB_PLUGINS_DIR is ignored/);
      warned.mockRestore();
    });

    it('does nothing at all when no variable is set', async () => {
      const { db, rows } = makeDb();
      const settings = new DeploymentSettingsService(db, ENC_KEY);
      await settings.load();
      await settings.importLegacyLayoutEnv();
      expect(rows).toHaveLength(0);
      expect(settings.resolveKbLayout()).toMatchObject({ pluginsDir: 'Plugins', skillsDir: 'Skills' });
    });
  });

  /**
   * The guide's file name is saved beside the folders and judged with them:
   * the four must differ, and a name that is not one markdown file is refused
   * with the rule it broke.
   */
  it('refuses a guide name that is not one markdown file of its own', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    for (const bad of ['guides/HEXIS.md', 'HEXIS.txt', 'CLAUDE.md', 'access.md', 'roles.yaml']) {
      await expect(settings.save({ agentsFile: bad }, null)).rejects.toBeInstanceOf(
        SettingsValidationError,
      );
    }
    await expect(settings.save({ agentsFile: 'HEXIS.md' }, null)).resolves.toBeTruthy();
  });

  it('refuses a guide named after a root folder, from either side of the pair', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    // The plugins folder already in effect, named by the guide alone.
    await settings.save({ pluginsDir: 'Guide.md' }, null);
    await expect(settings.save({ agentsFile: 'guide.md' }, null)).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    // And the other way round, in one batch.
    await expect(
      settings.save({ agentsFile: 'HEXIS.md', skillsDir: 'hexis.md' }, null),
    ).rejects.toBeInstanceOf(SettingsValidationError);
  });

  it('marks the guide name and its pointer setting as restart-to-apply', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    expect((await settings.save({ agentsFile: 'HEXIS.md' }, null)).restartKeys).toContain('agentsFile');
    expect((await settings.save({ agentsFileLink: 'false' }, null)).restartKeys).toContain(
      'agentsFileLink',
    );
    expect(settings.resolveAgentsFileLink()).toBe(false);
  });

  /**
   * A restart is owed for a CHANGE, and saving what a deployment is already
   * running on is not one. Both of these settings mean something while unset —
   * the guide is `AGENTS.md`, the pointer is on — so the first save of that
   * same answer changes nothing the process would pick up at a restart.
   */
  it('owes no restart for saving the value an unset setting already meant', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    // The checkbox arrives ticked, and ticked is what an unset one already is.
    expect((await settings.save({ agentsFileLink: 'true' }, null)).restartKeys).not.toContain(
      'agentsFileLink',
    );
    expect((await settings.save({ agentsFile: 'AGENTS.md' }, null)).restartKeys).not.toContain(
      'agentsFile',
    );
    expect((await settings.save({ skillsDir: 'Skills' }, null)).restartKeys).not.toContain('skillsDir');
    // And the setting still reads as it did.
    expect(settings.resolveAgentsFileLink()).toBe(true);
    // Turning it off from there IS a change, and still reports one.
    expect((await settings.save({ agentsFileLink: 'false' }, null)).restartKeys).toContain(
      'agentsFileLink',
    );
  });

  /**
   * The trio rule is judged on the layout the save WOULD produce: a plugins
   * folder renamed to collide with the skills folder already in effect is a
   * collision even though the batch names only one of them.
   */
  it('refuses two roots that share a name, case-insensitively', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await expect(settings.save({ pluginsDir: 'skills' }, null)).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    await expect(settings.save({ pluginsDir: 'SKILLS' }, null)).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    await expect(
      settings.save({ knowledgeBaseDir: 'Content', skillsDir: 'content' }, null),
    ).rejects.toBeInstanceOf(SettingsValidationError);
  });

  it('refuses a root that is not a single plain folder name', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    for (const bad of ['a/b', '..', '.hidden', 'x\\y']) {
      await expect(settings.save({ skillsDir: bad }, null)).rejects.toBeInstanceOf(
        SettingsValidationError,
      );
    }
  });

  it('marks a layout change as restart-to-apply', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    const { restartRequired } = await settings.save({ pluginsDir: 'Bundles' }, null);
    expect(restartRequired).toBe(true);
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

  /**
   * The branch pair is the one rule no per-field check can express: the default
   * has to appear in the protected list, so each name is only valid in the
   * other's company. If it were not checked, the pair would be rejected far
   * later — by `configureBranchModel` at the NEXT BOOT, which is a deployment
   * that saved successfully and then would not start.
   */
  it('refuses a default branch that is not in the protected list', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await expect(
      settings.save({ defaultBranch: 'main', protectedBranches: 'release' }, null),
    ).rejects.toBeInstanceOf(SettingsValidationError);
  });

  it('accepts a pair that agrees', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ defaultBranch: 'main', protectedBranches: 'main, release' }, null);
    expect(settings.resolve('defaultBranch')).toBe('main');
  });

  /**
   * Judged on the model the save WOULD produce, not on the input: setting one
   * half against an existing other half has to be checked against the result.
   */
  it('checks a half-save against what is already in effect', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ defaultBranch: 'main', protectedBranches: 'main' }, null);
    // Narrowing the protected list to one that excludes the standing default.
    await expect(settings.save({ protectedBranches: 'release' }, null)).rejects.toBeInstanceOf(
      SettingsValidationError,
    );
    // …and the other way: a default that the standing list does cover.
    await settings.save({ protectedBranches: 'main, release' }, null);
    await expect(settings.save({ defaultBranch: 'release' }, null)).resolves.toBeTruthy();
  });

  it('seals the SSO client secret like the git token', async () => {
    const { db, rows } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    await settings.save({ oidcClientSecret: 'sso-very-secret' }, null);
    expect(rows.find((r) => r.key === 'oidcClientSecret')?.encrypted).toBe(true);
    expect(JSON.stringify(settings.describe())).not.toContain('sso-very-secret');
  });

  it('reports a restart only for a setting a running server cannot pick up', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    const live = await settings.save({ kbRepoUrl: 'https://example.com/kb.git' }, null);
    expect(live.restartRequired).toBe(false);
    const staged = await settings.save({ kbDirName: 'company-brain' }, null);
    expect(staged.restartRequired).toBe(true);
  });

  /** The OIDC provider reads these on every sign-in, so saving them owes no restart. */
  it('never asks for a restart for the single sign-on settings', async () => {
    const { db } = makeDb();
    const settings = new DeploymentSettingsService(db, ENC_KEY);
    const sso = await settings.save(
      {
        oidcIssuerUrl: 'https://idp.example.com',
        oidcClientId: 'hexis',
        oidcClientSecret: 'sso-very-secret',
        oidcScopes: 'openid email',
        oidcProviderLabel: 'Company SSO',
      },
      null,
    );
    expect(sso).toEqual({ restartRequired: false, restartKeys: [] });
    const changed = await settings.save(
      { oidcIssuerUrl: 'https://other-idp.example.com', oidcProviderLabel: 'Acme login' },
      null,
    );
    expect(changed.restartRequired).toBe(false);
    // …while one that genuinely needs it, saved alongside, still says so.
    const mixed = await settings.save(
      { oidcClientId: 'hexis-2', allowedEmailDomains: 'example.com' },
      null,
    );
    expect(mixed.restartKeys).toEqual(['allowedEmailDomains']);
    expect(
      settings.describe().filter((s) => s.key.startsWith('oidc') && s.restartToApply),
    ).toEqual([]);
  });
});
