import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IVersionControlService } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { newWorkspaceService } from '../../../__tests__/workspace-service.js';
import { createGitInternalsRouteGuard } from '../../../__tests__/tool-wiring.js';
import { gitFolderFileSpellings } from '../../../__tests__/git-folder-spellings.js';
import { GIT_INTERNALS_MESSAGE, GitInternalsError } from '../../../shared/domain-errors.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { WorkspaceMutex } from '../../kb-fs/index.js';
import type { IAccessControl } from '../../access/index.js';
import type { AuthService } from '../../auth/index.js';
import { createDiffRoutes } from '../diff.routes.js';
import { DiffService } from '../diff.service.js';

/**
 * Security regression, the diff module's share of it: the repository's
 * internal git folder is unreachable through the review routes and through
 * `DiffService` itself, in every spelling — plain, dotted, percent-encoded,
 * upper-case — and through a symbolic link in the repository that points into
 * it. Each refusal is the same 403 with the same message, whether or not
 * anything is at the path, and leaves the git folder exactly as it was. The
 * workspace tools and routes are held to the same rule, with the same
 * spellings, in `workspace/__tests__/git-internals.security.test.ts`.
 *
 * Real disk, a real WorkspaceService and DiffService; only the lock service
 * and the access rules are stubbed (allow-all), so nothing but the git-folder
 * rule can refuse.
 */

const KB = 'knowledge-base';
const BRANCH = 'main';
const WS = workspaceIdForBranch(BRANCH);
const USER = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };

/** Every spelling of a path INSIDE the git folder (see `gitFolderFileSpellings`). */
const fileForms = (name: string): Record<string, string> => gitFolderFileSpellings(KB, name);

/**
 * The absolute forms name the workspace on disk, which only exists once the
 * temp root does — so they carry a placeholder until the test runs.
 */
const resolved = (form: string): string => form.replace('{{WORKSPACE_DIR}}', workspaceDir);

const FILE_FORMS = { ...fileForms('config'), 'symlinked file': `${KB}/cfglink` };
const MISSING_FORMS = fileForms('no-such-file');

let root = '';
let workspaceDir = '';
let gitSnapshot = '';

async function snapshotGit(): Promise<string> {
  const gitDir = join(workspaceDir, KB, '.git');
  const names = (await readdir(gitDir, { recursive: true })).sort();
  return JSON.stringify({ names, config: await readFile(join(gitDir, 'config'), 'utf8') });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'diff-git-internals-sec-'));
  workspaceDir = join(root, WS);
  const kb = join(workspaceDir, KB);
  await mkdir(join(kb, '.git', 'refs', 'heads'), { recursive: true });
  await writeFile(join(kb, '.git', 'config'), '[credential]\n\thelper = store --file=/secret\n');
  await writeFile(join(kb, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await mkdir(join(kb, 'Notes'), { recursive: true });
  await writeFile(join(kb, 'Notes', 'a.md'), '# A\nhelper\n');
  await symlink('.git', join(kb, 'gitlink'));
  await symlink('.git/config', join(kb, 'cfglink'));
  await symlink('gitlink', join(kb, 'chained'));
  await symlink(join(KB, '.git'), join(workspaceDir, '..link'));
  gitSnapshot = await snapshotGit();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const allowAll = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  canWrite: async () => true,
  canWriteBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  canWriteBatchAtRef: async (_w: string, _r: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  canDownload: async () => true,
  canDownloadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  canOwner: async () => true,
  eligibleWritersAtRef: async () => [],
} as unknown as IAccessControl;

/**
 * The ONE refusal, for every spelling: the WHOLE body, not a search through
 * it, so no field beside the sanitized message can carry a spelling of the
 * caller's path. The routes add the error's `kind`, so the shape the answer
 * claims is the one it is held to, exactly.
 */
async function expectRefused(res: Response): Promise<void> {
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status).toBe(403);
  expect(body).toEqual(
    'kind' in body ? { kind: 'git-internals', error: GIT_INTERNALS_MESSAGE } : { error: GIT_INTERNALS_MESSAGE },
  );
}

describe('review routes refuse the git folder', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let acquireLock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    acquireLock = vi.fn(async () => ({ acquired: true, lock: { holderUserId: USER.id, holderName: USER.name } }));
    const versionControl = {
      getLock: vi.fn(async () => null),
      acquireLock,
      releaseLock: vi.fn(async () => null),
      releaseLockNoCommit: vi.fn(async () => undefined),
      releaseLockUntouched: vi.fn(async () => undefined),
      commitChanges: vi.fn(async () => null),
    };
    const service = newWorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), realDisk());
    const diffService = new DiffService(service, new WorkspaceMutex(), root, join(root, 'backups'), KB, realDisk());
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userId: string }).userId = USER.id;
      next();
    });
    // Exactly the production mounting: ONE guard for the whole prefix, ahead
    // of every router under it — so the review routes are covered by the fact
    // of their path, not by their own guard.
    app.use('/api/workspace/:id', createGitInternalsRouteGuard(service));
    app.use(
      '/api',
      createDiffRoutes(
        diffService,
        { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
        versionControl as unknown as IVersionControlService,
        allowAll,
        KB,
      ),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(acquireLock).not.toHaveBeenCalled();
    expect(await snapshotGit()).toBe(gitSnapshot);
  });

  const json = (method: string, url: string, body: unknown) =>
    fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const reviewRoutes: Array<[string, (p: string) => Promise<Response>]> = [
    ['review diff (GET /review/file)', (p) => fetch(`${baseUrl}/api/workspace/${WS}/review/file?path=${encodeURIComponent(p)}`)],
    ['review accept (POST /review/accept)', (p) => json('POST', `${baseUrl}/api/workspace/${WS}/review/accept`, { path: p })],
    ['review reject (POST /review/reject)', (p) => json('POST', `${baseUrl}/api/workspace/${WS}/review/reject`, { path: p })],
  ];

  for (const [name, send] of reviewRoutes) {
    describe(name, () => {
      it.each(Object.entries(FILE_FORMS))('%s form', async (_form, raw) => {
        await expectRefused(await send(resolved(raw)));
      });

      it('answers a missing path exactly as an existing one', async () => {
        for (const form of Object.keys(MISSING_FORMS)) {
          const existing = await send(resolved(fileForms('config')[form]));
          const missing = await send(resolved(MISSING_FORMS[form]));
          expect(missing.status).toBe(existing.status);
          expect(await missing.json()).toEqual(await existing.json());
        }
      });
    });
  }
});

