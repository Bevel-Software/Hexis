import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KbLayout } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { KbContext } from '../../../shared/kb-context.js';
import { createSetupRoutes } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { ConnectionCheck, RepositoryConnection } from '../connection-check.js';
import type { RootFolderListing } from '../git-root-folders.js';

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

/** Stands in for the remote: says a connection reads and writes, and counts the asks. */
function connectedCheck() {
  const asked: RepositoryConnection[] = [];
  const check = async (connection: RepositoryConnection): Promise<ConnectionCheck> => {
    asked.push(connection);
    return { outcome: 'connected', branches: ['main'], defaultBranch: 'main', empty: false };
  };
  return { asked, check };
}

/**
 * Mount the setup router on a throwaway port and hand back its base URL.
 * `checkConnection` defaults to the REAL check — the test-connection suites
 * aim it at a port nothing listens on — and save suites pass a stand-in.
 * `isAdmin` may be a function, for suites that change who is asking mid-test.
 */
function listen(
  isAdmin: boolean | (() => boolean) = true,
  runAll: () => Promise<void> = async () => {},
  checkConnection?: (connection: RepositoryConnection) => Promise<ConnectionCheck>,
  listFolders?: (listing: RootFolderListing) => Promise<string[] | null>,
  /**
   * The running graph's knowledge-base context, which the completing save
   * applies the admin's names to. The default is a configured deployment; a
   * suite that needs the first-run "no branch model yet" state passes its own.
   */
  kb: KbContext = testKbContext(),
) {
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
      {
        isAdmin: async () => (typeof isAdmin === 'function' ? isAdmin() : isAdmin),
      } as IAdminAccessService,
      // Default no-op: most suites never complete setup, so the runner is
      // never reached. The completion-transition suite passes its own spy.
      { runAll },
      kb,
      undefined,
      checkConnection,
      listFolders,
    ),
  );
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, settings, kb };
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

  /** The KB startup refuses such a URL; the credential would sit in git's argv. */
  it('refuses a URL carrying credentials', async () => {
    const { base } = listen();
    const res = await post(base, '/api/setup/test-connection', {
      kbRepoUrl: 'https://x-access-token:ghp_embedded@example.com/acme/kb.git',
      gitToken: 'ghp_x',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Remove the username and token from the URL/);
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
    }, connectedCheck().check);
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

  it('a first run with GIT_TOKEN in the environment completes on the save that brings the address', async () => {
    // The form cannot edit an environment-sourced token, so if the save that
    // first names the repository were refused as "a new address needs its own
    // token", setup could never be completed through the UI at all. Until an
    // address is configured there is no repository the token was set for.
    process.env.GIT_TOKEN = 'ghp_from_env';
    const remote = connectedCheck();
    let runs = 0;
    const { base } = listen(true, async () => {
      runs++;
    }, remote.check);

    const res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: 'https://example.com/acme/kb.git' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).complete).toBe(true);
    expect(runs).toBe(1);
    // The environment's token went to the address the admin gave it, once.
    expect(remote.asked.map((c) => [c.url, c.token])).toEqual([['https://example.com/acme/kb.git', 'ghp_from_env']]);
  });

  it('still refuses to move an environment-sourced token to a DIFFERENT repository once one is configured', async () => {
    process.env.GIT_TOKEN = 'ghp_from_env';
    const remote = connectedCheck();
    const { base } = listen(true, async () => {}, remote.check);
    // The first pairing: the address is stored, the token stays in the environment.
    let res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: 'https://example.com/acme/kb.git' },
    });
    expect(res.status).toBe(200);

    // Now there IS a repository the token was set for; a different one is refused.
    res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: 'https://example.com/other/kb.git' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).problems.kbRepoUrl).toMatch(/GIT_TOKEN environment variable/);
    expect(remote.asked.map((c) => c.url)).toEqual(['https://example.com/acme/kb.git']);
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
      }, connectedCheck().check);
      const res = await post(base, '/api/setup/settings', { settings: completing });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toMatch(/could not be initialized/i);
      expect(body.kbInit.kind).toBe('unknown');
      expect(attempts).toBe(1);
      // The gate stays shut: status reports incomplete, with the same classified cause.
      let status = await (await fetch(`${base}/api/setup/status`)).json();
      expect(status.complete).toBe(false);
      expect(status.kbInit).toEqual(body.kbInit);
      // An EMPTY save — what "Retry initialization" sends — retries the phase.
      fail = false;
      const retry = await post(base, '/api/setup/settings', { settings: {} });
      expect(retry.status).toBe(200);
      expect(attempts).toBe(2);
      expect((await retry.json()).complete).toBe(true);
      status = await (await fetch(`${base}/api/setup/status`)).json();
      expect(status.complete).toBe(true);
      expect(status.kbInit).toBeUndefined();
    } finally {
      console.error = consoleError;
    }
  });

  it('a retry that fails again answers with the fresh classification', async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      const failures = [
        'git ls-remote failed: fatal: Authentication failed for x',
        'KB startup step "template-files" failed: disk full',
      ];
      const { base } = listen(true, async () => {
        throw new Error(failures.shift());
      }, connectedCheck().check);
      const first = await (await post(base, '/api/setup/settings', { settings: completing })).json();
      expect(first.kbInit.kind).toBe('credentials-rejected');
      const second = await post(base, '/api/setup/settings', { settings: {} });
      expect(second.status).toBe(500);
      const body = await second.json();
      expect(body.kbInit.kind).toBe('step-failed');
      expect(body.kbInit.cause).toContain('"template-files"');
      const status = await (await fetch(`${base}/api/setup/status`)).json();
      expect(status.kbInit).toEqual(body.kbInit);
    } finally {
      console.error = consoleError;
    }
  });

  it('sends the browser { kind, cause } and never the raw message; the raw message is logged', async () => {
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      const raw =
        "git push failed: Command failed: git push origin HEAD:refs/heads/main\nremote: Permission to acme/kb.git denied to bot-7f3a.\nfatal: unable to access 'https://github.com/acme/kb.git/': The requested URL returned error: 403";
      const { base } = listen(true, async () => {
        throw new Error(raw);
      }, connectedCheck().check);
      const res = await post(base, '/api/setup/settings', { settings: completing });
      const body = await res.json();
      expect(Object.keys(body.kbInit).sort()).toEqual(['cause', 'kind']);
      expect(body.kbInit.kind).toBe('write-refused');
      const statusText = await (await fetch(`${base}/api/setup/status`)).text();
      for (const text of [JSON.stringify(body), statusText]) {
        expect(text).not.toContain('bot-7f3a');
        expect(text).not.toContain('Permission to');
        expect(text).not.toContain('kbInitError');
      }
      expect(logged.some((line) => line.includes('bot-7f3a'))).toBe(true);
    } finally {
      console.error = consoleError;
    }
  });

  it('scrubs the settings-stored token from the logged message, even when the environment has none', async () => {
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      const { base } = listen(true, async () => {
        // The save publishes a stored token to GITHUB_TOKEN; take it away so
        // only the settings service still knows it.
        delete process.env.GITHUB_TOKEN;
        throw new Error('fatal: helper answered ghp_storedsecret12345 and was refused');
      }, connectedCheck().check);
      await post(base, '/api/setup/settings', {
        settings: { ...completing, gitToken: 'ghp_storedsecret12345' },
      });
      expect(logged.length).toBeGreaterThan(0);
      expect(logged.join('\n')).not.toContain('ghp_storedsecret12345');
      expect(logged.join('\n')).toContain('***');
    } finally {
      console.error = consoleError;
    }
  });

  it('logs the failure as one line: git text cannot forge a log entry', async () => {
    const logged: string[] = [];
    const consoleError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
    try {
      const { base } = listen(true, async () => {
        throw new Error('git push failed: remote: boom\n[setup] everything is fine[31m');
      }, connectedCheck().check);
      await post(base, '/api/setup/settings', { settings: completing });
      const line = logged.find((l) => l.includes('KB initialization failed'));
      expect(line).toBeDefined();
      expect(line).not.toContain('\n');
      expect(line).not.toContain('');
    } finally {
      console.error = consoleError;
    }
  });

  it('classifies the text as thrown, not the scrubbed copy', async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      const { base } = listen(true, async () => {
        delete process.env.GITHUB_TOKEN;
        // A token that spells part of git's own wording: scrubbing it first
        // would turn "not found" into "not ***" and read as unknown.
        throw new Error("git ls-remote failed: remote: Repository not found.\nfatal: repository 'x' not found");
      }, connectedCheck().check);
      const res = await post(base, '/api/setup/settings', { settings: { ...completing, gitToken: 'found' } });
      expect((await res.json()).kbInit.kind).toBe('not-found');
    } finally {
      console.error = consoleError;
    }
  });

  it("answers with the classification the runner's failure carries, not a re-read of its scrubbed message", async () => {
    const { ClassifiedFailure, classifyGitFailure } = await import('../../../shared/git-failure.js');
    const consoleError = console.error;
    console.error = () => {};
    try {
      const carried = classifyGitFailure('git push failed: remote: Permission to acme/kb.git denied to bot.');
      const { base } = listen(true, async () => {
        throw new ClassifiedFailure('git push failed: *** *** ***', carried);
      }, connectedCheck().check);
      const res = await post(base, '/api/setup/settings', { settings: completing });
      expect((await res.json()).kbInit).toEqual(carried);
    } finally {
      console.error = consoleError;
    }
  });

  it('tells a non-admin nothing about a standing failure', async () => {
    const consoleError = console.error;
    console.error = () => {};
    try {
      let admin = true;
      const { base } = listen(
        () => admin,
        async () => {
          throw new Error('KB startup step "roles-yaml" failed: boom');
        },
      );
      await post(base, '/api/setup/settings', { settings: completing });
      admin = false;
      const status = await (await fetch(`${base}/api/setup/status`)).json();
      expect(status).toEqual({ complete: false, isAdmin: false });
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
    }, connectedCheck().check);
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

  it('applies them before the phase runs, and asks for no restart over them', async () => {
    const seenByPhase: KbLayout[] = [];
    const kb = testKbContext();
    const { base } = listen(true, async () => {
      seenByPhase.push(kb.layout);
    }, connectedCheck().check, undefined, kb);
    const res = await post(base, '/api/setup/settings', {
      settings: { ...completing, knowledgeBaseDir: 'Docs', skillsDir: 'skills' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.complete).toBe(true);
    expect(body.restartRequired).toBe(false);
    const applied = { knowledgeBaseDir: 'Docs', skillsDir: 'skills', pluginsDir: 'Plugins', agentsFile: 'AGENTS.md' };
    expect(seenByPhase).toEqual([applied]);
    expect(kb.layout).toEqual(applied);
  });

  it('applies names stored by an earlier, incomplete save', async () => {
    const seenByPhase: KbLayout[] = [];
    const kb = testKbContext();
    const { base } = listen(true, async () => {
      seenByPhase.push(kb.layout);
    }, connectedCheck().check, undefined, kb);
    await post(base, '/api/setup/settings', { settings: { pluginsDir: 'plugins' } });
    expect(kb.layout.pluginsDir).toBe('Plugins');
    await post(base, '/api/setup/settings', { settings: completing });
    expect(seenByPhase[0]?.pluginsDir).toBe('plugins');
  });

  it('leaves them restart-to-apply once setup is complete', async () => {
    const { base, kb } = listen(true, undefined, connectedCheck().check);
    await post(base, '/api/setup/settings', { settings: completing });
    const res = await post(base, '/api/setup/settings', { settings: { pluginsDir: 'plugins' } });
    expect(res.status).toBe(200);
    expect((await res.json()).restartRequired).toBe(true);
    expect(kb.layout.pluginsDir).toBe('Plugins');
  });

  it('does not replace a layout the process already runs', async () => {
    const kb = testKbContext({ layout: { knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' } });
    const seenByPhase: KbLayout[] = [];
    const { base } = listen(true, async () => {
      seenByPhase.push(kb.layout);
    }, connectedCheck().check, undefined, kb);
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
      const kb = testKbContext();
      const { base } = listen(true, async () => {
        seenByPhase.push(kb.layout);
        if (fail) throw new Error('remote said no');
      }, connectedCheck().check, undefined, kb);
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
      expect(kb.layout.skillsDir).toBe('capabilities');
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
    }
  }

  it('asks for no restart over a branch model the completing save also applied', () =>
    withoutBranchEnv(async () => {
      // A fresh deployment: no branch model yet, so the save applies the one it carries.
      const fresh = testKbContext({ branchModel: null });
      const { base, kb } = listen(true, undefined, connectedCheck().check, undefined, fresh);
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
      expect(kb.defaultBranch).toBe('production');
    }));

  it('still asks for a restart over a branch change once a branch model is in effect', () =>
    withoutBranchEnv(async () => {
      const { base } = listen(true, undefined, connectedCheck().check);
      const res = await post(base, '/api/setup/settings', {
        settings: { ...completing, defaultBranch: 'production', protectedBranches: 'production,staging' },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).restartRequired).toBe(true);
    }));
});

/**
 * A saved connection is one the host has accepted for reading AND writing. The
 * save runs the same check as Test connection, on the values it would put in
 * effect, and a failure stores nothing and says which field to fix.
 */
describe('POST /setup/settings — the connection is checked before it is stored', () => {
  const REPO = 'https://example.com/acme/kb.git';
  const refusing = (result: ConnectionCheck) => {
    const asked: RepositoryConnection[] = [];
    return {
      asked,
      check: async (connection: RepositoryConnection) => {
        asked.push(connection);
        return result;
      },
    };
  };

  it('refuses a save whose token cannot read the repository, and stores nothing', async () => {
    const remote = refusing({
      outcome: 'rejected',
      reason: 'credentials',
      field: 'gitToken',
      error: 'The host rejected those credentials.',
    });
    const { base, settings } = listen(true, undefined, remote.check);
    const res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: REPO, gitToken: 'ghp_wrong' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).problems).toEqual({ gitToken: 'The host rejected those credentials.' });
    // Checked on exactly the values the save would have put in effect.
    expect(remote.asked).toEqual([{ url: REPO, token: 'ghp_wrong', username: 'x-access-token' }]);
    expect(settings.resolve('kbRepoUrl')).toBe('');
    expect(settings.resolve('gitToken')).toBe('');
  });

  it('refuses a token that can read but not write, naming the permission', async () => {
    const remote = refusing({
      outcome: 'read-only',
      field: 'gitToken',
      error:
        'This token can read the repository but cannot write to it. Grant it write access: on GitHub, “Contents: Read and write”.',
      branches: ['main'],
      defaultBranch: 'main',
      empty: false,
    });
    const { base, settings } = listen(true, undefined, remote.check);
    const res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: REPO, gitToken: 'ghp_readonly' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).problems.gitToken).toMatch(/Contents: Read and write/);
    expect(settings.resolve('gitToken')).toBe('');
  });

  it('refuses when the host cannot be reached, against the address', async () => {
    const remote = refusing({
      outcome: 'rejected',
      reason: 'unreachable',
      field: 'kbRepoUrl',
      error: 'Could not reach that host from this server. Check the URL and any network egress rules, then try again.',
    });
    const { base, settings } = listen(true, undefined, remote.check);
    const res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: REPO, gitToken: 'ghp_x' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).problems.kbRepoUrl).toMatch(/could not reach that host/i);
    expect(settings.resolve('kbRepoUrl')).toBe('');
  });

  it('refuses a new address without a token, and never sends the saved token there', async () => {
    const remote = connectedCheck();
    const { base, settings } = listen(true, undefined, remote.check);
    await settings.save({ kbRepoUrl: REPO, gitToken: 'ghp_verysecret' }, null);
    const res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: 'https://attacker.example/collector.git' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).problems.gitToken).toMatch(/access token for that repository/i);
    expect(remote.asked).toEqual([]);
    expect(settings.resolve('kbRepoUrl')).toBe(REPO);
  });

  it('checks a new address with the token that arrives beside it, then stores both', async () => {
    const remote = connectedCheck();
    const { base, settings } = listen(true, undefined, remote.check);
    await settings.save({ kbRepoUrl: REPO, gitToken: 'ghp_old' }, null);
    const moved = 'https://example.com/acme/moved.git';
    const res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: moved, gitToken: 'ghp_new' },
    });
    expect(res.status).toBe(200);
    expect(remote.asked).toEqual([{ url: moved, token: 'ghp_new', username: 'x-access-token' }]);
    expect(settings.resolve('kbRepoUrl')).toBe(moved);
  });

  it('checks a changed username against the stored address and token', async () => {
    const remote = connectedCheck();
    const { base, settings } = listen(true, undefined, remote.check);
    await settings.save({ kbRepoUrl: REPO, gitToken: 'ghp_x' }, null);
    const res = await post(base, '/api/setup/settings', { settings: { gitUsername: 'oauth2' } });
    expect(res.status).toBe(200);
    expect(remote.asked).toEqual([{ url: REPO, token: 'ghp_x', username: 'oauth2' }]);
  });

  it('never probes a save that touches nothing about the connection', async () => {
    const remote = connectedCheck();
    const { base, settings } = listen(true, undefined, remote.check);
    await settings.save({ kbRepoUrl: REPO, gitToken: 'ghp_x' }, null);
    const res = await post(base, '/api/setup/settings', {
      settings: {
        oidcClientId: 'hexis-app',
        oidcProviderLabel: 'Company SSO',
        // Re-sending the stored values unchanged is not a change either.
        kbRepoUrl: REPO,
        gitUsername: 'x-access-token',
      },
    });
    expect(res.status).toBe(200);
    expect(remote.asked).toEqual([]);
  });

  it('refuses a malformed field on its own terms, before asking the remote anything', async () => {
    const remote = connectedCheck();
    const { base } = listen(true, undefined, remote.check);
    const res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: 'git@example.com:acme/kb.git', gitToken: 'ghp_x' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).problems.kbRepoUrl).toMatch(/full URL|https/);
    expect(remote.asked).toEqual([]);
  });

  it('refuses an address carrying credentials, before asking the remote anything', async () => {
    const remote = connectedCheck();
    const { base, settings } = listen(true, undefined, remote.check);
    const res = await post(base, '/api/setup/settings', {
      settings: { kbRepoUrl: 'https://user:ghp_embedded@example.com/acme/kb.git', gitToken: 'ghp_x' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).problems.kbRepoUrl).toMatch(/Remove the username and token from the URL/);
    expect(remote.asked).toEqual([]);
    expect(settings.resolve('kbRepoUrl')).toBe('');
  });

  /**
   * An address already in effect with credentials in it — set before the rule
   * tightened — is not re-validated by a save that leaves it alone. The REAL
   * check must still answer that save with a fielded 400, not a 500.
   */
  it('refuses a token-only save against an address already carrying credentials, as a 400 on the address', async () => {
    process.env.KB_REPO_URL = 'https://u:ghp_embedded@127.0.0.1:1/acme/kb.git';
    const { base, settings } = listen();
    const res = await post(base, '/api/setup/settings', { settings: { gitToken: 'ghp_new' } });
    expect(res.status).toBe(400);
    expect((await res.json()).problems).toEqual({
      kbRepoUrl: 'Remove the username and token from the URL — enter the token in its own field.',
    });
    expect(settings.resolve('gitToken')).toBe('');
  });
});

