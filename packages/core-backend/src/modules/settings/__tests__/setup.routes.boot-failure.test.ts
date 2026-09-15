import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSetupRoutes } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import { NodeGitRunner } from '../../workflow/git/node-git-runner.js';

/**
 * A boot that survived an unreachable remote leaves the RUNNER standing on a
 * failure. The setup routes must treat that exactly like a failed setup-time
 * run: the app stays gated, the admin sees why, and a save retries.
 */

const ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';
const KB_ENV = ['KB_REPO_URL', 'GIT_TOKEN', 'GIT_USERNAME', 'KB_DIR_NAME', 'GITHUB_TOKEN'] as const;

let server: HttpServer | null = null;
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

/** A runner whose standing failure the test controls. */
function runnerDouble() {
  const state = { failure: 'The knowledge-base remote could not be reached: fatal: unable to access' as string | null, runs: 0 };
  return {
    state,
    runner: {
      async runAll() {
        state.runs += 1;
        state.failure = null;
      },
      lastFailure: () => state.failure,
    },
  };
}

function listen(runner: { runAll(): Promise<void>; lastFailure(): string | null }) {
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
    createSetupRoutes(settings, { isAdmin: async () => true } as IAdminAccessService, runner, new NodeGitRunner()),
  );
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, settings };
}

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('setup routes after a boot that survived an unreachable remote', () => {
  it('keeps the deployment gated and tells the admin why', async () => {
    const { runner } = runnerDouble();
    const { base, settings } = listen(runner);
    // Settings are complete — this deployment was configured long ago; only the remote is gone.
    await settings.save({ kbRepoUrl: 'https://example.com/acme/kb.git', gitToken: 'ghp_x' }, null);

    const status = await (await fetch(`${base}/api/setup/status`)).json();
    expect(status.complete).toBe(false);
    expect(status.kbInitError).toMatch(/could not be reached/);
  });

  it('a save retries the phase, and the gate opens once the runner no longer stands on a failure', async () => {
    const { runner, state } = runnerDouble();
    const { base, settings } = listen(runner);
    await settings.save({ kbRepoUrl: 'https://example.com/acme/kb.git', gitToken: 'ghp_x' }, null);

    const res = await post(base, '/api/setup/settings', { settings: { gitUsername: 'x-access-token' } });
    expect(res.status).toBe(200);
    expect(state.runs).toBe(1);
    expect((await res.json()).complete).toBe(true);

    const status = await (await fetch(`${base}/api/setup/status`)).json();
    expect(status.complete).toBe(true);
    expect(status.kbInitError).toBeUndefined();
  });

  it('the runner clearing its own failure — the background retry succeeding — opens the gate without a save', async () => {
    const { runner, state } = runnerDouble();
    const { base, settings } = listen(runner);
    await settings.save({ kbRepoUrl: 'https://example.com/acme/kb.git', gitToken: 'ghp_x' }, null);

    expect((await (await fetch(`${base}/api/setup/status`)).json()).complete).toBe(false);
    state.failure = null;
    expect((await (await fetch(`${base}/api/setup/status`)).json()).complete).toBe(true);
  });
});
