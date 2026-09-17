import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import { GIT_INTERNALS_MESSAGE, GitInternalsError } from '../../../shared/domain-errors.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { LockingFilesystem } from '../../kb-fs/locking-filesystem.js';
import { ReadOnlyFilesystem } from '../../kb-fs/read-only-filesystem.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import type { AuthService } from '../../auth/auth.service.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import { WorkspaceService } from '../workspace.service.js';

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

/** Every spelling of a path INSIDE the git folder. `symlinked` goes through `knowledge-base/gitlink -> .git`. */
function fileForms(name: string): Record<string, string> {
  return {
    plain: `${KB}/.git/${name}`,
    'leading slash': `/${KB}/.git/${name}`,
    dotted: `${KB}/Notes/../.git/${name}`,
    'dot segments': `./${KB}/./.git/${name}`,
    encoded: `${KB}/%2egit/${name}`,
    'double-encoded': `${KB}/%252Egit/${name}`,
    'upper-case': `${KB}/.GIT/${name}`,
    'mixed-case': `${KB}/.Git/${name}`,
    backslashed: `${KB}\\.git\\${name}`,
    symlinked: `${KB}/gitlink/${name}`,
  };
}

/** Every spelling of the git folder ITSELF, for the operations that take a directory. */
const DIR_FORMS: Record<string, string> = {
  plain: `${KB}/.git`,
  'trailing slash': `${KB}/.git/`,
  dotted: `${KB}/Notes/../.git`,
  encoded: `${KB}/%2Egit`,
  'upper-case': `${KB}/.GIT`,
  symlinked: `${KB}/gitlink`,
  'symlinked, chained': `${KB}/chained`,
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
  const zip = new AdmZip();
  zip.addFile('extracted.md', Buffer.from('# extracted\n'));
  zip.writeZip(join(kb, 'archive.zip'));
  gitSnapshot = await snapshotGit();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function makeWorkflow() {
  return {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async () => ({ acquired: true, lock: { holderUserId: USER.id, holderName: USER.name } })),
    releaseLock: vi.fn(async () => null),
    releaseLockNoCommit: vi.fn(async () => undefined),
    releaseLockUntouched: vi.fn(async () => undefined),
    commitChanges: vi.fn(async () => null),
  };
}

const allowAll = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  canDownload: async () => true,
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

async function expectRefused(res: Response): Promise<unknown> {
  const body = (await res.json()) as Record<string, unknown>;
  expect({ status: res.status, error: body.error }).toEqual({ status: 403, error: GIT_INTERNALS_MESSAGE });
  return body;
}

// ── agent tools ──────────────────────────────────────────────────────────────

