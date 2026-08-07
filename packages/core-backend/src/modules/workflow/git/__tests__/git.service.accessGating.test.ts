import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import type { IAccessControl } from '../../../access/access-control.interface.js';
import { GitService } from '../git.service.js';
import { AccessDeniedError } from '../../../access/access-errors.js';

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-access-gate-'));
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
}

async function seedWorkspace(
  root: string,
  workspaceId: string,
): Promise<{ workspaceDir: string; repo: string }> {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ['init', '-b', 'current-company-state']);
  // CI runners (and fresh dev machines) don't have a global git identity.
  // `GitService.commit` uses `--author="..."` for the author but git still
  // needs a committer identity — falling back to env vars / config. Setting
  // local repo config keeps test runs reproducible without depending on the
  // ambient env on the host.
  await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
  await runGit(repo, ['config', 'user.name', 'Test Runner']);
  return { workspaceDir, repo };
}

async function writeFile(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

async function commitFile(
  repo: string,
  rel: string,
  contents: string,
  subject: string,
): Promise<void> {
  await writeFile(repo, rel, contents);
  await runGit(repo, ['add', rel]);
  await runGit(repo, ['commit', '-m', subject]);
}


function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
    ensureRemotesFetched: async () => undefined,
  } as unknown as WorkspaceService;
}

/**
 * Records every call into the access service and lets each test choose what
 * the gate-relevant methods return. The unit under test is GitService's
 * decision about WHICH ref to pass — the access service itself is exercised
 * by its own test file.
 */
interface AccessRecord {
  method: string;
  ref: string;
  userEmail: string;
  paths: string[];
}

function recordingAccessControl(opts: {
  canWriteAtRef?: (ref: string, email: string, path: string) => boolean | null;
  canWriteBatchAtRef?: (ref: string, email: string, paths: string[]) => Map<string, boolean> | null;
  eligible?: () => { roles: string[]; users: { name: string; email: string }[] };
} = {}): { ac: IAccessControl; calls: AccessRecord[] } {
  const calls: AccessRecord[] = [];
  const ac: IAccessControl = {
    canWrite: async () => true,
    canWriteBatch: async (_w, _u, paths) => new Map(paths.map((p) => [p, true])),
    canRead: async () => true,
    canReadBatch: async (_w, _u, paths) => new Map(paths.map((p) => [p, true])),
    eligibleReaders: async () => ({ restricted: false, roles: [], users: [] }),
    canReadAtRef: async () => true,
    canDownload: async () => false,
    canOwner: async () => false,
    eligibleOwners: async () => ({ roles: [], users: [] }),
    eligibleDownloaders: async () => ({ roles: [], users: [] }),
    eligibleWriters: async () => opts.eligible?.() ?? { roles: ['Admin'], users: [] },
    eligibleWriterEmails: async () => new Map(),
    eligibleOwnerEmails: async () => new Map(),
    grantSources: async () => ({}),
    invalidate: () => {},
    canWriteAtRef: async (_w, ref, userEmail, p) => {
      calls.push({ method: 'canWriteAtRef', ref, userEmail, paths: [p] });
      return opts.canWriteAtRef?.(ref, userEmail, p) ?? true;
    },
    canWriteBatchAtRef: async (_w, ref, userEmail, paths) => {
      calls.push({ method: 'canWriteBatchAtRef', ref, userEmail, paths });
      return opts.canWriteBatchAtRef?.(ref, userEmail, paths) ?? new Map(paths.map((p) => [p, true]));
    },
    eligibleWritersAtRef: async () => opts.eligible?.() ?? { roles: ['Admin'], users: [] },
    eligibleWritersForPathsAtRef: async (_w, _ref, paths) =>
      new Map(paths.map((p) => [p, { roles: [], users: [], emails: new Set<string>() }])),
    findEmailByHash: async () => null,
    kbPrincipals: async () => ({ groups: [], people: [] }),
    validateRolesYaml: () => ({ ok: true }),
    referencesToRole: async () => [],
  };
  return { ac, calls };
}

async function makeSvc(
  root: string,
  workspaceId: string,
  ac?: IAccessControl,
): Promise<{ svc: GitService; repo: string; workspaceDir: string }> {
  const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
  const svc = new GitService(
    stubWorkspaceService(workspaceId, workspaceDir),
    new WorkflowHooks(),
    'knowledge-base',
    undefined,
    ac ?? null,
  );
  return { svc, repo, workspaceDir };
}

