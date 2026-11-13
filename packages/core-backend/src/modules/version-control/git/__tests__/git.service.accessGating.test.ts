import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../../workspace/index.js';
import { VersionControlHooks } from '../../version-control-hooks.js';
import type { IAccessControl } from '../../../access/index.js';
import { GitService } from '../git.service.js';
import { AccessDeniedError, PushAccessRefusedError } from '../../../access-model/index.js';

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
    holdsAdminRootWrite: async () => false,
    eligibleWritersForPathsAtRef: async (_w, _ref, paths) =>
      new Map(paths.map((p) => [p, { roles: [], users: [], emails: new Set<string>() }])),
    findEmailByHash: async () => null,
    kbPrincipals: async () => ({ plugins: [], people: [] }),
    validateRolesYaml: () => ({ ok: true }),
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
    new VersionControlHooks(),
    testKbContext(),
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
      new VersionControlHooks(),
      testKbContext(),
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
    // The plugin-provisioning path: its endpoint IS the authorization (any
    // signed-in user may claim an unused name under Plugins/), and the gate
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
      new VersionControlHooks(),
      testKbContext(),
      undefined,
      ac,
    );

    await expect(svc.push(workspaceId, USER)).rejects.toBeInstanceOf(PushAccessRefusedError);
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
      new VersionControlHooks(),
      testKbContext(),
      undefined,
      ac,
    );

    await expect(svc.push(workspaceId, USER)).resolves.toBeUndefined();
    expect(calls.filter((c) => c.method === 'canWriteBatchAtRef')).toHaveLength(0);
  });

});