describe('workspace tools refuse the git folder', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let workflow: ReturnType<typeof makeWorkflow>;
  let unzipSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workflow = makeWorkflow();
    const service = new WorkspaceService(root, 'https://example.invalid/kb.git', KB, new NodeFs());
    unzipSpy = vi.spyOn(service, 'unzipFile');
    const lockingFs = new LockingFilesystem(
      { basePath: workspaceDir, contained: true },
      { workflow: workflow as unknown as IWorkflowService, workspaceId: WS, branch: BRANCH, user: USER, kbDirName: KB },
    );
    const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
      user: USER,
      scope: auth.scope,
      source: auth.source,
      sessionId,
      abortSignal: signal,
      workspaceService: service,
      workflowService: workflow as never,
      events: {} as never,
      getFilesystem: async () => lockingFs,
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
      new DocExtractService(join(root, 'doc-cache')),
      allowAll,
      KB,
      { service: {} as never, enabled: false, kbDirName: KB, recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks() },
      new RoutineWritePolicyService(),
      {} as never,
    );
    app.use('/api', router);
    ({ server, baseUrl } = await listen(app));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    // Nothing reached the lock service, and the git folder is untouched.
    expect(workflow.acquireLock).not.toHaveBeenCalled();
    expect(workflow.commitChanges).not.toHaveBeenCalled();
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
    ['unzip (destination)', (p) => ({ path: `${KB}/archive.zip`, destination: p })],
  ];

  for (const [op, args] of fileOps) {
    const tool = op.split(' ')[0];
    describe(op, () => {
      it.each(Object.entries(FILE_FORMS))('%s form', async (_form, p) => {
        await expectRefused(await call(tool, args(p)));
      });

      it('answers a missing path exactly as an existing one', async () => {
        for (const form of Object.keys(MISSING_FORMS)) {
          const existing = await call(tool, args(fileForms('config')[form]));
          const missing = await call(tool, args(MISSING_FORMS[form]));
          expect(missing.status).toBe(existing.status);
          expect(await missing.json()).toEqual(await existing.json());
        }
      });
    });
  }

  for (const [op, args] of dirOps) {
    const tool = op.split(' ')[0];
    it.each(Object.entries(DIR_FORMS))(`${op} — %s form`, async (_form, p) => {
      await expectRefused(await call(tool, args(p)));
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

  it('ordinary paths that merely look alike still work', async () => {
    const res = await call('write_file', { path: `${KB}/.github/workflows/ci.yml`, content: 'on: push\n' });
    expect(res.status).toBe(200);
    workflow.acquireLock.mockClear();
  });
});

// ── HTTP routes ──────────────────────────────────────────────────────────────

describe('workspace routes refuse the git folder', () => {
  let server: Server | undefined;
  let baseUrl = '';
  let workflow: ReturnType<typeof makeWorkflow>;
  let service: WorkspaceService;

  beforeEach(async () => {
    workflow = makeWorkflow();
    service = new WorkspaceService(root, 'https://example.invalid/kb.git', KB, new NodeFs());
    const app = express();
    app.use(express.json());
    app.use('/api', (req, _res, next) => {
      (req as unknown as { userId: string }).userId = USER.id;
      next();
    });
    app.use(
      '/api',
      createWorkspaceRoutes(
        service,
        { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
        workflow as unknown as IWorkflowService,
        { emit: vi.fn() } as unknown as WorkflowEventBus,
        allowAll,
        KB,
        stubCreatorAccess,
        { isAdmin: async () => true } as unknown as IAdminAccessService,
        new NodeFs(),
      ),
    );
    ({ server, baseUrl } = await listen(app));
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(workflow.acquireLock).not.toHaveBeenCalled();
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
      it.each(Object.entries(FILE_FORMS))('%s form', async (_form, p) => {
        await expectRefused(await send(p));
      });

      it('answers a missing path exactly as an existing one', async () => {
        for (const form of Object.keys(MISSING_FORMS)) {
          const existing = await send(fileForms('config')[form]);
          const missing = await send(MISSING_FORMS[form]);
          expect(missing.status).toBe(existing.status);
          expect(await missing.json()).toEqual(await existing.json());
        }
      });
    });
  }

  for (const [name, send] of dirRoutes) {
    it.each(Object.entries(DIR_FORMS))(`${name} — %s form`, async (_form, p) => {
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

  it('an ordinary read and a .github path still work', async () => {
    const read = await fetch(`${baseUrl}/api/workspace/${WS}/file?path=${q(`${KB}/Notes/a.md`)}`);
    expect(read.status).toBe(200);
    const write = await json('PUT', `${baseUrl}/api/workspace/${WS}/file?path=${q(`${KB}/.github/ci.yml`)}`, { content: 'on: push\n' });
    expect(write.status).toBe(200);
    workflow.acquireLock.mockClear();
  });
});

// ── the layers underneath, reached directly ─────────────────────────────────

describe('WorkspaceService refuses the git folder on its own', () => {
  let service: WorkspaceService;

  beforeEach(() => {
    service = new WorkspaceService(root, 'https://example.invalid/kb.git', KB, new NodeFs());
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
    ['createFolderZip', (p) => service.createFolderZip(WS, p.replace(/\/config$/, ''))],
    ['unzipFile (archive)', (p) => service.unzipFile(WS, `${p}.zip`)],
    ['unzipFile (destination)', (p) => service.unzipFile(WS, `${KB}/archive.zip`, p)],
  ];

  for (const [name, run] of ops) {
    it.each(Object.entries(fileForms('config')).filter(([form]) => !(name === 'readFileAtRef' && form === 'symlinked')))(
      `${name} — %s form`,
      async (_form, p) => {
        const err = await run(p).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(GitInternalsError);
      },
    );
  }

  it('unzip skips an archive entry aimed at the git folder, and extracts the rest', async () => {
    const zip = new AdmZip();
    zip.addFile('.git/config', Buffer.from('[core]\n\tfsmonitor = evil\n'));
    zip.addFile('.GIT/hooks/post-checkout', Buffer.from('#!/bin/sh\n'));
    zip.addFile('gitlink/HEAD', Buffer.from('evil\n'));
    zip.addFile('fine.md', Buffer.from('# fine\n'));
    zip.writeZip(join(workspaceDir, KB, 'evil.zip'));

    const result = await service.unzipFile(WS, `${KB}/evil.zip`);
    expect(result.extracted).toEqual([`${KB}/fine.md`]);
    expect(result.skipped.map((s) => s.reason)).toEqual([GIT_INTERNALS_MESSAGE, GIT_INTERNALS_MESSAGE, GIT_INTERNALS_MESSAGE]);
  });
});

describe('agent filesystems refuse the git folder on their own', () => {
  it('LockingFilesystem refuses before taking a lock', async () => {
    const workflow = makeWorkflow();
    const lockingFs = new LockingFilesystem(
      { basePath: workspaceDir, contained: true },
      { workflow: workflow as unknown as IWorkflowService, workspaceId: WS, branch: BRANCH, user: USER, kbDirName: KB },
    );
    for (const p of Object.values(FILE_FORMS)) {
      await expect(lockingFs.readFile(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.stat(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.writeFile(p, 'x')).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.appendFile(p, 'x')).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.deleteFile(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.copyFile(`${KB}/Notes/a.md`, p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.moveFile(p, `${KB}/Notes/b.md`)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.writeFiles([{ path: p, content: 'x' }], 'batch')).rejects.toBeInstanceOf(GitInternalsError);
    }
    for (const p of Object.values(DIR_FORMS)) {
      await expect(lockingFs.readdir(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(lockingFs.mkdir(`${p}/new`)).rejects.toBeInstanceOf(GitInternalsError);
    }
    expect(workflow.acquireLock).not.toHaveBeenCalled();
    expect(await snapshotGit()).toBe(gitSnapshot);
  });

  it('ReadOnlyFilesystem answers a git path with the git refusal, not the read-only one', async () => {
    const readOnly = new ReadOnlyFilesystem({ basePath: workspaceDir, contained: true });
    for (const p of Object.values(FILE_FORMS)) {
      await expect(readOnly.readFile(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(readOnly.exists(p)).rejects.toBeInstanceOf(GitInternalsError);
      await expect(readOnly.writeFile(p, 'x')).rejects.toBeInstanceOf(GitInternalsError);
    }
    const names = (await readOnly.readdir(KB)).map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(names).not.toContain('gitlink');
    expect(names).toContain('Notes');
  });
});
