import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi, afterAll } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { IVersionControlService } from '@bevel-software/platform-shared';
import { GIT_INTERNALS_MESSAGE, GitInternalsError } from '../../../shared/domain-errors.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { archiveLandingFor } from '../../../__tests__/archive-landing.js';
import { LockingFilesystem, ReadOnlyFilesystem } from '../../kb-fs/index.js';
import { ToolRegistry } from '../../tool-registry/index.js';
import { createToolHandlerFactory, VersionControlHooks } from '../../../__tests__/tool-wiring.js';
import type { ToolContext } from '../../tool-helpers/index.js';
import type { ToolAuth } from '../../tool-auth/index.js';
import type { IAccessControl } from '../../access/index.js';
import type { ICreatorAccess } from '../../access-model/index.js';
import type { IAdminAccessService } from '../../admin/index.js';
import type { VersionControlEventBus } from '../../version-control/index.js';
import { ToolDescriptionNotes } from '../agent-access.gate.js';
import type { AuthService } from '../../auth/index.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { WorkerDocumentExtractor } from '../file-readers/extract-in-worker.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import type { ArchiveEntryJudge } from '../workspace.service.js';
import { createGitInternalsRouteGuard } from '../git-internals.middleware.js';
import { hasGitInternalsSegment } from '../../../shared/git-internals.js';
import { WorkspaceService, type ArchiveLanding } from '../workspace.service.js';
import { RipgrepPatternMatcher } from '../index.js';
import { newWorkspaceService } from '../../../__tests__/workspace-service.js';
import { gitFolderFileSpellings } from '../../../__tests__/git-folder-spellings.js';

/** The grep matcher this file's harness wires, closed once the file is done. */
const patternMatcher = new RipgrepPatternMatcher();
afterAll(() => patternMatcher.close());

/**
 * Security regression: the repository's internal git folder is unreachable
 * through every workspace tool and every workspace HTTP route, in every
 * spelling — plain, dotted, percent-encoded, upper-case — and through a
 * symbolic link in the repository that points into it. Each refusal is the
 * same 403 with the same message, whether or not anything is at the path, and
 * leaves the git folder exactly as it was.
 *
 * Real disk, real WorkspaceService, the real lock-aware filesystem; only the
 * lock service and the access rules are stubbed (allow-all), so nothing but
 * the git-folder rule can refuse.
 */

const KB = 'knowledge-base';
const BRANCH = 'main';
const WS = workspaceIdForBranch(BRANCH);
const USER = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };

/** Every spelling of a path INSIDE the git folder (see `gitFolderFileSpellings`). `symlinked` goes through `knowledge-base/gitlink -> .git`. */
const fileForms = (name: string): Record<string, string> => gitFolderFileSpellings(KB, name);

/**
 * The absolute forms name the workspace on disk, which only exists once the
 * temp root does — so they carry a placeholder until the test runs.
 */
const resolved = (form: string): string => form.replace('{{WORKSPACE_DIR}}', workspaceDir);

/** Every spelling of the git folder ITSELF, for the operations that take a directory. */
const DIR_FORMS: Record<string, string> = {
  plain: `${KB}/.git`,
  'trailing slash': `${KB}/.git/`,
  dotted: `${KB}/Notes/../.git`,
  encoded: `${KB}/%2Egit`,
  'upper-case': `${KB}/.GIT`,
  symlinked: `${KB}/gitlink`,
  'symlinked, chained': `${KB}/chained`,
  'symlinked, parent-climb': `${KB}/Notes/../gitlink`,
  'symlinked, dot segments': `./${KB}/./gitlink`,
  'symlinked, backslashed': `${KB}\\gitlink`,
  'symlinked, climb-out': `../${KB}/gitlink`,
  'symlinked, absolute': `{{WORKSPACE_DIR}}/${KB}/gitlink`,
  'symlinked, dotted name at the root': `..link`,
  // The folder ITSELF in the same five families the file forms carry, so every
  // directory-taking operation — list, mkdir, delete, folder download, unzip
  // destination — has a regression case for each of them too.
  'parent-climb': `${KB}/Notes/../.git`,
  'dot segments': `./${KB}/./.git`,
  backslashed: `${KB}\\.git`,
  'climb-out': `../${KB}/.git`,
  absolute: `{{WORKSPACE_DIR}}/${KB}/.git`,
};

const FILE_FORMS = { ...fileForms('config'), 'symlinked file': `${KB}/cfglink` };
const MISSING_FORMS = fileForms('no-such-file');

/** An archive path for a file form: the link to a file is used as it is, being a file already. */
const zipForm = (p: string) => (p.endsWith('/cfglink') ? p : `${p}.zip`);

let root = '';
let workspaceDir = '';
let gitSnapshot = '';

