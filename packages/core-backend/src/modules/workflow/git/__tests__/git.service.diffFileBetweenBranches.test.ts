import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { WorkflowValidationError, BranchNameError } from '../../workflow.errors.js';

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-compare-'));
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
  // CI runners have no global user.email / user.name. The local `runGit`
  // helper sets author/committer via env vars, but `svc.commitFile` spawns
  // its own git process that doesn't see them — so pin identity in the repo
  // config too, otherwise `git commit` fails with "empty ident name" on CI.
  await runGit(repo, ['config', 'user.email', 't@x.com']);
  await runGit(repo, ['config', 'user.name', 'Test']);
  return { workspaceDir, repo };
}

async function writeFile(repo: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repo, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
}

async function commitFile(
  repo: string,
  relativePath: string,
  contents: string,
  subject: string,
): Promise<void> {
  await writeFile(repo, relativePath, contents);
  await runGit(repo, ['add', relativePath]);
  await runGit(repo, ['commit', '-m', subject]);
}

async function deleteFileCommit(
  repo: string,
  relativePath: string,
  subject: string,
): Promise<void> {
  await runGit(repo, ['rm', relativePath]);
  await runGit(repo, ['commit', '-m', subject]);
}


function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
  } as unknown as WorkspaceService;
}

describe('GitService.diffFileBetweenBranches', () => {
  let root: string;
  const workspaceId = 'ws-compare-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('returns a unified diff when the file differs between two local branches', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Foo.md', 'line one\n', 'base');
    await runGit(repo, ['checkout', '-b', 'alice/edit-foo']);
    await commitFile(repo, 'Knowledge/Foo.md', 'line one\nline two\n', 'add line two');

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'Knowledge/Foo.md',
      'current-company-state',
      'alice/edit-foo',
    );
    expect(diff).toContain('diff --git a/Knowledge/Foo.md b/Knowledge/Foo.md');
    expect(diff).toContain('+line two');
  });

  it('returns the empty string when the file is identical on both branches', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Same.md', 'unchanged\n', 'base');
    await runGit(repo, ['checkout', '-b', 'alice/no-changes']);
    // no edits to Same.md on the new branch
    await commitFile(repo, 'Knowledge/Other.md', 'sidecar\n', 'unrelated edit');

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'Knowledge/Same.md',
      'current-company-state',
      'alice/no-changes',
    );
    expect(diff).toBe('');
  });

  it('renders a deleted-file diff when the file only exists on the from branch', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Old.md', 'going away\n', 'base');
    await runGit(repo, ['checkout', '-b', 'alice/cleanup']);
    await deleteFileCommit(repo, 'Knowledge/Old.md', 'remove Old.md');

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'Knowledge/Old.md',
      'current-company-state',
      'alice/cleanup',
    );
    expect(diff).toContain('deleted file mode');
    expect(diff).toContain('-going away');
  });

  it('renders a new-file diff when the file only exists on the to branch', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Seed.md', 'seed\n', 'base');
    await runGit(repo, ['checkout', '-b', 'alice/add-new']);
    await commitFile(repo, 'Knowledge/New.md', 'brand new\n', 'add New.md');

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'Knowledge/New.md',
      'current-company-state',
      'alice/add-new',
    );
    expect(diff).toContain('new file mode');
    expect(diff).toContain('+brand new');
  });

  it('resolves a branch reachable only via origin/<name>', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);

    // Set up an "origin" remote pointing at a separate bare repo, push
    // target-company-state there, then drop the local head so the only way
    // to reach it is through refs/remotes/origin/target-company-state.
    const remoteDir = path.join(root, 'origin.git');
    await fs.mkdir(remoteDir, { recursive: true });
    await runGit(remoteDir, ['init', '--bare', '-b', 'current-company-state']);
    await runGit(repo, ['remote', 'add', 'origin', remoteDir]);

    await commitFile(repo, 'Knowledge/Foo.md', 'base\n', 'base');
    await runGit(repo, ['push', '-u', 'origin', 'current-company-state']);

    await runGit(repo, ['checkout', '-b', 'target-company-state']);
    await commitFile(repo, 'Knowledge/Foo.md', 'target version\n', 'target edit');
    await runGit(repo, ['push', '-u', 'origin', 'target-company-state']);

    // Move off target so we can delete the local head.
    await runGit(repo, ['checkout', 'current-company-state']);
    await runGit(repo, ['branch', '-D', 'target-company-state']);

    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'Knowledge/Foo.md',
      'current-company-state',
      'target-company-state',
    );
    expect(diff).toContain('+target version');
    expect(diff).toContain('-base');
  });

  it('accepts a workspace-relative path with the knowledge-base/ prefix', async () => {
    // Regression: the file viewer stores paths workspace-relative
    // ("knowledge-base/Knowledge/Foo.md") because reads/writes go through
    // WorkspaceService which resolves from the workspace root. Git pathspecs
    // are resolved from cwd (the repo dir = workspace/knowledge-base/),
    // so without prefix-stripping `git diff -- knowledge-base/X` looks
    // for `knowledge-base/knowledge-base/X` and silently returns
    // empty — which the UI rendered as "identical".
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Foo.md', 'baseline\n', 'base');
    await runGit(repo, ['checkout', '-b', 'alice/edit-foo']);
    await commitFile(repo, 'Knowledge/Foo.md', 'baseline\nedit\n', 'edit');

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'knowledge-base/Knowledge/Foo.md',
      'current-company-state',
      'alice/edit-foo',
    );
    expect(diff).toContain('+edit');
  });

  it('shows uncommitted working-tree edits when "to" is the current branch', async () => {
    // Regression: comparing a saved-but-uncommitted edit against another
    // branch used to return empty because we diffed two HEAD commits and
    // the edit hadn't landed in HEAD yet. Now we diff against the working
    // tree when one side is the checked-out branch.
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Foo.md', 'baseline\n', 'base');
    await runGit(repo, ['checkout', '-b', 'alice/edit-foo']);
    // Edit on disk but DO NOT commit — mimics the user typing in the editor
    // and pressing save before sharing.
    await writeFile(repo, 'Knowledge/Foo.md', 'baseline\nfresh edit\n');

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'Knowledge/Foo.md',
      'current-company-state',
      'alice/edit-foo',
    );
    expect(diff).toContain('+fresh edit');
  });

  it('renders an added diff for an untracked working-tree file when "to" is the current branch', async () => {
    // Regression: `git diff <ref> -- <path>` ignores untracked files, so a
    // brand-new on-disk file used to render as identical between branches.
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Seed.md', 'seed\n', 'base');
    await runGit(repo, ['checkout', '-b', 'alice/draft']);
    // Brand-new file, never committed — only on disk.
    await writeFile(repo, 'Knowledge/Brandnew.md', 'fresh content\n');

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'Knowledge/Brandnew.md',
      'current-company-state',
      'alice/draft',
    );
    expect(diff).toContain('new file mode');
    expect(diff).toContain('+fresh content');
  });

  it('renders a removed diff for an untracked working-tree file when "from" is the current branch', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Seed.md', 'seed\n', 'base');
    await runGit(repo, ['checkout', '-b', 'alice/draft']);
    await writeFile(repo, 'Knowledge/Brandnew.md', 'fresh content\n');

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'Knowledge/Brandnew.md',
      'alice/draft',
      'current-company-state',
    );
    expect(diff).toContain('deleted file mode');
    expect(diff).toContain('-fresh content');
  });

  it('reverses the diff direction when "from" is the current branch', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await commitFile(repo, 'Knowledge/Foo.md', 'baseline\n', 'base');
    await runGit(repo, ['checkout', '-b', 'alice/edit-foo']);
    await commitFile(repo, 'Knowledge/Foo.md', 'baseline\ndraft edit\n', 'edit on draft');
    // Now compare with "from = current draft" so the working tree (draft
    // version) sits on the from side and current-company-state on the to
    // side. Lines added on current-company-state — i.e. the *removal* of
    // "draft edit" — should appear as `+` on the to side, and "draft edit"
    // should appear as `-`.
    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      'Knowledge/Foo.md',
      'alice/edit-foo',
      'current-company-state',
    );
    expect(diff).toContain('-draft edit');
  });

  it('rejects identical from/to branches', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await expect(
      svc.diffFileBetweenBranches(
        workspaceId,
        'Knowledge/Foo.md',
        'current-company-state',
        'current-company-state',
      ),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it('rejects an unknown branch', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    await commitFile(repo, 'Knowledge/Foo.md', 'base\n', 'base');
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await expect(
      svc.diffFileBetweenBranches(
        workspaceId,
        'Knowledge/Foo.md',
        'current-company-state',
        'does-not-exist',
      ),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it('rejects a path-traversal attempt', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await expect(
      svc.diffFileBetweenBranches(
        workspaceId,
        '../etc/passwd',
        'current-company-state',
        'target-company-state',
      ),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
  });

  it('rejects a branch name with shell metacharacters', async () => {
    const { workspaceDir } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );

    await expect(
      svc.diffFileBetweenBranches(
        workspaceId,
        'Knowledge/Foo.md',
        'current-company-state',
        'alice/$(whoami)',
      ),
    ).rejects.toBeInstanceOf(BranchNameError);
  });

  // Regression: pathspec literal handling. `git diff <ref> -- '[Approved] x.md'`
  // would interpret the brackets as a character-class glob and emit no diff.
  // Routes both SETUP commits through `svc.commitFile` so the bracketed
  // `git add` runs under the env var on both branches.
  it('renders a diff for a bracketed filename between branches — pathspec literal regression', async () => {
    const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
    const svc = new GitService(
      stubWorkspaceService(workspaceId, workspaceDir),
      new WorkflowHooks(),
      'knowledge-base',
    );
    await runGit(repo, ['commit', '--allow-empty', '-m', 'init']);
    const user = { id: 'u', name: 'Test', email: 't@x.com' };
    const relPath = '[Approved] design.md';

    await writeFile(repo, relPath, 'base content\n');
    await svc.commitFile(workspaceId, user, relPath, 'base');

    await runGit(repo, ['checkout', '-b', 'alice/feature']);
    await writeFile(repo, relPath, 'base content\nfeature edit\n');
    await svc.commitFile(workspaceId, user, relPath, 'feature edit');

    const diff = await svc.diffFileBetweenBranches(
      workspaceId,
      relPath,
      'current-company-state',
      'alice/feature',
    );
    expect(diff).toContain('feature edit');
  });
});
