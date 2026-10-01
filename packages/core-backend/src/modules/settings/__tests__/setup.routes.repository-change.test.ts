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
/** Set by the one test about a close the database will not do. Reset per test. */
let failTheClose = false;

beforeEach(() => {
  failTheClose = false;
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
  /** Set by the one test about a move whose startup phase fails. */
  const phase = { fail: false };
  /** What happened, in order: the commit worker held and let go, and the phase between. */
  const events: string[] = [];
  const changeRequests: RepositoryChangeRequests = {
    async countOpen() {
      return openChangeRequests;
    },
    async closeAsRepositoryReplaced() {
      closes.count += 1;
      if (failTheClose) throw new Error('change_requests is down');
      return openChangeRequests;
    },
    async whileCommitsHeld(work) {
      // What was stored at the moment the hold began: the hold must come first.
      events.push(`commits held on ${settings.resolve('kbRepoUrl')}`);
      try {
        return await work();
      } finally {
        events.push('commits released');
      }
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
          events.push('phase');
          if (phase.fail) throw new Error('git fetch failed: repository not found');
        },
      },
      testKbContext(),
      undefined,
      connected,
      undefined,
      undefined,
      undefined,
      undefined,
      // No alternative way of being given a repository: this suite is about the
      // one that has always been there, an address and a token.
      undefined,
      changeRequests,
    ),
  );
  server = app.listen(0);
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, settings, phaseRuns, closes, events, phase };
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

  /**
   * A close that cannot be done is a PRECONDITION that failed, not a detail of
   * an otherwise successful save. Stored anyway, the address would now match,
   * so the next save would see no change, ask nothing, and never retry the
   * close — leaving those requests open on branches the new repository does not
   * have, their file locks refusing paths to everyone, with nothing the admin
   * could press to fix it.
   */
  it('refuses the whole save, saying why, when the requests cannot be closed', async () => {
    const { base, settings, phaseRuns } = await configured(3);
    failTheClose = true;

    const res = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/replacement.git', gitToken: 'ghp_new' },
      confirmRepositoryChange: 'close',
    });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/could not be closed/);
    // Nothing stored, no working copy touched: the admin can press Save again.
    expect(settings.resolve('kbRepoUrl')).toBe(REPO);
    expect(phaseRuns.count).toBe(0);
  });
});

/**
 * An answer stands for the count it was given about. The screen sends "keep"
 * when there was nothing to choose; a request opened while the question
 * stood must not be decided by that.
 */
describe('an answer given about a count that has since changed', () => {
  it('is asked again, with the count as it is now', async () => {
    const { base, settings, phaseRuns } = await configured(1);
    const res = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/replacement.git', gitToken: 'ghp_new' },
      confirmRepositoryChange: 'keep',
      seenOpenChangeRequests: 0,
    });
    expect(res.status).toBe(409);
    expect((await res.json()).repositoryChange.openChangeRequests).toBe(1);
    expect(settings.resolve('kbRepoUrl')).toBe(REPO);
    expect(phaseRuns.count).toBe(0);
  });

  it('goes through when the count is the one the answer was given about', async () => {
    const { base } = await configured(1);
    const res = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/replacement.git', gitToken: 'ghp_new' },
      confirmRepositoryChange: 'keep',
      seenOpenChangeRequests: 1,
    });
    expect(res.status).toBe(200);
  });
});

/**
 * A move that fails part-way leaves the deployment gated with the failure
 * standing. It has served all the same, and its open change requests are the
 * proof: the save that tries again must still ask what becomes of them.
 */
describe('a move tried again after one that failed part-way', () => {
  it('still asks, because change requests are open', async () => {
    const { base, phase } = await configured(2);
    phase.fail = true;
    const failed = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/replacement.git', gitToken: 'ghp_new' },
      confirmRepositoryChange: 'keep',
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toHaveProperty('kbInit');

    phase.fail = false;
    const again = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/third.git', gitToken: 'ghp_new' },
    });
    expect(again.status).toBe(409);
    expect((await again.json()).repositoryChange.openChangeRequests).toBe(2);
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

/**
 * The move runs while the deployment is serving. A commit worker left
 * running would write into a working copy that is being renamed away, or
 * into the fresh clone of a repository the commit was never meant for.
 */
describe('the commit worker, while a deployment is moved', () => {
  /**
   * Held BEFORE the new address is stored, not only around the phase. The
   * way chosen takes effect with the store, and a worker still running in
   * between would push a queued commit from a copy of the repository being
   * left with the credential of the one moved to.
   */
  it('is held from before the address is stored until the startup phase has run', async () => {
    const { base, events } = await configured(0);
    events.length = 0;
    const res = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/another.git', gitToken: 'ghp_new' },
      confirmRepositoryChange: 'keep',
    });
    expect(res.status).toBe(200);
    expect(events).toEqual([`commits held on ${REPO}`, 'phase', 'commits released']);
  });

  it('is let go when the confirmed move is refused after all', async () => {
    const { base, events } = await configured(2);
    events.length = 0;
    failTheClose = true;
    const res = await post(base, {
      settings: { kbRepoUrl: 'https://example.com/acme/another.git', gitToken: 'ghp_new' },
      confirmRepositoryChange: 'close',
    });
    expect(res.status).toBe(500);
    expect(events).toEqual([`commits held on ${REPO}`, 'commits released']);
  });

  it('is not touched by a save that moves nothing', async () => {
    const { base, events } = await configured(0);
    events.length = 0;
    const res = await post(base, { settings: { kbSyncSecret: 'a-secret-of-sixteen-or-more' } });
    expect(res.status).toBe(200);
    expect(events).toEqual([]);
  });

  it('is not held by a move that was only asked about', async () => {
    const { base, events } = await configured(0);
    events.length = 0;
    const res = await post(base, { settings: { kbRepoUrl: 'https://example.com/acme/another.git', gitToken: 'ghp_new' } });
    expect(res.status).toBe(409);
    expect(events).toEqual([]);
  });
});