async function snapshotGit(): Promise<string> {
  const gitDir = join(workspaceDir, KB, '.git');
  const names = (await readdir(gitDir, { recursive: true })).sort();
  return JSON.stringify({ names, config: await readFile(join(gitDir, 'config'), 'utf8') });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-internals-sec-'));
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
  // An ordinary name that merely BEGINS with dots — not a climb, and a link by
  // that name reaches the folder like any other.
  await symlink(join(KB, '.git'), join(workspaceDir, '..link'));
  const zip = new AdmZip();
  zip.addFile('extracted.md', Buffer.from('# extracted\n'));
  zip.writeZip(join(kb, 'archive.zip'));
  gitSnapshot = await snapshotGit();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeVersionControl() {
  return {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async () => ({ acquired: true, lock: { holderUserId: USER.id, holderName: USER.name } })),
    // A batch's ownership check answers the lock the acquire granted.
    heartbeatLock: vi.fn(async () => ({ holderUserId: USER.id, holderName: USER.name })),
    releaseLock: vi.fn(async () => null),
    releaseLockNoCommit: vi.fn(async () => undefined),
    releaseLockUntouched: vi.fn(async () => undefined),
    commitChanges: vi.fn(async () => null),
  };
}

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

const stubCreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
} as unknown as ICreatorAccess;

async function listen(app: express.Express): Promise<{ server: Server; baseUrl: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * The ONE refusal, for every spelling.
 *
 * This used to make an exception: the path normaliser refuses a `..` segment,
 * a `.` segment, a backslash and an absolute path as PATHS, and for a while
 * that answer — a 400 quoting the spelling back — reached those spellings of a
 * git path first. Production measured it on all thirteen file tools. The git
 * rule now reads the caller's raw spelling before anything may rewrite or
 * refuse it, so no form is answered by anything but the sanitized 403; the
 * `form` argument is kept so a failure names the spelling that broke.
 */
async function expectRefused(res: Response, form?: string): Promise<unknown> {
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status, form).toBe(403);
  // The WHOLE body, not a search through it: the sanitized message stands
  // alone, and no field beside it can carry a spelling of the caller's path or
  // a "use this instead" correction. Two shapes exist — the tool surface
  // answers `{ error }`, the routes add the error's `kind` — so the one the
  // answer claims is the one it is held to, exactly.
  expect(body, form).toEqual(
    'kind' in body ? { kind: 'git-internals', error: GIT_INTERNALS_MESSAGE } : { error: GIT_INTERNALS_MESSAGE },
  );
  return body;
}

// ── agent tools ──────────────────────────────────────────────────────────────

