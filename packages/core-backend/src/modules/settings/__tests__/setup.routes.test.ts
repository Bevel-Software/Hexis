import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const KB_ENV = ['KB_REPO_URL', 'GIT_TOKEN', 'GIT_USERNAME', 'KB_DIR_NAME'] as const;
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
function listen(isAdmin = true) {
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
      // The startup phase is not under test here — these suites never
      // complete setup, so the runner is never reached.
      { runAll: async () => {} },
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
