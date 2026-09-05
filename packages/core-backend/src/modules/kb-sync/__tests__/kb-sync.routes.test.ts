import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKbSyncRoutes, isSyncRawBodyPath } from '../kb-sync.routes.js';
import type { IKbSyncService, SyncResult } from '../kb-sync.interface.js';

const SECRET = 'a-very-long-and-random-sync-secret';

const SYNCED: SyncResult = {
  status: 'synced',
  results: [{ branch: 'main', outcome: 'updated', from: 'aaa', to: 'bbb' }],
  changeRequests: { closedDeletedBranch: 0 },
};

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function mount(opts: {
  secret?: string;
  result?: SyncResult;
  admin?: boolean;
  /** Install the production-shaped global JSON parser in front of the router. */
  globalJson?: boolean;
}): Promise<{ base: string; sync: ReturnType<typeof vi.fn> }> {
  // A suite may mount twice in one test; the earlier server must not outlive it.
  server?.close();
  const sync = vi.fn(async () => opts.result ?? SYNCED);
  const kbSync: IKbSyncService = { sync };
  const app = express();
  // Mirrors production: the global JSON parser skips `/api/sync`, so the
  // router's own raw parser sees the bytes. Installing `express.json()` here
  // would hide exactly the wiring bug the signature path depends on.
  if (opts.globalJson) {
    const json = express.json();
    app.use((req, res, next) => (isSyncRawBodyPath(req.path) ? next() : json(req, res, next)));
  }
  app.use(
    '/api',
    createKbSyncRoutes({
      kbSync,
      syncSecret: () => opts.secret ?? SECRET,
      authService: {
        verifyToken: (token: string) => {
          if (token !== 'jwt-ok') throw new Error('bad token');
          return { userId: 'u1', email: 'person@example.com' };
        },
      },
      adminAccess: { isAdmin: async () => opts.admin === true },
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server!.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  return { base: `http://127.0.0.1:${address.port}/api/sync`, sync };
}

function post(url: string, init: { headers?: Record<string, string>; body?: string } = {}) {
  return fetch(url, { method: 'POST', headers: init.headers ?? {}, body: init.body });
}

describe('POST /api/sync — credentials', () => {
  it('401 with no credential, and advertises the bearer challenge', async () => {
    const { base, sync } = await mount({});
    const res = await post(base);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(sync).not.toHaveBeenCalled();
  });

  it('401 with the wrong secret', async () => {
    const { base, sync } = await mount({});
    const res = await post(base, { headers: { authorization: 'Bearer wrong' } });
    expect(res.status).toBe(401);
    expect(sync).not.toHaveBeenCalled();
  });

  it('503 when no secret is configured and a hook presents one', async () => {
    const { base } = await mount({ secret: '' });
    const res = await post(base, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toContain('KB_SYNC_SECRET');
  });

  it("an admin's session works; a non-admin's does not", async () => {
    const admin = await mount({ admin: true });
    expect((await post(admin.base, { headers: { authorization: 'Bearer jwt-ok' } })).status).toBe(200);
    const person = await mount({ admin: false });
    expect((await post(person.base, { headers: { authorization: 'Bearer jwt-ok' } })).status).toBe(401);
  });

  it('accepts the GitLab token header', async () => {
    const { base } = await mount({});
    const res = await post(base, { headers: { 'x-gitlab-token': SECRET } });
    expect(res.status).toBe(200);
  });

  it('accepts a GitHub signature computed over the exact bytes received', async () => {
    const { base, sync } = await mount({});
    const body = '{"ref":"refs/heads/main","after":"b"}';
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    const res = await post(base, {
      headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ branches: ['main'] }));
  });
});

describe('POST /api/sync — body and result', () => {
  it('an empty body syncs everything', async () => {
    const { base, sync } = await mount({});
    const res = await post(base, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ branches: 'all' }));
    expect(await res.json()).toEqual(SYNCED);
  });

  it('an explicit body names the branches', async () => {
    const { base, sync } = await mount({});
    await post(base, {
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ branches: ['main', 'ali/x'] }),
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ branches: ['main', 'ali/x'] }));
  });

  it('an Azure DevOps push payload names the pushed branch', async () => {
    const { base, sync } = await mount({});
    await post(base, {
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        eventType: 'git.push',
        resource: { refUpdates: [{ name: 'refs/heads/ali/x' }] },
      }),
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ branches: ['ali/x'] }));
  });

  it('400 for a branch name git would refuse, and for a body that is not JSON', async () => {
    const { base, sync } = await mount({});
    const bad = await post(base, {
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ branches: ['--upload-pack=x'] }),
    });
    expect(bad.status).toBe(400);
    const notJson = await post(base, {
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(notJson.status).toBe(400);
    expect(sync).not.toHaveBeenCalled();
  });

  it('409 when any branch is in conflict — the message rides in the body', async () => {
    const { base } = await mount({
      result: {
        status: 'partial',
        results: [
          { branch: 'ali/x', outcome: 'updated', from: 'a', to: 'b' },
          {
            branch: 'main',
            outcome: 'conflict',
            conflictedPaths: ['Plugins/x/SKILL.md'],
            error: 'main is not in sync yet: Plugins/x/SKILL.md changed both in Hexis and on the git host. Recovery is queued; if this stays, open the files on main in Hexis, keep what you want, and save.',
          },
        ],
        changeRequests: { closedDeletedBranch: 0 },
      },
    });
    const res = await post(base, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as SyncResult;
    expect(body.results[1]).toMatchObject({ outcome: 'conflict' });
    expect((body.results[1] as { error: string }).error).toContain('Recovery is queued');
  });

  it('503 when a branch could not be pulled and none is in conflict', async () => {
    const { base } = await mount({
      result: {
        status: 'partial',
        results: [{ branch: 'main', outcome: 'error', error: 'could not read from remote' }],
        changeRequests: { closedDeletedBranch: 0 },
      },
    });
    expect((await post(base, { headers: { authorization: `Bearer ${SECRET}` } })).status).toBe(503);
  });
});

