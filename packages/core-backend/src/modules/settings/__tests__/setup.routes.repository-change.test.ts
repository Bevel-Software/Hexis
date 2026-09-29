import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { createSetupRoutes, type RepositoryChangeRequests } from '../setup.routes.js';
import { DeploymentSettingsService } from '../deployment-settings.service.js';
import type { Database } from '../../database/connection.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { ConnectionCheck, RepositoryConnection } from '../connection-check.js';

/**
 * Saving a DIFFERENT knowledge-base repository.
 *
 * Every working copy on this server fetches through the address stored in its
 * own clone, so pointing the deployment somewhere else means deleting and
 * re-cloning all of them — and losing anything committed here and never
 * pushed. On 2026-09-28 that happened with no warning, no re-clone, and a
 * boot that then crash-looped against the repository that was gone.
 *
 * So: the save is REFUSED until the admin confirms, the confirmation says how
 * many change requests are open and what to do with them, and a confirmed
 * save runs the KB startup phase — which is what replaces the working copies
 * — even though the deployment was complete and healthy.
 */

const ENC_KEY = 'kToAi8FXWDpDn3A6yQ/60O39bv05N7XzVOIu/0CJrFc=';
const KB_ENV = ['KB_REPO_URL', 'GIT_TOKEN', 'GIT_USERNAME', 'KB_DIR_NAME', 'GITHUB_TOKEN'] as const;
const REPO = 'https://example.com/acme/kb.git';

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

/** The remote answers for whatever it is asked about. */
const connected = async (connection: RepositoryConnection): Promise<ConnectionCheck> => {
  void connection;
  return { outcome: 'connected', branches: ['main'], defaultBranch: 'main', empty: false };
};

function listen(openChangeRequests: number) {
  const db = {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
  } as unknown as Database;
  const settings = new DeploymentSettingsService(db, ENC_KEY);
  /** Every run of the KB startup phase — the thing that replaces the clones. */
  const phaseRuns = { count: 0 };
  const closes = { count: 0 };
  const changeRequests: RepositoryChangeRequests = {
    async countOpen() {
      return openChangeRequests;
    },
    async closeAsRepositoryReplaced() {
      closes.count += 1;
      return openChangeRequests;
    },
  };
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
      { isAdmin: async () => true } as IAdminAccessService,
      {
        async runAll() {
          phaseRuns.count += 1;
        },
      },
      testKbContext(),
      undefined,
      connected,
      undefined,
      undefined,
      undefined,
      undefined,
      changeRequests,
    ),
  );
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, settings, phaseRuns, closes };
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/setup/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** A deployment that has been running against REPO for a while. */
async function configured(openChangeRequests = 0) {
  const harness = listen(openChangeRequests);
  await harness.settings.save({ kbRepoUrl: REPO, gitToken: 'ghp_old' }, null);
  // The save above is not what this suite counts.
  harness.phaseRuns.count = 0;
  return harness;
}

describe('a save that changes the knowledge-base repository', () => {
  it('is refused until the admin confirms, and stores nothing meanwhile', async () => {
    const { base, settings, phaseRuns } = await configured(0);

    const res = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/replacement.git', gitToken: 'ghp_new' },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ repositoryChange: { openChangeRequests: 0 } });
    // Nothing saved, nothing replaced: a refused save destroys nothing.
    expect(settings.resolve('kbRepoUrl')).toBe(REPO);
    expect(phaseRuns.count).toBe(0);
  });

  it('says how many change requests are open, so the choice is about a number', async () => {
    const { base } = await configured(3);
    const res = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/replacement.git', gitToken: 'ghp_new' },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).repositoryChange.openChangeRequests).toBe(3);
  });

  it('confirmed with "keep": saves, replaces the working copies, and closes nothing', async () => {
    const { base, settings, phaseRuns, closes } = await configured(3);
    const replacement = 'https://example.com/acme/replacement.git';

    const res = await post(base, {
      settings: { kbRepoUrl: replacement, gitToken: 'ghp_new' },
      confirmRepositoryChange: 'keep',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      repositoryChange: { choice: 'keep', closedChangeRequests: 0 },
    });
    expect(settings.resolve('kbRepoUrl')).toBe(replacement);
    // The phase is what deletes the clones of the old repository and makes new
    // ones — on the SAVE, not only at the next boot.
    expect(phaseRuns.count).toBe(1);
    expect(closes.count).toBe(0);
  });

  it('confirmed with "close": closes the open requests as repository replaced', async () => {
    const { base, phaseRuns, closes } = await configured(3);

    const res = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/replacement.git', gitToken: 'ghp_new' },
      confirmRepositoryChange: 'close',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      repositoryChange: { choice: 'close', closedChangeRequests: 3 },
    });
    expect(closes.count).toBe(1);
    expect(phaseRuns.count).toBe(1);
  });
});

describe('a save that does NOT change the repository', () => {
  it('goes straight through, and runs no startup phase', async () => {
    const { base, phaseRuns, closes } = await configured(2);

    // The same address, with something else edited beside it.
    const res = await post(base, { settings: { kbRepoUrl: REPO, gitUsername: 'oauth2' } });

    expect(res.status).toBe(200);
    expect(await res.json()).not.toHaveProperty('repositoryChange');
    // A complete, healthy deployment's clones are of the configured
    // repository: re-cloning them would be maintenance over live work.
    expect(phaseRuns.count).toBe(0);
    expect(closes.count).toBe(0);
  });

  it('treats a trailing slash, a .git suffix and the host’s letter case as the same address', async () => {
    for (const spelling of [
      'https://example.com/acme/kb',
      'https://example.com/acme/kb/',
      'https://EXAMPLE.com/acme/kb.git',
      'https://example.com/acme/kb.git/',
    ]) {
      const { base, settings, phaseRuns } = await configured(2);
      const res = await post(base, { settings: { kbRepoUrl: spelling } });
      expect({ spelling, status: res.status }).toEqual({ spelling, status: 200 });
      // Stored as typed — it is the same repository, not a correction.
      expect(settings.resolve('kbRepoUrl')).toBe(spelling);
      expect({ spelling, runs: phaseRuns.count }).toEqual({ spelling, runs: 0 });
      server?.close();
      server = null;
    }
  });

  it('never asks the token question over a spelling, since it is the same repository', async () => {
    const { base } = await configured(0);
    // No token supplied. A DIFFERENT repository would be refused here — the
    // stored token only ever goes to the repository it was saved for.
    const res = await post(base, { settings: { kbRepoUrl: 'https://example.com/acme/kb/' } });
    expect(res.status).toBe(200);
  });
});

describe('first-run setup', () => {
  it('asks nothing: there is no configured address and no working copy to lose', async () => {
    const { base, settings, phaseRuns } = listen(0);
    const res = await post(base, { settings: { kbRepoUrl: REPO, gitToken: 'ghp_new' } });
    expect(res.status).toBe(200);
    expect(settings.resolve('kbRepoUrl')).toBe(REPO);
    // The completion transition runs the phase, as it always has.
    expect(phaseRuns.count).toBe(1);
  });
});