describe('DiffService refuses the git folder on its own', () => {
  let diffService: DiffService;

  beforeEach(() => {
    const service = newWorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), realDisk());
    diffService = new DiffService(service, new WorkspaceMutex(), root, join(root, 'backups'), KB, realDisk());
  });

  afterEach(async () => {
    expect(await snapshotGit()).toBe(gitSnapshot);
  });

  const ops: Array<[string, (p: string) => Promise<unknown>]> = [
    ['fileDiff', (p) => diffService.fileDiff(WS, p)],
    ['acceptOne', (p) => diffService.acceptOne(WS, p)],
    ['rejectOne', (p) => diffService.rejectOne(WS, p)],
    ['syncFromDisk', (p) => diffService.syncFromDisk(WS, p)],
    ['markUserDeleted', (p) => diffService.markUserDeleted(WS, p)],
    ['revertPlan', (p) => diffService.revertPlan(WS, [p])],
  ];

  for (const [name, run] of ops) {
    it.each(Object.entries(FILE_FORMS))(`${name} — %s form`, async (_form, raw) => {
      const p = resolved(raw);
      await expect(run(p)).rejects.toBeInstanceOf(GitInternalsError);
    });
  }

  it('a refused fileDiff on a fresh workspace seeds nothing — the refusal comes before the ledger', async () => {
    await expect(diffService.fileDiff(WS, `${KB}/.git/config`)).rejects.toMatchObject({ status: 403 });
    // Through a link as well: the resolved form is judged before the seed too.
    await symlink('.git', join(workspaceDir, KB, 'gitlink-diff'));
    await expect(diffService.fileDiff(WS, `${KB}/gitlink-diff/config`)).rejects.toMatchObject({ status: 403 });
    await expect(stat(join(root, 'backups'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a legacy git entry in the backup ledger is not listed, and its content never comes back', async () => {
    // A ledger seeded before the rule existed: the backup side holds the git
    // folder. Listing must not pair it with the workspace path and read it out.
    const backupKb = join(root, 'backups', WS, KB);
    await mkdir(join(backupKb, '.GIT'), { recursive: true });
    await writeFile(join(backupKb, '.GIT', 'config'), '[credential]\n\thelper = store\n');
    await mkdir(join(backupKb, 'Notes'), { recursive: true });
    await writeFile(join(backupKb, 'Notes', 'a.md'), '# A\nhelper\n');

    const session = await diffService.currentSession(WS);
    expect(JSON.stringify(session ?? {})).not.toMatch(/\.GIT|credential/);
  });

  it('an ordinary file still diffs', async () => {
    await expect(diffService.fileDiff(WS, `${KB}/Notes/a.md`)).resolves.toMatchObject({ path: `${KB}/Notes/a.md` });
  });
});
