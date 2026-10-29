import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IVersionControlService } from '@bevel-software/platform-shared';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { VersionControlEventBus } from '../event-bus.js';
import { createVersionControlRoutes } from '../version-control.routes.js';
import {
  VersionNotOnBranchError,
  VERSION_NOT_ON_BRANCH_MESSAGE,
} from '../../../shared/domain-errors.js';

// A file's history is its content with a time axis: the same default-deny
// read model that hides a file must hide its commit list, its diffs, and its
// content at any commit. These routes used to require only "is authenticated".

const USER = { id: 'u1', email: 'alice@example.com', name: 'Alice' };
const WS = 'main';
const KB = 'knowledge-base';
const allow = (p: string) => !p.includes('Secret');

interface Harness {
  server: Server;
  canRead: ReturnType<typeof vi.fn>;
  canReadAtRef: ReturnType<typeof vi.fn>;
  versionControl: {
    listChangesForFile: ReturnType<typeof vi.fn>;
    compareFile: ReturnType<typeof vi.fn>;
    showFileAtChange: ReturnType<typeof vi.fn>;
    fileAtChange: ReturnType<typeof vi.fn>;
  };
  baseUrl: string;
}

async function makeHarness(): Promise<Harness> {
  const canRead = vi.fn(async (_w: string, _e: string, p: string) => allow(p));
  const canReadAtRef = vi.fn(async (_w: string, _r: string, _e: string, p: string) => allow(p));
  const accessControl = { canRead, canReadAtRef } as unknown as IAccessControl;
  const versionControl = {
    listChangesForFile: vi.fn(async () => []),
    compareFile: vi.fn(async (_w: string, _p: string, from: string, to: string, authorize?: (s: { from: string[]; to: string[] }) => Promise<void>) => {
      // Each branch resolves to its served commit and, for `b`, a second one (a
      // local head past the published tip): the verdict is asked at both.
      await authorize?.({ from: [`sha-of-${from}`], to: [`sha-of-${to}`, `other-sha-of-${to}`] });
      return { diff: '', from: `sha-of-${from}`, to: `sha-of-${to}` };
    }),
    showFileAtChange: vi.fn(async () => ''),
    fileAtChange: vi.fn(async () => ({ baseline: null, current: 'x' })),
  };
  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use(
    '/api',
    createVersionControlRoutes(
      versionControl as unknown as IVersionControlService,
      {} as unknown as WorkspaceService,
      authService,
      { subscribe: vi.fn(), publish: vi.fn() } as unknown as VersionControlEventBus,
      accessControl,
      KB,
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return { server, canRead, canReadAtRef, versionControl, baseUrl: `http://127.0.0.1:${addr.port}` };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

const OPEN = encodeURIComponent(`${KB}/Open/a.md`);
const SECRET = encodeURIComponent(`${KB}/Secret/x.md`);

describe('history routes enforce the read model', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });
  const get = (p: string) => fetch(`${h!.baseUrl}/api/workspace/${WS}/workflow${p}`);

  it.each([
    ['/changes?path=%s', 'listChangesForFile'],
    ['/show-file?sha=abc&path=%s', 'showFileAtChange'],
    ['/file-at-change?sha=abc&path=%s', 'fileAtChange'],
    ['/compare-file?from=a&to=b&path=%s', 'compareFile'],
  ] as const)('%s: readable → 200, denied → 403 and git is never consulted', async (route, method) => {
    h = await makeHarness();
    expect((await get(route.replace('%s', OPEN))).status).toBe(200);
    expect((await get(route.replace('%s', SECRET))).status).toBe(403);
    // The denial happened BEFORE the service — nothing read the repository.
    const calls = h.versionControl[method].mock.calls as unknown[][];
    expect(calls.length).toBe(1);
    expect(String(calls[0][1])).toContain('Open');
  });

  it('a path without the repo prefix is refused outright — the git layer would read it as repo-relative', async () => {
    // `stripRepoPrefix` makes `Secret/x.md` and `knowledge-base/Secret/x.md`
    // name the same object, so an ungated "non-KB" branch would be a gate
    // bypass by spelling. History is for tracked files only; no prefix, 400.
    h = await makeHarness();
    for (const p of ['Secret/x.md', 'scratch/notes.txt']) {
      const res = await get(`/changes?path=${encodeURIComponent(p)}`);
      expect(res.status).toBe(400);
    }
    expect(h.versionControl.listChangesForFile).not.toHaveBeenCalled();
  });

  it('compare-file authorizes at the two commits the diff was served from, never at a ref', async () => {
    // The diff is made first, pinned to the commit each side was read at,
    // and authorized at those before any of it is answered: a branch ref a
    // fetch moves meanwhile cannot have swapped in content the verdict never
    // saw.
    h = await makeHarness();
    const res = await get(`/compare-file?from=a&to=b&path=${OPEN}`);
    expect(res.status).toBe(200);
    const refs = h.canReadAtRef.mock.calls.map((c) => c[1]).sort();
    expect(refs).toEqual(['other-sha-of-b', 'sha-of-a', 'sha-of-b']);

    // Any commit a side resolves to denying the read refuses the diff — the
    // served one or the other (a grant at the served commit never outruns a
    // denial at the branch's other tip) — disclosing none of it.
    for (const denying of ['sha-of-a', 'sha-of-b', 'other-sha-of-b']) {
      h.canReadAtRef.mockImplementation(async (_w: string, ref: string) => (ref === denying ? false : true));
      const denied = await get(`/compare-file?from=a&to=b&path=${OPEN}`);
      expect(denied.status, denying).toBe(403);
      expect(await denied.json()).not.toHaveProperty('diff');
    }

    // A commit whose rules cannot be read grants nothing: refused.
    h.canReadAtRef.mockImplementation(async (_w: string, ref: string) => (ref === 'sha-of-b' ? null : true));
    expect((await get(`/compare-file?from=a&to=b&path=${OPEN}`)).status).toBe(403);
  });

  it.each([
    ['/show-file?sha=abc1234&path=%s', 'showFileAtChange'],
    ['/file-at-change?sha=abc1234&path=%s', 'fileAtChange'],
  ] as const)(
    '%s: a save off this branch is refused with the history message',
    async (route, method) => {
      // The service raises it (the git layer knows the branch); the route has
      // to pass the typed refusal through with its own status and sentence,
      // because a reader who is told "not found" about a file that is plainly
      // there learns the wrong thing. The bytes route carries the same rule,
      // so neither can be read around through the other.
      h = await makeHarness();
      h.versionControl[method].mockRejectedValueOnce(new VersionNotOnBranchError());
      const res = await get(route.replace('%s', OPEN));
      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe(
        VERSION_NOT_ON_BRANCH_MESSAGE,
      );
    },
  );

  it('an access-model error fails closed, not open', async () => {
    h = await makeHarness();
    h.canRead.mockRejectedValueOnce(new Error('access tree unreadable'));
    const res = await get(`/changes?path=${OPEN}`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(h.versionControl.listChangesForFile).not.toHaveBeenCalled();
  });
});
