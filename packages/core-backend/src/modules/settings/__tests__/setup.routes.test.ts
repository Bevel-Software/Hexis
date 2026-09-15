import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_KB_LAYOUT,
  branchModelFromEnv,
  configureBranchModel,
  configureKbLayout,
  currentKbLayout,
  type KbLayout,
} from '@bevel-software/platform-shared';

/**
 * test-setup configures the branch model from the environment, and nothing
 * unconfigures it; a test that needs the first-run "no branch model yet" state
 * says so here. Everything else is the real module.
 */
const branchModel = vi.hoisted(() => ({ pretendUnconfigured: false }));
vi.mock('@bevel-software/platform-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@bevel-software/platform-shared')>();
  return {
    ...actual,
    isBranchModelConfigured: () => !branchModel.pretendUnconfigured && actual.isBranchModelConfigured(),
    // Applying a model configures it, as the real module does.
    configureBranchModel: (model: Parameters<typeof actual.configureBranchModel>[0]) => {
      actual.configureBranchModel(model);
      branchModel.pretendUnconfigured = false;
    },
  };
});
import { createSetupRoutes } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';

const ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';

let server: HttpServer | null = null;

/**
 * These suites clear the KB variables so `settings.resolve` falls through to
 * the stored layer. They are RESTORED afterwards rather than left deleted: the
 * repo `.env` is loaded into `process.env` by the vitest config, so a suite
 * that runs later in the same worker would otherwise see a different
 * environment than the one it was written against.
 */