describe('GitService — push gate reads raw paths and judges each commit by its author', () => {
  let root: string;
  const workspaceId = 'ws-push-authors';
  const BRANCH = 'current-company-state';
  const BOB = 'bob@bevel.software';
  const CAROL = 'carol@elsewhere.example';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  /** A commit authored by `email`, made with plain git (as a stranded save of theirs would be). */
  async function commitAs(repo: string, email: string, rel: string, contents: string): Promise<void> {
    await writeFile(repo, rel, contents);
    await runGit(repo, ['add', '--', rel]);
    await runGit(repo, ['-c', 'core.quotePath=true', 'commit', `--author=Someone <${email}>`, '-m', `edit ${rel}`]);
  }

  async function originTip(originDir: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', BRANCH], { cwd: originDir });
    return stdout.trim();
  }

  async function localTip(repo: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repo });
    return stdout.trim();
  }

  /**
   * A published protected branch with a bare origin, and a GitService whose
   * access stub grants write by `writable(email, path)` and whose directory
   * knows `users`.
   */
  async function setup(opts: {
    writable: (email: string, p: string) => boolean;
    readable?: (email: string, p: string) => boolean;
    users?: string[];
    directory?: { isPlatformUser(email: string): Promise<boolean> } | null;
  }) {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const originDir = path.join(root, 'origin.git');
    await fs.mkdir(originDir);
    await runGit(originDir, ['init', '--bare', '-b', BRANCH]);
    await runGit(repo, ['remote', 'add', 'origin', originDir]);
    await commitFile(repo, 'Knowledge/Seed.md', 'seed\n', 'seed');
    await runGit(repo, ['push', '-u', 'origin', BRANCH]);

    const { ac, calls } = recordingAccessControl({
      canWriteBatchAtRef: (_ref, email, paths) => new Map(paths.map((p) => [p, opts.writable(email, p)])),
      eligible: () => ({ roles: ['Editors'], users: [{ name: 'Bob', email: BOB }] }),
    });
    const readCalls: { ref: string; email: string; path: string }[] = [];
    ac.canReadAtRef = async (_w, ref, email, p) => {
      readCalls.push({ ref, email, path: p });
      return opts.readable?.(email, p) ?? true;
    };
    const lookups: string[] = [];
    const users = new Set((opts.users ?? []).map((u) => u.toLowerCase()));
    const directory =
      opts.directory === undefined
        ? {
            isPlatformUser: async (email: string) => {
              lookups.push(email);
              return users.has(email.toLowerCase());
            },
          }
        : opts.directory;
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new VersionControlHooks(),
      testKbContext(),
      undefined,
      ac,
      undefined,
      directory,
    );
    const gateCalls = () =>
      calls.filter((c) => c.method === 'canWriteBatchAtRef').map((c) => ({ email: c.userEmail, paths: [...c.paths].sort() }));
    return { svc, repo, originDir, gateCalls, readCalls, lookups };
  }

  it('checks a file whose name git would quote by its real path, and the push lands', async () => {
    const real = 'Kunden/DE_Katalogübertragung per SFTP.docx';
    const { svc, repo, originDir, gateCalls } = await setup({
      // Only the real path is writable: the quoted, octal-escaped spelling
      // git prints by default would fall to a rule that refuses.
      writable: (email, p) => email === USER.email && p === real,
    });
    await commitAs(repo, USER.email, real, 'bytes\n');

    await expect(svc.push(workspaceId, USER)).resolves.toBeUndefined();
    expect(gateCalls()).toEqual([{ email: USER.email, paths: [real] }]);
    expect(await originTip(originDir)).toBe(await localTip(repo));
  });

  it('a colleague’s stranded commits land when THEY may write what they changed, whatever the pusher may', async () => {
    const { svc, repo, originDir, gateCalls } = await setup({
      users: [BOB],
      writable: (email, p) => (email === BOB ? p.startsWith('Bob/') : p.startsWith('Alice/')),
    });
    await commitAs(repo, BOB, 'Bob/Prüfung.md', 'bob\n');
    await commitAs(repo, BOB, 'Bob/second.md', 'bob again\n');
    await commitAs(repo, USER.email, 'Alice/mine.md', 'alice\n');

    await expect(svc.push(workspaceId, USER)).resolves.toBeUndefined();
    expect(gateCalls()).toEqual(
      expect.arrayContaining([
        { email: BOB, paths: ['Bob/Prüfung.md', 'Bob/second.md'] },
        { email: USER.email, paths: ['Alice/mine.md'] },
      ]),
    );
    expect(gateCalls()).toHaveLength(2);
    expect(await originTip(originDir)).toBe(await localTip(repo));
  });

  it("refuses when a commit's own author may not write a file it changed, as the platform, naming the file and its writers", async () => {
    const { svc, repo, originDir } = await setup({
      users: [BOB],
      // The pusher could write it; its author could not. The author decides.
      writable: (email, p) => email === USER.email || !p.startsWith('Restricted/'),
    });
    const before = await originTip(originDir);
    await commitAs(repo, BOB, 'Restricted/x.md', 'bob\n');
    await commitAs(repo, USER.email, 'Alice/mine.md', 'alice\n');

    const err = await svc.push(workspaceId, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushAccessRefusedError);
    const refusal = err as PushAccessRefusedError;
    expect(refusal.message).toContain("The platform's access check refused the push");
    expect(refusal.message).toContain('"Restricted/x.md" may be written by Editors; Bob <bob@bevel.software>');
    expect(refusal.message).not.toMatch(/repository host/i);
    expect(refusal.refusal).toEqual({
      path: 'Restricted/x.md',
      eligibleRoles: ['Editors'],
      eligibleUsers: [{ name: 'Bob', email: BOB }],
    });
    // Nothing left this server.
    expect(await originTip(originDir)).toBe(before);
  });

  it('a refused file the pusher may not read is not named, nor are its writers', async () => {
    const { svc, repo, readCalls } = await setup({
      users: [BOB],
      writable: (email, p) => email === USER.email || !p.startsWith('Secret/'),
      readable: (email, p) => !(email === USER.email && p.startsWith('Secret/')),
    });
    await commitAs(repo, BOB, 'Secret/plan.md', 'bob\n');

    const err = await svc.push(workspaceId, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushAccessRefusedError);
    const refusal = err as PushAccessRefusedError;
    expect(refusal.refusal).toBeNull();
    expect(refusal.message).toContain("The platform's access check refused the push");
    expect(refusal.message).not.toContain('Secret/plan.md');
    expect(refusal.message).not.toContain(BOB);
    expect(JSON.stringify(refusal.payload)).not.toMatch(/Secret|bob@/);
    // Asked of the PUSHER, at the published state.
    expect(readCalls).toEqual([{ ref: `origin/${BRANCH}`, email: USER.email, path: 'Secret/plan.md' }]);
  });

  it('a commit whose author is not a platform user is held to the pusher', async () => {
    const { svc, repo, gateCalls, lookups } = await setup({
      users: [BOB],
      writable: () => true,
    });
    await commitAs(repo, CAROL, 'Shared/c.md', 'carol\n');

    await expect(svc.push(workspaceId, USER)).resolves.toBeUndefined();
    expect(lookups).toEqual([CAROL]);
    expect(gateCalls()).toEqual([{ email: USER.email, paths: ['Shared/c.md'] }]);
  });

  it('and is refused when the pusher may not write what it changed', async () => {
    const { svc, repo } = await setup({
      users: [BOB],
      // Carol, were she asked, could write it: she is never asked.
      writable: (email) => email === CAROL,
    });
    await commitAs(repo, CAROL, 'Shared/c.md', 'carol\n');

    const err = await svc.push(workspaceId, USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushAccessRefusedError);
    expect((err as PushAccessRefusedError).refusal?.path).toBe('Shared/c.md');
  });

  it('without a directory, every unpushed commit is held to the pusher', async () => {
    const { svc, repo, gateCalls } = await setup({ directory: null, writable: () => true });
    await commitAs(repo, BOB, 'Bob/x.md', 'bob\n');

    await expect(svc.push(workspaceId, USER)).resolves.toBeUndefined();
    expect(gateCalls()).toEqual([{ email: USER.email, paths: ['Bob/x.md'] }]);
  });

  it("the pusher's own commits, under any spelling of their address, are the pusher's: no lookup", async () => {
    const { svc, repo, gateCalls, lookups } = await setup({ users: [], writable: () => true });
    await commitAs(repo, 'Alice@Bevel.Software', 'Alice/a.md', 'a\n');
    await commitAs(repo, USER.email, 'Alice/b.md', 'b\n');

    await expect(svc.push(workspaceId, USER)).resolves.toBeUndefined();
    expect(lookups).toEqual([]);
    expect(gateCalls()).toEqual([{ email: USER.email, paths: ['Alice/a.md', 'Alice/b.md'] }]);
  });

  it('a merge answers for what it brings in, by its merger: the merged branch’s authors are not asked', async () => {
    const { svc, repo, gateCalls, lookups } = await setup({
      users: [BOB],
      writable: (email) => email === USER.email,
    });
    await runGit(repo, ['checkout', '-b', 'bob/draft']);
    await commitAs(repo, BOB, 'Drafts/from-bob.md', 'bob\n');
    await runGit(repo, ['checkout', BRANCH]);
    // Merged by the pusher (author and committer both Alice).
    await execFileAsync('git', ['merge', '--no-ff', '-m', 'merge bob/draft', 'bob/draft'], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_NAME: 'Alice', GIT_AUTHOR_EMAIL: USER.email, GIT_COMMITTER_NAME: 'Alice', GIT_COMMITTER_EMAIL: USER.email },
    });

    await expect(svc.push(workspaceId, USER)).resolves.toBeUndefined();
    expect(lookups).toEqual([]);
    expect(gateCalls()).toEqual([{ email: USER.email, paths: ['Drafts/from-bob.md'] }]);
  });

  it('a directory that cannot answer fails the push; it is never read as an unknown author', async () => {
    const { svc, repo, originDir, gateCalls } = await setup({
      directory: { isPlatformUser: async () => { throw new Error('user store unavailable'); } },
      writable: () => true,
    });
    const before = await originTip(originDir);
    await commitAs(repo, BOB, 'Bob/x.md', 'bob\n');

    await expect(svc.push(workspaceId, USER)).rejects.toThrow('user store unavailable');
    expect(gateCalls()).toEqual([]);
    expect(await originTip(originDir)).toBe(before);
  });

  it('a draft branch push runs no check at all, whoever authored its commits', async () => {
    const { svc, repo, gateCalls, lookups } = await setup({ users: [BOB], writable: () => false });
    await runGit(repo, ['checkout', '-b', 'alice/draft']);
    await commitAs(repo, BOB, 'Bob/x.md', 'bob\n');

    await expect(svc.push(workspaceId, USER)).resolves.toBeUndefined();
    expect(gateCalls()).toEqual([]);
    expect(lookups).toEqual([]);
  });
});