const USER = { id: 'user-alice', name: 'Alice', email: 'alice@bevel.software' };
const SHARE_REQ = { summary: 'edit foo' };

describe('GitService — commit gate uses HEAD (not working tree)', () => {
  let root: string;
  const workspaceId = 'ws-commit-gate';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('passes ref=HEAD when checking the touched paths', async () => {
    const { ac, calls } = recordingAccessControl();
    const { svc, repo } = await makeSvc(root, workspaceId, ac);
    await commitFile(repo, 'Knowledge/Foo.md', 'seed\n', 'seed');
    await writeFile(repo, 'Knowledge/Foo.md', 'modified\n');

    await svc.commit(workspaceId, USER, SHARE_REQ);

    const gateCalls = calls.filter((c) => c.method === 'canWriteBatchAtRef');
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0].ref).toBe('HEAD');
    expect(gateCalls[0].userEmail).toBe(USER.email);
    expect(gateCalls[0].paths).toContain('Knowledge/Foo.md');
  });

  it('refuses the commit with AccessDeniedError when the gate says no', async () => {
    const { ac } = recordingAccessControl({
      canWriteBatchAtRef: (_ref, _email, paths) => new Map(paths.map((p) => [p, false])),
      eligible: () => ({ roles: ['Admin'], users: [] }),
    });
    const { svc, repo } = await makeSvc(root, workspaceId, ac);
    await commitFile(repo, 'Knowledge/Foo.md', 'seed\n', 'seed');
    await writeFile(repo, 'Knowledge/Foo.md', 'modified\n');

    await expect(svc.commit(workspaceId, USER, SHARE_REQ)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('allows the commit (bootstrap) when canWriteBatchAtRef returns null', async () => {
    // null = HEAD has no usable access config (typically the very first
    // commit creating roles.yaml). Without this, every initial commit would
    // deadlock — you can't create the config because you don't have access,
    // and you don't have access because there's no config.
    const { ac, calls } = recordingAccessControl({
      canWriteBatchAtRef: () => null,
    });
    const { svc, repo } = await makeSvc(root, workspaceId, ac);
    await commitFile(repo, 'README.md', 'first\n', 'seed');
    await writeFile(repo, 'roles.yaml', 'roles:\n  Admin:\n    - alice@bevel.software\n');

    await expect(svc.commit(workspaceId, USER, SHARE_REQ)).resolves.toBeDefined();
    const gateCalls = calls.filter((c) => c.method === 'canWriteBatchAtRef');
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0].ref).toBe('HEAD');
  });

  it('skips the gate entirely when accessControl is null (legacy wiring)', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId); // no access service
    await commitFile(repo, 'Knowledge/Foo.md', 'seed\n', 'seed');
    await writeFile(repo, 'Knowledge/Foo.md', 'modified\n');
    await expect(svc.commit(workspaceId, USER, SHARE_REQ)).resolves.toBeDefined();
  });

  it('skips the gate on non-protected (feature/draft) branches', async () => {
    // After fork-to-draft the user is on a feature branch whose HEAD content
    // is identical to the protected branch they forked from — so HEAD's
    // access tree still says "Admin only". Without skipping the gate here,
    // a non-admin's commit on their own draft would 403, breaking the
    // entire propose-via-PR workflow.
    const { ac, calls } = recordingAccessControl({
      canWriteBatchAtRef: (_ref, _email, paths) => new Map(paths.map((p) => [p, false])),
    });
    const { svc, repo } = await makeSvc(root, workspaceId, ac);
    await commitFile(repo, 'Knowledge/Foo.md', 'seed\n', 'seed');
    await runGit(repo, ['checkout', '-b', 'alice/draft']);
    await writeFile(repo, 'Knowledge/Foo.md', 'modified\n');

    await expect(svc.commit(workspaceId, USER, SHARE_REQ)).resolves.toBeDefined();
    expect(calls.filter((c) => c.method === 'canWriteBatchAtRef')).toHaveLength(0);
  });
});