const KB_ENV = [
  'KB_REPO_URL',
  'GIT_TOKEN',
  'GIT_USERNAME',
  'KB_DIR_NAME',
  'GITHUB_TOKEN',
  'KB_KNOWLEDGE_BASE_DIR',
  'KB_SKILLS_DIR',
  'KB_PLUGINS_DIR',
] as const;
let savedEnv: Partial<Record<(typeof KB_ENV)[number], string | undefined>> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of KB_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  server?.close();
  server = null;
  for (const k of KB_ENV) {
    const original = savedEnv[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

/** Mount the setup router on a throwaway port and hand back its base URL. */
function listen(isAdmin = true, runAll: () => Promise<void> = async () => {}) {
  const db = {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Database;
  const settings = new DeploymentSettingsService(db, ENC_KEY);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userEmail = 'root@example.com';
    req.userId = 'user-1';
    next();
  });
  app.use(
    '/api',
    createSetupRoutes(
      settings,
      { isAdmin: async () => isAdmin } as IAdminAccessService,
      // Default no-op: most suites never complete setup, so the runner is
      // never reached. The completion-transition suite passes its own spy.
      { runAll },
    ),
  );
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, settings };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * The connection test hands its input to `git`. Anything reaching that command
 * unvalidated is argument injection — admin-only, but "admin" is not "may run
 * arbitrary commands as the server process".
 */
describe('POST /setup/test-connection — what may reach git', () => {
  it('refuses a value git would read as an option', async () => {
    const { base } = listen();
    const res = await post(base, '/api/setup/test-connection', {
      kbRepoUrl: '--upload-pack=touch /tmp/pwned',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
  });

  /** `ext::` is a git transport whose whole purpose is to run a command. */
  it('refuses the ext:: transport', async () => {
    const { base } = listen();
    const res = await post(base, '/api/setup/test-connection', {
      kbRepoUrl: 'ext::sh -c "touch /tmp/pwned"',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a non-https scheme', async () => {
    const { base } = listen();
    const res = await post(base, '/api/setup/test-connection', { kbRepoUrl: 'file:///etc/passwd' });
    expect(res.status).toBe(400);
  });

  it('refuses a username that would break out of the credential-helper snippet', async () => {
    const { base } = listen();
    const res = await post(base, '/api/setup/test-connection', {
      kbRepoUrl: 'https://example.com/acme/kb.git',
      gitUsername: 'x"; touch /tmp/pwned; #',
    });
    expect(res.status).toBe(400);
  });

  it('is admins-only', async () => {
    const { base } = listen(false);
    const res = await post(base, '/api/setup/test-connection', {
      kbRepoUrl: 'https://example.com/acme/kb.git',
    });
    expect(res.status).toBe(403);
  });
});

/**
 * The stored token is deliberately unreadable — `describe()` omits it — so an
 * endpoint that would send it to a caller-named host hands it straight back.
 */
describe('POST /setup/test-connection — where the saved token may go', () => {
  it('refuses to test a different repository with the saved token', async () => {
    const { base, settings } = listen();
    await settings.save(
      { kbRepoUrl: 'https://example.com/acme/kb.git', gitToken: 'ghp_verysecret' },
      null,
    );
    const res = await post(base, '/api/setup/test-connection', {
      kbRepoUrl: 'https://attacker.example/collector.git',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/access token for that repository/i);
  });

  it('still lets an admin re-test the repository that IS configured', async () => {
    const { base, settings } = listen();
    await settings.save(
      { kbRepoUrl: 'https://127.0.0.1:1/acme/kb.git', gitToken: 'ghp_verysecret' },
      null,
    );
    // No credentials in the body: the saved pair is used together, which is the
    // "does the token I saved last week still work?" case.
    const res = await post(base, '/api/setup/test-connection', {});
    // Port 1 refuses instantly — reaching a connection error proves the request
    // got past the guards and ran git, rather than being rejected up front.
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(false);
  });

  it('accepts a different repository when the request brings its own token', async () => {
    const { base, settings } = listen();
    await settings.save(
      { kbRepoUrl: 'https://example.com/acme/kb.git', gitToken: 'ghp_verysecret' },
      null,
    );
    const res = await post(base, '/api/setup/test-connection', {
      kbRepoUrl: 'https://127.0.0.1:1/other/kb.git',
      gitToken: 'ghp_its_own',
    });
    expect(res.status).toBe(200);
  });
});

/**
 * The arguments the route builds have to be ones git actually accepts —
 * `--end-of-options` among them. A rejected FLAG and a refused CONNECTION look
 * alike from the outside (`ok: false`), so this aims at a port nothing listens
 * on: reaching a connection error proves git parsed the command line.
 */
describe('POST /setup/test-connection — the command git is given', () => {
  it('builds a command git accepts', async () => {
    const { base } = listen();
    const res = await post(base, '/api/setup/test-connection', {
      kbRepoUrl: 'https://127.0.0.1:1/acme/kb.git',
      gitToken: 'ghp_whatever',
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).not.toMatch(/unknown option|usage: git/i);
  });
});

/**
 * The KB startup phase's SECOND quiet moment: the save that completes setup.
 * Completion is a false→true TRANSITION (whichever field arrives last, on
 * whichever save), and a failed setup-time run keeps the deployment gated —
 * settings saved, KB uninitialized — until a retry succeeds.
 *
 * The branch model rides in from the environment the vitest config pins
 * (DEFAULT_BRANCH / PROTECTED_BRANCHES) and is configured by test-setup, so
 * completing setup here means storing the repository URL and token — exactly
 * the "branch model configured on an earlier save" gap.
 */
describe('POST /setup/settings — the completion transition and the KB startup phase', () => {
  const completing = { kbRepoUrl: 'https://example.com/acme/kb.git', gitToken: 'ghp_x' };

  it('runs the phase exactly once: on the save that completes setup, not before, not after', async () => {
    let runs = 0;
    const { base } = listen(true, async () => {
      runs++;
    });
    // First save: an incomplete configuration — no phase.
    let res = await post(base, '/api/setup/settings', { settings: { gitUsername: 'x-access-token' } });
    expect(res.status).toBe(200);
    expect(runs).toBe(0);
    // Second save completes setup — the transition runs the phase.
    res = await post(base, '/api/setup/settings', { settings: completing });
    expect(res.status).toBe(200);
    expect((await res.json()).complete).toBe(true);
    expect(runs).toBe(1);
    // A re-save of a complete, healthy setup is NOT a quiet moment.
    res = await post(base, '/api/setup/settings', { settings: { gitUsername: 'x-access-token' } });
    expect(res.status).toBe(200);
    expect(runs).toBe(1);
  });

  it('keeps setup gated after a failed run; a re-save retries, and success clears the gate', async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      let attempts = 0;
      let fail = true;
      const { base } = listen(true, async () => {
        attempts++;
        if (fail) throw new Error('remote said no');
      });
      const res = await post(base, '/api/setup/settings', { settings: completing });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toMatch(/could not be initialized/i);
      expect(attempts).toBe(1);
      // The gate stays shut: status reports incomplete, with the admin's hint.
      let status = await (await fetch(`${base}/api/setup/status`)).json();
      expect(status.complete).toBe(false);
      expect(status.kbInitError).toMatch(/remote said no/);
      // Any save while the failure stands retries the phase.
      fail = false;
      const retry = await post(base, '/api/setup/settings', {
        settings: { gitUsername: 'x-access-token' },
      });
      expect(retry.status).toBe(200);
      expect(attempts).toBe(2);
      expect((await retry.json()).complete).toBe(true);
      status = await (await fetch(`${base}/api/setup/status`)).json();
      expect(status.complete).toBe(true);
      expect(status.kbInitError).toBeUndefined();
    } finally {
      console.error = consoleError;
    }
  });

  it('keeps the gate shut while the phase runs, and a save landing mid-run waits the phase out', async () => {
    let runs = 0;
    let release!: () => void;
    const running = new Promise<void>((r) => (release = r));
    const { base } = listen(true, async () => {
      runs++;
      await running;
    });
    // The completing save blocks inside the phase...
    const first = post(base, '/api/setup/settings', { settings: completing });
    // release() in a finally: a mid-test assertion failure must still unblock
    // the phase, or `first`/`second` hang pending until the vitest timeout.
    let second!: Promise<Response>;
    try {
      await new Promise((r) => setTimeout(r, 50));
      // ...during which the settings read complete but the GATE must not open —
      // the phase is still mutating branch trees.
      const status = await (await fetch(`${base}/api/setup/status`)).json();
      expect(status.complete).toBe(false);
      // A save landing mid-run is HELD until the phase settles: the runner
      // reads its configuration through live getters, and a save applied under
      // it would split the run across two configurations. It must neither
      // resolve early nor start a second run over the same trees.
      let secondSettled = false;
      second = post(base, '/api/setup/settings', {
        settings: { gitUsername: 'x-access-token' },
      }).then((r) => {
        secondSettled = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(secondSettled).toBe(false);
      expect(runs).toBe(1);
    } finally {
      release();
    }
    const [res1, res2] = await Promise.all([first, second]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(runs).toBe(1);
    expect((await (await fetch(`${base}/api/setup/status`)).json()).complete).toBe(true);
  });
});

/**
 * The folder names are applied once at boot, so a first-run choice would be
 * ignored by the phase — `Skills/` scaffolded beside the `skills/` the admin
 * named — until a restart. The completing save applies them first, while the
 * process still holds the defaults; after that they stay restart-to-apply.
 */
describe('POST /setup/settings — the folder names on the completing save', () => {
  const completing = { kbRepoUrl: 'https://example.com/acme/kb.git', gitToken: 'ghp_x' };
  afterEach(() => configureKbLayout({ ...DEFAULT_KB_LAYOUT }));

  it('applies them before the phase runs, and asks for no restart over them', async () => {
    const seenByPhase: KbLayout[] = [];
    const { base } = listen(true, async () => {
      seenByPhase.push(currentKbLayout());
    });
    const res = await post(base, '/api/setup/settings', {
      settings: { ...completing, knowledgeBaseDir: 'Docs', skillsDir: 'skills' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.complete).toBe(true);
    expect(body.restartRequired).toBe(false);
    expect(seenByPhase).toEqual([{ knowledgeBaseDir: 'Docs', skillsDir: 'skills', pluginsDir: 'Plugins' }]);
    expect(currentKbLayout()).toEqual({ knowledgeBaseDir: 'Docs', skillsDir: 'skills', pluginsDir: 'Plugins' });
  });

  it('applies names stored by an earlier, incomplete save', async () => {
    const seenByPhase: KbLayout[] = [];
    const { base } = listen(true, async () => {
      seenByPhase.push(currentKbLayout());
    });
    await post(base, '/api/setup/settings', { settings: { pluginsDir: 'plugins' } });
    expect(currentKbLayout().pluginsDir).toBe('Plugins');
    await post(base, '/api/setup/settings', { settings: completing });
    expect(seenByPhase[0]?.pluginsDir).toBe('plugins');
  });

  it('leaves them restart-to-apply once setup is complete', async () => {
    const { base } = listen();
    await post(base, '/api/setup/settings', { settings: completing });
    const res = await post(base, '/api/setup/settings', { settings: { pluginsDir: 'plugins' } });
    expect(res.status).toBe(200);
    expect((await res.json()).restartRequired).toBe(true);
    expect(currentKbLayout().pluginsDir).toBe('Plugins');
  });

  it('does not replace a layout the process already runs', async () => {
    configureKbLayout({ knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' });
    const seenByPhase: KbLayout[] = [];
    const { base } = listen(true, async () => {
      seenByPhase.push(currentKbLayout());
    });
    const res = await post(base, '/api/setup/settings', {
      settings: { ...completing, skillsDir: 'capabilities' },
    });
    expect((await res.json()).restartRequired).toBe(true);
    expect(seenByPhase[0]?.skillsDir).toBe('skills');
  });

  it('applies names corrected between a failed run and its retry', async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      const seenByPhase: KbLayout[] = [];
      let fail = true;
      const { base } = listen(true, async () => {
        seenByPhase.push(currentKbLayout());
        if (fail) throw new Error('remote said no');
      });
      const first = await post(base, '/api/setup/settings', {
        settings: { ...completing, skillsDir: 'skills' },
      });
      expect(first.status).toBe(500);
      // The gate never opened, so the retry initializes what is saved NOW.
      fail = false;
      const retry = await post(base, '/api/setup/settings', { settings: { skillsDir: 'capabilities' } });
      expect(retry.status).toBe(200);
      const body = await retry.json();
      expect(body.complete).toBe(true);
      expect(body.restartRequired).toBe(false);
      expect(seenByPhase.map((l) => l.skillsDir)).toEqual(['skills', 'capabilities']);
      expect(currentKbLayout().skillsDir).toBe('capabilities');
    } finally {
      console.error = consoleError;
    }
  });

  /**
   * The vitest config pins the branch pair in the environment, which makes the
   * settings env-sourced and so refused by a save; these tests store their own.
   */
  async function withoutBranchEnv(test: () => Promise<void>) {
    const saved = { DEFAULT_BRANCH: process.env.DEFAULT_BRANCH, PROTECTED_BRANCHES: process.env.PROTECTED_BRANCHES };
    delete process.env.DEFAULT_BRANCH;
    delete process.env.PROTECTED_BRANCHES;
    try {
      await test();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      // Whatever the test applied, the rest of the worker runs on the pinned model.
      configureBranchModel(branchModelFromEnv());
    }
  }

  it('asks for no restart over a branch model the completing save also applied', () =>
    withoutBranchEnv(async () => {
    branchModel.pretendUnconfigured = true;
    try {
      const { base } = listen(true);
      const res = await post(base, '/api/setup/settings', {
        settings: {
          ...completing,
          skillsDir: 'skills',
          defaultBranch: 'production',
          protectedBranches: 'production,staging',
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.complete).toBe(true);
      expect(body.restartRequired).toBe(false);
    } finally {
      branchModel.pretendUnconfigured = false;
    }
    }));

  it('still asks for a restart over a branch change once a branch model is in effect', () =>
    withoutBranchEnv(async () => {
      const { base } = listen(true);
      const res = await post(base, '/api/setup/settings', {
        settings: { ...completing, defaultBranch: 'production', protectedBranches: 'production,staging' },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).restartRequired).toBe(true);
    }));
});

describe('GET /setup/status', () => {
  it('tells a non-admin whether setup is done, and nothing else', async () => {
    const { base } = listen(false);
    const res = await fetch(`${base}/api/setup/status`);
    const body = await res.json();
    expect(body).toEqual({ complete: false, isAdmin: false });
    // No catalogue, so no variable names and no hint at what is missing.
    expect(JSON.stringify(body)).not.toContain('KB_REPO_URL');
  });

  it('never includes a stored secret, even for an admin', async () => {
    const { base, settings } = listen();
    await settings.save({ gitToken: 'ghp_verysecret' }, null);
    const res = await fetch(`${base}/api/setup/status`);
    expect(JSON.stringify(await res.json())).not.toContain('ghp_verysecret');
  });
});