describe('workspace tools refuse the git folder', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let versionControl: ReturnType<typeof makeVersionControl>;
  let unzipSpy: ReturnType<typeof vi.spyOn>;
  let bootstrappedSpy: ReturnType<typeof vi.spyOn>;
  let getFilesystem: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    versionControl = makeVersionControl();
    const service = newWorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), realDisk());
    unzipSpy = vi.spyOn(service, 'unzipFile');
    bootstrappedSpy = vi.spyOn(service, 'hasBootstrappedWorkspace');
    const lockingFs = new LockingFilesystem(
      { basePath: workspaceDir, contained: true },
      { versionControl: versionControl as unknown as IVersionControlService, workspaceId: WS, branch: BRANCH, user: USER, kbDirName: KB },
    );
    getFilesystem = vi.fn(async () => lockingFs);
    const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
      user: USER,
      scope: auth.scope,
      source: auth.source,
      sessionId,
      abortSignal: signal,
      workspaceService: service,
      versionControlService: versionControl as never,
      events: {} as never,
      getFilesystem,
    });
    const app = express();
    app.use(express.json());
    const router = express.Router();
    const fakeAuth: express.RequestHandler = (req, _res, next) => {
      req.toolAuth = { source: 'internal', userId: USER.id, scope: 'write' };
      next();
    };
    registerWorkspaceTools(
      new ToolRegistry(),
      router,
      fakeAuth,
      createToolHandlerFactory(resolve),
      new SpillStore(join(root, 'spills')),
      new DocExtractService(join(root, 'doc-cache'), new WorkerDocumentExtractor()),
      allowAll,
      testKbContext({ kbDirName: KB }),
      { recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new VersionControlHooks(), notes: new ToolDescriptionNotes() },
      new RoutineWritePolicyService(),
      {} as never,
      // Skill check, change gate, uploads, guide, downloads, starter packs, disk: not this harness's business.
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      patternMatcher,
    );
    app.use('/api', router);
    ({ server, baseUrl } = await listen(app));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    // Nothing reached the lock service, and the git folder is untouched.
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    expect(await snapshotGit()).toBe(gitSnapshot);
  });

  const call = (tool: string, args: Record<string, unknown>) =>
    fetch(`${baseUrl}/api/agent/tools/${tool}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch: BRANCH, ...args }),
    });

  const fileOps: Array<[string, (p: string) => Record<string, unknown>]> = [
    ['file_stat', (p) => ({ path: p })],
    ['read_file', (p) => ({ path: p })],
    ['grep', (p) => ({ pattern: 'helper', path: p })],
    ['write_file', (p) => ({ path: p, content: 'x' })],
    ['write_files', (p) => ({ files: [{ path: `${KB}/Notes/ok.md`, content: 'ok' }, { path: p, content: 'x' }] })],
    ['edit_file', (p) => ({ path: p, old_string: 'store', new_string: 'cache' })],
    ['delete_file', (p) => ({ path: p })],
    ['move_file (source)', (p) => ({ src: p, dest: `${KB}/Notes/moved` })],
    ['move_file (destination)', (p) => ({ src: `${KB}/Notes/a.md`, dest: p })],
    ['copy_file (source)', (p) => ({ src: p, dest: `${KB}/Notes/copied` })],
    ['copy_file (destination)', (p) => ({ src: `${KB}/Notes/a.md`, dest: p })],
    ['unzip (archive)', (p) => ({ path: zipForm(p) })],
  ];
  const dirOps: Array<[string, (p: string) => Record<string, unknown>]> = [
    ['list_files', (p) => ({ path: p })],
    ['grep', (p) => ({ pattern: 'helper', path: p })],
    ['mkdir', (p) => ({ path: `${p}/hooks-new` })],
    ['delete_file', (p) => ({ path: p })],
    ['delete_folder', (p) => ({ path: p, confirm: true })],
    ['delete_folder (dry run)', (p) => ({ path: p, dryRun: true })],
    ['unzip (destination)', (p) => ({ path: `${KB}/archive.zip`, destination: p })],
  ];

  for (const [op, args] of fileOps) {
    const tool = op.split(' ')[0];
    describe(op, () => {
      it.each(Object.entries(FILE_FORMS))('%s form', async (form, raw) => {
        const p = resolved(raw);
        await expectRefused(await call(tool, args(p)), form);
      });

      it('answers a missing path exactly as an existing one', async () => {
        for (const form of Object.keys(MISSING_FORMS)) {
          const existing = await call(tool, args(resolved(fileForms('config')[form])));
          const missing = await call(tool, args(resolved(MISSING_FORMS[form])));
          expect(missing.status, form).toBe(existing.status);
          // Compared with the file name put back. A spelling the PATH rule
          // refuses is answered on the spelling alone, and that answer QUOTES
          // the caller's own path — so the two bodies differ by the name the
          // caller sent and by nothing else, which is the oracle guarantee
          // stated exactly. (For the git refusals the substitution is a no-op:
          // that message names no path at all.) Anything disk-derived leaking
          // into either answer still fails this.
          const sameName = (text: string) => JSON.parse(text.split('no-such-file').join('config'));
          expect(sameName(await missing.text()), form).toEqual(await existing.json());
        }
      });
    });
  }

  for (const [op, args] of dirOps) {
    const tool = op.split(' ')[0];
    it.each(Object.entries(DIR_FORMS))(`${op} — %s form`, async (form, raw) => {
      const p = resolved(raw);
      await expectRefused(await call(tool, args(p)), form);
    });
  }

  it('write_files lands nothing when one path in the batch is refused', async () => {
    await expectRefused(await call('write_files', { files: [{ path: `${KB}/Notes/ok.md`, content: 'ok' }, { path: `${KB}/.git/HEAD`, content: 'x' }] }));
    await expect(readFile(join(workspaceDir, KB, 'Notes', 'ok.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('unzip never reaches the service for a refused archive or destination', async () => {
    await expectRefused(await call('unzip', { path: `${KB}/gitlink/x.zip` }));
    await expectRefused(await call('unzip', { path: `${KB}/archive.zip`, destination: `${KB}/.GIT` }));
    expect(unzipSpy).not.toHaveBeenCalled();
  });

  it('list_files never shows the git folder, nor a link into it', async () => {
    const res = await call('list_files', { path: KB });
    expect(res.status).toBe(200);
    const names = ((await res.json()) as { entries: { name: string }[] }).entries.map((e) => e.name);
    expect(names).toContain('Notes');
    expect(names).not.toContain('.git');
    expect(names).not.toContain('gitlink');
    expect(names).not.toContain('cfglink');
    expect(names).not.toContain('chained');
  });

  it('a whole-tree grep never matches inside the git folder', async () => {
    const res = await call('grep', { pattern: 'helper' });
    expect(res.status).toBe(200);
    const paths = ((await res.json()) as { matches: { path: string }[] }).matches.map((m) => m.path);
    expect(paths).toEqual([`${KB}/Notes/a.md`]);
  });

  it('the link check never clones a branch that is not cloned yet', async () => {
    bootstrappedSpy.mockResolvedValue(false);
    const res = await call('file_stat', { path: `${KB}/Notes/a.md` });
    expect(res.status).toBe(200);
    // Only the handler asked for the filesystem, after its own gates; the up-front check did not.
    expect(getFilesystem).toHaveBeenCalledTimes(1);
    // A plainly spelled git path is still refused without it.
    await expectRefused(await call('read_file', { path: `${KB}/.git/config` }));
    expect(getFilesystem).toHaveBeenCalledTimes(1);
  });

  it('ordinary paths that merely look alike still work', async () => {
    const res = await call('write_file', { path: `${KB}/.github/workflows/ci.yml`, content: 'on: push\n' });
    expect(res.status).toBe(200);
    versionControl.acquireLock.mockClear();
  });
});

// ── HTTP routes ──────────────────────────────────────────────────────────────

describe('workspace routes refuse the git folder', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let versionControl: ReturnType<typeof makeVersionControl>;
  let service: WorkspaceService;

  beforeEach(async () => {
    versionControl = makeVersionControl();
    service = newWorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), realDisk());
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userId: string }).userId = USER.id;
      next();
    });
    // Exactly the production mounting: ONE guard for the whole prefix, ahead
    // of every router under it. (The review routes under the same prefix are
    // held to it in `diff/__tests__/git-internals.security.test.ts`.)
    app.use('/api/workspace/:id', createGitInternalsRouteGuard(service));
    app.use(
      '/api',
      createWorkspaceRoutes(
        service,
        { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
        versionControl as unknown as IVersionControlService,
        { emit: vi.fn() } as unknown as VersionControlEventBus,
        allowAll,
        testKbContext({ kbDirName: KB }),
        stubCreatorAccess,
        { isAdmin: async () => true } as unknown as IAdminAccessService,
        realDisk(),
        undefined,
        undefined,
        archiveLandingFor({
          workspaceService: service,
          versionControl: versionControl as unknown as IVersionControlService,
          kbDirName: KB,
          creatorAccess: stubCreatorAccess,
        }),
      ),
    );
    ({ server, baseUrl } = await listen(app));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
    expect(await snapshotGit()).toBe(gitSnapshot);
  });

  const q = (p: string) => encodeURIComponent(p);
  const json = (method: string, url: string, body: unknown) =>
    fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const fileRoutes: Array<[string, (p: string) => Promise<Response>]> = [
    ['read (GET /file)', (p) => fetch(`${baseUrl}/api/workspace/${WS}/file?path=${q(p)}`)],
    ['stat/raw read (GET /file/raw)', (p) => fetch(`${baseUrl}/api/workspace/${WS}/file/raw?path=${q(p)}`)],
    ['download (GET /file/raw?download=1)', (p) => fetch(`${baseUrl}/api/workspace/${WS}/file/raw?download=1&path=${q(p)}`)],
    ['write (PUT /file)', (p) => json('PUT', `${baseUrl}/api/workspace/${WS}/file?path=${q(p)}`, { content: 'x' })],
    ['delete (DELETE /file)', (p) => fetch(`${baseUrl}/api/workspace/${WS}/file?path=${q(p)}`, { method: 'DELETE' })],
    ['move source (PATCH /file)', (p) => json('PATCH', `${baseUrl}/api/workspace/${WS}/file`, { oldPath: p, newPath: `${KB}/Notes/moved` })],
    ['move destination (PATCH /file)', (p) => json('PATCH', `${baseUrl}/api/workspace/${WS}/file`, { oldPath: `${KB}/Notes/a.md`, newPath: p })],
    ['upload (POST /upload)', (p) =>
      fetch(`${baseUrl}/api/workspace/${WS}/upload?path=${q(p)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.from('payload'),
      })],
    ['unzip archive (POST /unzip)', (p) => json('POST', `${baseUrl}/api/workspace/${WS}/unzip`, { path: zipForm(p) })],
  ];
  const dirRoutes: Array<[string, (p: string) => Promise<Response>]> = [
    ['mkdir (POST /directory)', (p) => json('POST', `${baseUrl}/api/workspace/${WS}/directory`, { path: `${p}/new-dir` })],
    ['download folder (GET /folder/zip)', (p) => fetch(`${baseUrl}/api/workspace/${WS}/folder/zip?download=1&path=${q(p)}`)],
    ['delete folder (DELETE /file)', (p) => fetch(`${baseUrl}/api/workspace/${WS}/file?path=${q(p)}`, { method: 'DELETE' })],
    ['unzip destination (POST /unzip)', (p) => json('POST', `${baseUrl}/api/workspace/${WS}/unzip`, { path: `${KB}/archive.zip`, destination: p })],
  ];

  for (const [name, send] of fileRoutes) {
    describe(name, () => {
      // No form passed: on this surface the git guard is mounted ahead of every
      // handler on the `/workspace/:id` prefix, so it answers before the
      // normaliser is ever asked — the one 403, in every spelling, as before.
      it.each(Object.entries(FILE_FORMS))('%s form', async (_form, raw) => {
        const p = resolved(raw);
        await expectRefused(await send(p));
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

  for (const [name, send] of dirRoutes) {
    it.each(Object.entries(DIR_FORMS))(`${name} — %s form`, async (_form, raw) => {
      const p = resolved(raw);
      await expectRefused(await send(p));
    });
  }

  it('a query-string path encoded twice over the wire is still refused', async () => {
    await expectRefused(await fetch(`${baseUrl}/api/workspace/${WS}/file?path=${KB}%2F%252egit%2Fconfig`));
  });

  it('the refusal body carries nothing beyond the message and its kind', async () => {
    const body = await expectRefused(await fetch(`${baseUrl}/api/workspace/${WS}/file?path=${q(`${KB}/.git/config`)}`));
    expect(body).toEqual({ kind: 'git-internals', error: GIT_INTERNALS_MESSAGE });
  });

  it('listing a folder never shows the git folder', async () => {
    const res = await fetch(`${baseUrl}/api/workspace/${WS}/files`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toMatch(/"\.git"|gitlink|cfglink|chained/);
  });

  it('a folder delete leaves a git folder in any spelling alone, and deletes the rest', async () => {
    const upper = join(workspaceDir, KB, 'Notes', '.GIT');
    await mkdir(upper, { recursive: true });
    await writeFile(join(upper, 'config'), '[credential]\n');

    const res = await fetch(`${baseUrl}/api/workspace/${WS}/file?path=${q(`${KB}/Notes`)}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'deleted', count: 1 });
    await expect(readFile(join(workspaceDir, KB, 'Notes', 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(upper, 'config'), 'utf8')).toBe('[credential]\n');
    versionControl.acquireLock.mockClear();
  });

  it('an ordinary read and a .github path still work', async () => {
    const read = await fetch(`${baseUrl}/api/workspace/${WS}/file?path=${q(`${KB}/Notes/a.md`)}`);
    expect(read.status).toBe(200);
    const write = await json('PUT', `${baseUrl}/api/workspace/${WS}/file?path=${q(`${KB}/.github/ci.yml`)}`, { content: 'on: push\n' });
    expect(write.status).toBe(200);
    versionControl.acquireLock.mockClear();
  });
});

// ── the layers underneath, reached directly ─────────────────────────────────

describe('WorkspaceService refuses the git folder on its own', () => {
  let service: WorkspaceService;
  /** What `LockingFilesystem.writeFiles` does on disk once it holds every lock: the caller's `check` asked, then each file it kept written, in order. */
  /**
   * A judge that lets every archive, destination and entry through: these
   * cases are about the git rule `unzipFile` applies itself, whoever asks.
   */
  const anyEntry: ArchiveEntryJudge = {
    archive: async () => undefined,
    destination: async () => undefined,
    entry: async () => undefined,
    refusedAtLock: () => undefined,
    skipped: () => null,
  };
  const diskLanding: ArchiveLanding = {
    writeFiles: async (handed, _summary, _deletes, check) => {
      const writes = check ? await check(handed) : handed;
      for (const w of writes) {
        await mkdir(join(workspaceDir, w.path, '..'), { recursive: true });
        await writeFile(join(workspaceDir, w.path), w.content);
      }
    },
  };

  beforeEach(() => {
    service = newWorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), realDisk());
  });

  afterEach(async () => {
    expect(await snapshotGit()).toBe(gitSnapshot);
  });

  const ops: Array<[string, (p: string) => Promise<unknown>]> = [
    ['readFile', (p) => service.readFile(WS, p)],
    ['readFileBinary', (p) => service.readFileBinary(WS, p)],
    ['readFileAtRef', (p) => service.readFileAtRef(WS, 'main', p.replace(`${KB}/`, ''))],
    ['writeFile', (p) => service.writeFile(WS, p, 'x')],
    ['writeFileBinary', (p) => service.writeFileBinary(WS, p, Buffer.from('x'))],
    ['assertContentMatches', (p) => service.assertContentMatches(WS, p, '')],
    ['withPathTurn', (p) => service.withPathTurn(WS, p, async () => undefined)],
    ['deleteFile', (p) => service.deleteFile(WS, p)],
    ['moveEntry (source)', (p) => service.moveEntry(WS, p, `${KB}/Notes/moved`)],
    ['moveEntry (destination)', (p) => service.moveEntry(WS, `${KB}/Notes/a.md`, p)],
    ['createDirectory', (p) => service.createDirectory(WS, `${p}/new`)],
    ['createFolderZip', (p) => service.createFolderZip(WS, p.replace(/\/config$/, ''), async (paths) => new Set(paths))],
    ['unzipFile (archive)', (p) => service.unzipFile(WS, `${p}.zip`, undefined, anyEntry, diskLanding)],
    ['unzipFile (destination)', (p) => service.unzipFile(WS, `${KB}/archive.zip`, p, anyEntry, diskLanding)],
  ];

  for (const [name, run] of ops) {
    // `readFileAtRef` reads a path out of a git REF, never off the working
    // tree, so no link on disk is followed and the link spellings do not
    // apply to it — a ref read of a link's path yields the link's own blob
    // (the target's NAME), never anything from inside the folder.
    it.each(
      Object.entries(fileForms('config')).filter(
        ([form]) => !(name === 'readFileAtRef' && form.startsWith('symlinked')),
      ),
    )(
      `${name} — %s form`,
      async (form, raw) => {
        const err = await run(resolved(raw)).catch((e: unknown) => e);
        expect(err, form).toBeInstanceOf(GitInternalsError);
      },
    );
  }

  it('a ref read of a link path reads the REF, not the folder the link points into', async () => {
    // The exception the matrix above excludes, asserted rather than assumed:
    // `readFileAtRef` runs `git show <ref>:<path>`, which reads out of the
    // object database and never follows a link on disk. A ref read of a link's
    // path yields the link's own blob — the target's NAME — so there is
    // nothing from inside the folder to refuse, and refusing it would take a
    // legitimate read away. The git rule still refuses every LITERAL spelling.
    const gitRunner = {
      defaultTimeoutMs: 1000,
      run: vi.fn(async (_cwd: string, args: string[]) => {
        // What `git show` really answers for a link's path: its target name.
        expect(args[0]).toBe('show');
        return { stdout: '.git\n', stderr: '', code: 0 };
      }),
    };
    const refService = newWorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), realDisk(), gitRunner as never);

    for (const [form, raw] of Object.entries(fileForms('config'))) {
      if (!form.startsWith('symlinked')) continue;
      // The service takes a repo-relative path here, as its callers pass it.
      const repoPath = resolved(raw).replace(`${KB}/`, '');
      const result = await refService.readFileAtRef(WS, 'main', repoPath).catch((e: unknown) => e);
      expect(result, form).not.toBeInstanceOf(GitInternalsError);
    }
    expect(gitRunner.run).toHaveBeenCalled();

    // …while a literal git path at a ref is still refused, whatever its form.
    for (const [form, raw] of Object.entries(fileForms('config'))) {
      if (form.startsWith('symlinked')) continue;
      const repoPath = resolved(raw).replace(`${KB}/`, '');
      const err = await refService.readFileAtRef(WS, 'main', repoPath).catch((e: unknown) => e);
      expect(err, form).toBeInstanceOf(Error);
    }
  });

  it('a folder download leaves out a git folder spelled in another case', async () => {
    const upper = join(workspaceDir, KB, 'Notes', '.GIT');
    await mkdir(upper, { recursive: true });
    await writeFile(join(upper, 'config'), '[credential]\n');
    await mkdir(join(workspaceDir, KB, 'Notes', '.git.'), { recursive: true });
    await writeFile(join(workspaceDir, KB, 'Notes', '.git.', 'HEAD'), 'ref\n');

    const names = new AdmZip(await service.createFolderZip(WS, `${KB}/Notes`, async (paths) => new Set(paths)))
      .getEntries()
      .map((e) => e.entryName);
    expect(names).toEqual(['Notes/a.md']);
  });

  it('unzip skips an archive entry aimed at the git folder, and extracts the rest', async () => {
    const zip = new AdmZip();
    zip.addFile('.git/config', Buffer.from('[core]\n\tfsmonitor = evil\n'));
    zip.addFile('.GIT/hooks/post-checkout', Buffer.from('#!/bin/sh\n'));
    zip.addFile('gitlink/HEAD', Buffer.from('evil\n'));
    zip.addFile('fine.md', Buffer.from('# fine\n'));
    zip.writeZip(join(workspaceDir, KB, 'evil.zip'));

    const result = await service.unzipFile(WS, `${KB}/evil.zip`, undefined, anyEntry, diskLanding);
    expect(result.extracted).toEqual([`${KB}/fine.md`]);
    expect(result.skipped.map((s) => s.reason)).toEqual([GIT_INTERNALS_MESSAGE, GIT_INTERNALS_MESSAGE, GIT_INTERNALS_MESSAGE]);
  });
});

describe('the route guard on its own', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let reached: number;
  let userId: string | undefined;

  beforeEach(async () => {
    reached = 0;
    userId = USER.id;
    const service = newWorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), realDisk());
    const app = express();
    // The server's own order: the guard ahead of the body parser, then again
    // on the parsed body, then again once the caller is known.
    app.use('/api/workspace/:id', createGitInternalsRouteGuard(service));
    app.use(express.json());
    app.use('/api/workspace/:id', createGitInternalsRouteGuard(service));
    app.use('/api', (req, _res, next) => {
      if (userId !== undefined) (req as unknown as { userId: string }).userId = userId;
      next();
    });
    app.use('/api/workspace/:id', createGitInternalsRouteGuard(service));
    // Stands in for every router mounted under the prefix — an extension's
    // overlay surface included. Reaching it at all is the bypass.
    app.use('/api/workspace/:id', (_req, res) => {
      reached += 1;
      res.json({ ok: true });
    });
    ({ server, baseUrl } = await listen(app));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  const post = (url: string, body: unknown) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it.each([
    ['path', (p: string) => ({ path: p })],
    ['oldPath', (p: string) => ({ oldPath: p, newPath: `${KB}/Notes/b.md` })],
    ['newPath', (p: string) => ({ oldPath: `${KB}/Notes/a.md`, newPath: p })],
    ['destination', (p: string) => ({ path: `${KB}/archive.zip`, destination: p })],
    ['paths (access batch)', (p: string) => ({ paths: [`${KB}/Notes/a.md`, p], verb: 'write' })],
    ['ancestor (remove-from-parent)', (p: string) => ({ mode: 'remove-from-parent', ancestor: p })],
  ])('refuses the git folder named in the %s field', async (_field, body) => {
    await expectRefused(await post(`${baseUrl}/api/workspace/${WS}/anything`, body(`${KB}/.git/config`)));
    expect(reached).toBe(0);
  });

  it('refuses the git folder in the prospective-access query fields, and only there for `from`', async () => {
    const git = encodeURIComponent(`${KB}/.git/config`);
    const note = encodeURIComponent(`${KB}/Notes/a.md`);
    await expectRefused(await fetch(`${baseUrl}/api/workspace/${WS}/access/prospective?from=${git}&toDir=${note}`));
    await expectRefused(await fetch(`${baseUrl}/api/workspace/${WS}/access/prospective?from=${note}&toDir=${git}`));
    // `toDir` is a path wherever it appears; `from` is a BRANCH on the
    // version-control comparison and is left to the branch-name rule there.
    await expectRefused(await fetch(`${baseUrl}/api/workspace/${WS}/anything?toDir=${git}`));
    expect(reached).toBe(0);
    const compare = await fetch(`${baseUrl}/api/workspace/${WS}/workflow/compare?from=${git}`);
    expect(compare.status).toBe(200);
    expect(reached).toBe(1);
  });

  it('refuses every spelling before the route runs, even unauthenticated', async () => {
    userId = undefined;
    const spellings = Object.values(FILE_FORMS).map(resolved);
    for (const p of spellings) {
      const res = await fetch(`${baseUrl}/api/workspace/${WS}/anything?path=${encodeURIComponent(p)}`);
      // Every spelling that NAMES the folder is refused with no disk touched.
      // The symlinked ones need the resolved check, which an unauthenticated
      // request does not get — their route answers them, with its own 401.
      if (hasGitInternalsSegment(p)) await expectRefused(res);
      else expect(res.status).toBe(200);
    }
    expect(reached).toBe(spellings.filter((p) => !hasGitInternalsSegment(p)).length);
  });

  it('refuses a git path even when the body does not parse, where the parser would answer 400', async () => {
    const res = await fetch(`${baseUrl}/api/workspace/${WS}/anything?path=${encodeURIComponent(`${KB}/.git/config`)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    });
    await expectRefused(res);
    expect(reached).toBe(0);
  });

  it('still answers a malformed body on an ordinary path the parser way', async () => {
    const res = await fetch(`${baseUrl}/api/workspace/${WS}/anything?path=${encodeURIComponent(`${KB}/Notes/a.md`)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    });
    expect(res.status).toBe(400);
    expect(reached).toBe(0);
  });

  it('lets an ordinary path through', async () => {
    const res = await fetch(`${baseUrl}/api/workspace/${WS}/anything?path=${encodeURIComponent(`${KB}/Notes/a.md`)}`);
    expect(res.status).toBe(200);
    expect(reached).toBe(1);
  });
});

describe('agent filesystems refuse the git folder on their own', () => {
  it('LockingFilesystem.writeFiles leaves a path its lock\'s gates refuse to those gates: the git rule\'s disk probe answers only what they let through', async () => {
    const versionControl = makeVersionControl();
    const gateRefusal = Object.assign(new Error('You don\'t have read access to this path.'), { status: 403 });
    versionControl.acquireLock.mockImplementation(async (_w: string, _b: string, p: string) => {
      if (p.startsWith(`${KB}/gitlink`)) throw gateRefusal;
      return { acquired: true, lock: { holderUserId: USER.id, holderName: USER.name } };
    });
    const lockingFs = new LockingFilesystem(
      { basePath: workspaceDir, contained: true },
      { versionControl: versionControl as unknown as IVersionControlService, workspaceId: WS, branch: BRANCH, user: USER, kbDirName: KB },
    );
    const refused: [string, unknown][] = [];
    // `gitlink` is a link into the git folder: its lock is refused by the gates, and the batch drops it as that path's alone.
    await lockingFs.writeFiles(
      [{ path: `${KB}/gitlink/config`, content: 'x' }, { path: `${KB}/Notes/kept.md`, content: 'k' }],
      'batch',
      [],
      undefined,
      (p, err) => void refused.push([p, err]),
    );
    expect(refused).toEqual([[`${KB}/gitlink/config`, gateRefusal]]);
    expect(await readFile(join(workspaceDir, KB, 'Notes', 'kept.md'), 'utf-8')).toBe('k');
    expect(await snapshotGit()).toBe(gitSnapshot);
  });

  it('LockingFilesystem refuses before taking a lock', async () => {
    const versionControl = makeVersionControl();
    const lockingFs = new LockingFilesystem(
      { basePath: workspaceDir, contained: true },
      { versionControl: versionControl as unknown as IVersionControlService, workspaceId: WS, branch: BRANCH, user: USER, kbDirName: KB },
    );
    for (const p of Object.values(FILE_FORMS).map(resolved)) {
      await expect(lockingFs.readFile(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.stat(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.writeFile(p, 'x')).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.appendFile(p, 'x')).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.deleteFile(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.copyFile(`${KB}/Notes/a.md`, p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.moveFile(p, `${KB}/Notes/b.md`)).rejects.toBeInstanceOf(GitInternalsError);
    }
    for (const p of Object.values(DIR_FORMS).map(resolved)) {
      await expect(lockingFs.readdir(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.mkdir(`${p}/new`)).rejects.toBeInstanceOf(GitInternalsError);
    }
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
    expect(await snapshotGit()).toBe(gitSnapshot);
  });

  it('LockingFilesystem.writeFiles refuses a git path whole: before any lock when the spelling says so, under its lock when the disk does, and gives every lock back untouched', async () => {
    const versionControl = makeVersionControl();
    const lockingFs = new LockingFilesystem(
      { basePath: workspaceDir, contained: true },
      { versionControl: versionControl as unknown as IVersionControlService, workspaceId: WS, branch: BRANCH, user: USER, kbDirName: KB },
    );
    for (const [form, spelled] of Object.entries(FILE_FORMS)) {
      const before = versionControl.acquireLock.mock.calls.length;
      const err = await lockingFs
        .writeFiles([{ path: resolved(spelled), content: 'x' }, { path: `${KB}/Notes/c.md`, content: 'c' }], 'batch')
        .then(() => null, (e: unknown) => e);
      // A spelling that names the folder, or that the path rules refuse (a
      // climb, a dot segment, a backslash, an absolute path), is refused
      // before any lock, reading nothing; a link into the folder is the git
      // rule's, asked under the lock.
      if (versionControl.acquireLock.mock.calls.length === before) {
        expect(err instanceof GitInternalsError || (err as { status?: number }).status === 400, form).toBe(true);
      } else {
        expect(err, form).toBeInstanceOf(GitInternalsError);
      }
    }
    // Every lock it took went back untouched: nothing was written or committed.
    const taken = versionControl.acquireLock.mock.calls.length;
    expect(versionControl.releaseLockUntouched.mock.calls.length).toBe(taken);
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    await expect(readFile(join(workspaceDir, KB, 'Notes', 'c.md'))).rejects.toThrow();
    expect(await snapshotGit()).toBe(gitSnapshot);
  });

  it('ReadOnlyFilesystem answers a git path with the git refusal, not the read-only one', async () => {
    const readOnly = new ReadOnlyFilesystem({ basePath: workspaceDir, contained: true });
    for (const p of Object.values(FILE_FORMS).map(resolved)) {
      await expect(readOnly.readFile(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(readOnly.exists(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(readOnly.writeFile(p, 'x')).rejects.toBeInstanceOf(GitInternalsError);
    }
    const names = (await readOnly.readdir(KB)).map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(names).not.toContain('gitlink');
    expect(names).toContain('Notes');
  });

  it('a recursive listing leaves the git folder out instead of failing on it', async () => {
    const readOnly = new ReadOnlyFilesystem({ basePath: workspaceDir, contained: true });
    const names = (await readOnly.readdir(KB, { recursive: true })).map((e) => e.name).sort();
    expect(names).toEqual(['Notes', 'Notes/a.md', 'archive.zip']);
    expect((await readOnly.readdir('', { recursive: true, maxDepth: 1 })).map((e) => e.name).sort()).toEqual([KB, `${KB}/Notes`, `${KB}/archive.zip`]);
  });

  it('a write through a dangling link into the git folder is refused and creates nothing', async () => {
    await symlink('.git/hooks/post-checkout', join(workspaceDir, KB, 'hook.md'));
    const versionControl = makeVersionControl();
    const lockingFs = new LockingFilesystem(
      { basePath: workspaceDir, contained: true },
      { versionControl: versionControl as unknown as IVersionControlService, workspaceId: WS, branch: BRANCH, user: USER, kbDirName: KB },
    );
    await expect(lockingFs.writeFile(`${KB}/hook.md`, '#!/bin/sh\n')).rejects.toBeInstanceOf(GitInternalsError);
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
    expect(await snapshotGit()).toBe(gitSnapshot);
  });
});