describe('POST /api/sync/<branch> — the branch in the URL', () => {
  it('syncs exactly that branch, spelled as segments or percent-encoded', async () => {
    for (const spelling of ['main', 'ali/new-skill', 'ali%2Fnew-skill']) {
      const { base, sync } = await mount({});
      const res = await post(`${base}/${spelling}`, { headers: { authorization: `Bearer ${SECRET}` } });
      expect(res.status).toBe(200);
      expect(sync).toHaveBeenCalledWith(expect.objectContaining({ branches: [decodeURIComponent(spelling)] }));
      server?.close();
    }
  });

  it('ignores the body for branch selection — a GitHub Action can post anything', async () => {
    const { base, sync } = await mount({});
    await post(`${base}/main`, {
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ branches: ['other'] }),
    });
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ branches: ['main'] }));
  });

  it('still checks the credential first', async () => {
    const { base, sync } = await mount({});
    expect((await post(`${base}/main`)).status).toBe(401);
    expect(sync).not.toHaveBeenCalled();
  });

  it('400 for a branch name git would refuse', async () => {
    const { base, sync } = await mount({});
    const res = await post(`${base}/--upload-pack=x`, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(400);
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('POST /api/sync — behind the production JSON parser', () => {
  it('the branch route still sees the raw bytes, so a GitHub signature verifies', async () => {
    const { base, sync } = await mount({ globalJson: true });
    const body = '{"ref":"refs/heads/main"}';
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    const res = await post(`${base}/main`, {
      headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ branches: ['main'] }));
  });

  it('and so does the bare route', async () => {
    const { base } = await mount({ globalJson: true });
    const body = '{"ref":"refs/heads/main"}';
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    const res = await post(base, {
      headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
  });

  it('isSyncRawBodyPath covers both shapes and nothing else', () => {
    expect(isSyncRawBodyPath('/api/sync')).toBe(true);
    expect(isSyncRawBodyPath('/api/sync/main')).toBe(true);
    expect(isSyncRawBodyPath('/api/sync/ali/new-skill')).toBe(true);
    expect(isSyncRawBodyPath('/api/synchronise')).toBe(false);
    expect(isSyncRawBodyPath('/api/setup/status')).toBe(false);
  });
});

describe('POST /api/sync — the response marker', () => {
  it('every answer carries the header a proxy never sets, including the 503 and the 401', async () => {
    const ok = await mount({});
    expect((await post(ok.base, { headers: { authorization: `Bearer ${SECRET}` } })).headers.get('x-hexis-sync')).toBe('result');
    server?.close();
    const down = await mount({
      result: {
        status: 'partial',
        results: [{ branch: 'main', outcome: 'error', error: 'could not read from remote' }],
        changeRequests: { closedDeletedBranch: 0 },
      },
    });
    const res = await post(down.base, { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(503);
    expect(res.headers.get('x-hexis-sync')).toBe('result');
    expect((await post(down.base)).headers.get('x-hexis-sync')).toBe('result');
  });
});

describe('POST /api/Sync — an odd-cased URL', () => {
  it('is matched by Express and by the raw-body carve-out alike, so it works exactly like the lower-case one', async () => {
    const { base, sync } = await mount({ globalJson: true });
    const oddCase = base.replace('/api/sync', '/api/Sync');
    const body = '{"ref":"refs/heads/main"}';
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    const res = await post(`${oddCase}/main`, {
      headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ branches: ['main'] }));
    expect(isSyncRawBodyPath('/api/Sync')).toBe(true);
    expect(isSyncRawBodyPath('/API/SYNC/main')).toBe(true);
  });
});
