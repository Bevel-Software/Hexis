import type { Server as HttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { createToolContextResolver } from '../../tool-helpers/tool-context.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { WorkspaceService } from '../workspace.service.js';

const execFileAsync = promisify(execFile);
const KB_DIR = 'knowledge-base';

const allowAll = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) =>
    new Map(paths.map((p) => [p, true])),
} as unknown as IAccessControl;

const stubCreatorAccess: ICreatorAccess = {
  planForCreate: async () => null,
  grantInExtractedFile: async () => null,
  noteAccessFileWritten: () => {},
};

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
}

/**
 * The agent surface reaches a branch the same way the browser does — a tool
 * names it, `getFilesystem` resolves the per-branch clone — so the same two
 * refusals must come back out of a tool call, with the discriminator a model
 * (or the MCP proxy) can branch on rather than prose it has to read. This is
 * the surface the bug was reported from: a tester named a branch nobody ever
 * created and was told it "no longer exists on the remote".
 */
describe('workspace tools — a branch that cannot be opened', () => {
  let httpServer: HttpServer | undefined;
  let root = '';
  let workspaces: WorkspaceService | null = null;
  let spillRoot = '';
  let docCacheDir = '';

  afterEach(async () => {
    if (httpServer) {
      // Drop the pooled keep-alive sockets first, or close() waits out the
      // 5s keepAliveTimeout on every test in this file.
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer!.close(() => r()));
    }
    httpServer = undefined;
    workspaces = null;
    for (const dir of [root, spillRoot, docCacheDir]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
    root = '';
    spillRoot = '';
    docCacheDir = '';
  });

  /**
   * A real per-branch WorkspaceService over a real local origin, behind the
   * real tool-context resolver — so a tool call clones (or fails to clone)
   * exactly as it does in production.
   */
  async function start(opts: { repoUrl?: 'origin' | 'unreachable' } = {}): Promise<string> {
    root = await mkdtemp(join(tmpdir(), 'ws-tools-branch-'));
    spillRoot = await mkdtemp(join(tmpdir(), 'ws-tools-spill-'));
    docCacheDir = await mkdtemp(join(tmpdir(), 'ws-tools-doc-'));
    const workspacesRoot = join(root, 'workspaces');
    await mkdir(workspacesRoot, { recursive: true });

    const upstream = join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', 'target-company-state', upstream]);
    const seed = join(root, '.seed');
    await mkdir(seed);
    await runGit(seed, ['init', '-b', 'target-company-state']);
    await runGit(seed, ['remote', 'add', 'origin', upstream]);
    await mkdir(join(seed, KB_DIR));
    await writeFile(join(seed, KB_DIR, 'a.md'), 'hello\n', 'utf-8');
    await runGit(seed, ['add', '.']);
    await runGit(seed, ['commit', '-m', 'init']);
    await runGit(seed, ['checkout', '-b', 'alice/draft']);
    await runGit(seed, ['commit', '--allow-empty', '-m', 'draft']);
    await runGit(seed, ['push', 'origin', 'target-company-state', 'alice/draft']);

    workspaces = new WorkspaceService(
      workspacesRoot,
      opts.repoUrl === 'unreachable' ? join(root, 'no-such-repo.git') : upstream,
      KB_DIR,
      new NodeFs(),
    );

    const resolve = createToolContextResolver({
      authService: {
        getUserById: async () => ({ id: 'u', email: 'alice@example.com', name: 'Alice' }),
      } as unknown as AuthService,
      workspaceService: workspaces,
      workflowService: {} as never,
      events: { emit: () => {} } as unknown as WorkflowEventBus,
      kbDirName: KB_DIR,
      creatorAccess: stubCreatorAccess,
    });

    const app = express();
    app.use(express.json());
    const router = express.Router();
    registerWorkspaceTools(
      new ToolRegistry(),
      router,
      (req: express.Request, _res: express.Response, next: express.NextFunction) => {
        req.toolAuth = { source: 'external', userId: 'u', scope: 'read' } as ToolAuth;
        next();
      },
      createToolHandlerFactory(resolve),
      new SpillStore(spillRoot),
      new DocExtractService(docCacheDir),
      allowAll,
      KB_DIR,
      {
        service: {} as never,
        enabled: false,
        kbDirName: KB_DIR,
        recoveryBotEmail: 'recovery-bot@bevel.local',
        hooks: new WorkflowHooks(),
      },
      new RoutineWritePolicyService(),
      {} as never,
    );
    app.use('/api', router);
    httpServer = await new Promise<HttpServer>((r) => {
      const s = app.listen(0, () => r(s));
    });
    return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  }

  const listFiles = async (base: string, branch: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}/api/agent/tools/list_files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: JSON.stringify({ branch, path: '' }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  const deleteOnHost = (branch: string): Promise<void> =>
    runGit(join(root, 'upstream.git'), ['branch', '-D', branch]);

  it('404s a branch nothing has ever cloned or listed, and says only that', async () => {
    const base = await start();

    const { status, body } = await listFiles(base, 'nobody/never-made-this');

    expect(status).toBe(404);
    expect(body).toEqual({
      kind: 'branch-not-found',
      branch: 'nobody/never-made-this',
      error: 'There is no branch named nobody/never-made-this.',
    });
  });

  it('410s a branch a listing showed us and origin no longer has', async () => {
    const base = await start();
    workspaces!.noteBranchesListed(['target-company-state', 'alice/draft']);
    await deleteOnHost('alice/draft');

    const { status, body } = await listFiles(base, 'alice/draft');

    expect(status).toBe(410);
    expect(body).toMatchObject({ kind: 'remote-branch-gone', branch: 'alice/draft' });
  });

  it('serves a branch that exists', async () => {
    const base = await start();

    const { status, body } = await listFiles(base, 'alice/draft');

    expect(status).toBe(200);
    expect((body.entries as { name: string }[]).map((e) => e.name)).toContain(KB_DIR);
  });

  it('500s an unreachable remote rather than blaming the branch', async () => {
    const base = await start({ repoUrl: 'unreachable' });

    const { status, body } = await listFiles(base, 'alice/draft');

    expect(status).toBe(500);
    expect(body.kind).toBeUndefined();
  });
});