describe('GitService — push gate uses origin/<branch> (not HEAD or working tree)', () => {
  let root: string;
  const workspaceId = 'ws-push-gate';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function setupWithOrigin(): Promise<{ svc: GitService; repo: string; calls: AccessRecord[] }> {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    // Stand up a bare repo as origin so push has something to talk to.
    const originDir = path.join(root, 'origin.git');
    await fs.mkdir(originDir);
    await runGit(originDir, ['init', '--bare', '-b', 'current-company-state']);
    await runGit(repo, ['remote', 'add', 'origin', originDir]);

    // Seed origin with a baseline commit so `origin/<branch>` exists.
    await commitFile(repo, 'Knowledge/Foo.md', 'seed\n', 'seed');
    await runGit(repo, ['push', '-u', 'origin', 'current-company-state']);

    // Make a local commit that hasn't been pushed yet.
    await commitFile(repo, 'Knowledge/Foo.md', 'modified\n', 'edit');

    const { ac, calls } = recordingAccessControl();
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
      undefined,
      ac,
    );
    return { svc, repo, calls };
  }

  it('passes ref=origin/<branch> when gating the push', async () => {
    const { svc, calls } = await setupWithOrigin();
    await svc.push(workspaceId, USER);
    const gateCalls = calls.filter((c) => c.method === 'canWriteBatchAtRef');
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0].ref).toBe('origin/current-company-state');
    expect(gateCalls[0].paths).toContain('Knowledge/Foo.md');
  });

  it('systemAuthorized skips the gate entirely, and the push still lands', async () => {
    // The group-provisioning path: its endpoint IS the authorization (any
    // signed-in user may claim an unused name under Groups/), and the gate
    // could only read the new folder's chain at origin as `write: Admin`.
    const { svc, calls } = await setupWithOrigin();
    await svc.push(workspaceId, USER, { systemAuthorized: true });
    expect(calls.filter((c) => c.method === 'canWriteBatchAtRef')).toHaveLength(0);
  });

  it('refuses the push when origin/<branch> rules deny the caller', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const originDir = path.join(root, 'origin.git');
    await fs.mkdir(originDir);
    await runGit(originDir, ['init', '--bare', '-b', 'current-company-state']);
    await runGit(repo, ['remote', 'add', 'origin', originDir]);
    await commitFile(repo, 'Knowledge/Foo.md', 'seed\n', 'seed');
    await runGit(repo, ['push', '-u', 'origin', 'current-company-state']);
    await commitFile(repo, 'Knowledge/Foo.md', 'modified\n', 'edit');

    const { ac } = recordingAccessControl({
      canWriteBatchAtRef: (ref, _email, paths) =>
        ref === 'origin/current-company-state'
          ? new Map(paths.map((p) => [p, false]))
          : new Map(paths.map((p) => [p, true])),
    });
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
      undefined,
      ac,
    );

    await expect(svc.push(workspaceId, USER)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('skips the gate entirely on non-protected (feature/draft) branches', async () => {
    // The whole point of the draft-then-PR workflow is that non-admins can
    // commit + push their own branches freely. Gating pushes on feature
    // branches would 403 the share-changes flow for anyone without write
    // access. Canonical state is only changed via PR merge, which has its
    // own approval gate (`origin/<base>` access tree).
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const originDir = path.join(root, 'origin.git');
    await fs.mkdir(originDir);
    await runGit(originDir, ['init', '--bare', '-b', 'current-company-state']);
    await runGit(repo, ['remote', 'add', 'origin', originDir]);
    await commitFile(repo, 'Knowledge/Foo.md', 'seed\n', 'seed');
    await runGit(repo, ['checkout', '-b', 'alice/fresh-draft']);
    await commitFile(repo, 'Knowledge/Foo.md', 'on draft\n', 'edit on draft');

    // Even an access service that would deny everything should be
    // bypassed on a non-protected branch.
    const { ac, calls } = recordingAccessControl({
      canWriteBatchAtRef: (_ref, _email, paths) => new Map(paths.map((p) => [p, false])),
    });
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
      undefined,
      ac,
    );

    await expect(svc.push(workspaceId, USER)).resolves.toBeUndefined();
    expect(calls.filter((c) => c.method === 'canWriteBatchAtRef')).toHaveLength(0);
  });

});