/**
 * Test connection reports the repository's top-level folders beside the
 * branches: listed from the branch the remote calls its trunk, `[]` for an
 * empty repository without a lookup, and `null` when the listing could not be
 * read — which never turns a proven connection into a failure.
 */
describe('POST /setup/test-connection — the root folders it reports', () => {
  const REPO = 'https://example.com/acme/kb.git';
  const answering = (check: ConnectionCheck, folders: string[] | null) => {
    const listed: RootFolderListing[] = [];
    return {
      listed,
      check: async () => check,
      list: async (listing: RootFolderListing) => {
        listed.push(listing);
        return folders;
      },
    };
  };

  it('lists the folders of the branch the remote calls its trunk', async () => {
    const remote = answering(
      { outcome: 'connected', branches: ['main', 'production'], defaultBranch: 'production', empty: false },
      ['Docs', 'skills'],
    );
    const { base } = listen(true, undefined, remote.check, remote.list);
    const res = await post(base, '/api/setup/test-connection', { kbRepoUrl: REPO, gitToken: 'ghp_x' });
    expect(await res.json()).toEqual({
      ok: true,
      outcome: 'connected',
      empty: false,
      branches: ['main', 'production'],
      defaultBranch: 'production',
      rootFolders: ['Docs', 'skills'],
    });
    expect(remote.listed).toEqual([
      { url: REPO, branch: 'production', username: 'x-access-token', token: 'ghp_x' },
    ]);
  });

  it('answers an empty list for an empty repository, without looking', async () => {
    const remote = answering({ outcome: 'connected', branches: [], defaultBranch: null, empty: true }, ['x']);
    const { base } = listen(true, undefined, remote.check, remote.list);
    const res = await post(base, '/api/setup/test-connection', { kbRepoUrl: REPO, gitToken: 'ghp_x' });
    expect((await res.json()).rootFolders).toEqual([]);
    expect(remote.listed).toEqual([]);
  });

  it('still lists for a token that reads but cannot write', async () => {
    const remote = answering(
      { outcome: 'read-only', field: 'gitToken', error: 'Grant it write access.', branches: ['main'], defaultBranch: 'main', empty: false },
      ['skills'],
    );
    const { base } = listen(true, undefined, remote.check, remote.list);
    const body = await (await post(base, '/api/setup/test-connection', { kbRepoUrl: REPO, gitToken: 'ghp_x' })).json();
    expect(body.ok).toBe(false);
    expect(body.outcome).toBe('read-only');
    expect(body.rootFolders).toEqual(['skills']);
  });

  it('reports null when the listing fails, and the connection still stands', async () => {
    const remote = answering({ outcome: 'connected', branches: ['main'], defaultBranch: 'main', empty: false }, null);
    const { base } = listen(true, undefined, remote.check, remote.list);
    const body = await (await post(base, '/api/setup/test-connection', { kbRepoUrl: REPO, gitToken: 'ghp_x' })).json();
    expect(body.ok).toBe(true);
    expect(body.rootFolders).toBeNull();
  });

  it('lists nothing for a rejected connection', async () => {
    const remote = answering(
      { outcome: 'rejected', reason: 'credentials', field: 'gitToken', error: 'The host rejected those credentials.' },
      ['x'],
    );
    const { base } = listen(true, undefined, remote.check, remote.list);
    const body = await (await post(base, '/api/setup/test-connection', { kbRepoUrl: REPO, gitToken: 'ghp_x' })).json();
    expect(body.ok).toBe(false);
    expect(body).not.toHaveProperty('rootFolders');
    expect(remote.listed).toEqual([]);
  });
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
