import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';
import { parsePorcelainZ } from '../git.service.js';

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-pending-changes-'));
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


function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
  } as unknown as WorkspaceService;
}

async function makeSvc(root: string, workspaceId: string) {
  const { workspaceDir, repo } = await seedWorkspace(root, workspaceId);
  const svc = new GitService(
    stubWorkspaceService(workspaceId, workspaceDir),
    new WorkflowHooks(),
    'knowledge-base',
  );
  return { svc, repo };
}

describe('GitService.pendingChanges', () => {
  let root: string;
  const workspaceId = 'ws-pending-1';

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('lists an untracked file that has never been added', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/Seed.md', 'seed\n', 'seed');
    await runGit(repo, ['checkout', '-b', 'ali/demo']);
    await writeFile(repo, 'juan.md', 'hello\n');

    expect(await svc.pendingChanges(workspaceId)).toEqual(['juan.md']);
  });

  it('lists a modified tracked file once', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/Foo.md', 'one\n', 'add foo');
    await runGit(repo, ['checkout', '-b', 'ali/demo']);
    await writeFile(repo, 'Knowledge/Foo.md', 'two\n');

    expect(await svc.pendingChanges(workspaceId)).toEqual(['Knowledge/Foo.md']);
  });

  it('lists a deleted tracked file', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/Foo.md', 'one\n', 'add foo');
    await runGit(repo, ['checkout', '-b', 'ali/demo']);
    await fs.rm(path.join(repo, 'Knowledge/Foo.md'));

    expect(await svc.pendingChanges(workspaceId)).toEqual(['Knowledge/Foo.md']);
  });

  it('lists a staged-but-uncommitted new file exactly once', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/Seed.md', 'seed\n', 'seed');
    await runGit(repo, ['checkout', '-b', 'ali/demo']);
    await writeFile(repo, 'Knowledge/Foo.md', 'new\n');
    await runGit(repo, ['add', 'Knowledge/Foo.md']);

    expect(await svc.pendingChanges(workspaceId)).toEqual(['Knowledge/Foo.md']);
  });

  it('lists the new path only for a rename, not the old one', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/Old.md', 'one\n', 'add old');
    await runGit(repo, ['checkout', '-b', 'ali/demo']);
    await runGit(repo, ['mv', 'Knowledge/Old.md', 'Knowledge/New.md']);

    expect(await svc.pendingChanges(workspaceId)).toEqual(['Knowledge/New.md']);
  });

  it('honours .gitignore — ignored untracked files are excluded', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/Seed.md', 'seed\n', 'seed');
    await runGit(repo, ['checkout', '-b', 'ali/demo']);
    await writeFile(repo, '.gitignore', 'secret.txt\n');
    await writeFile(repo, 'secret.txt', 'shh\n');
    await writeFile(repo, 'visible.md', 'ok\n');

    const paths = await svc.pendingChanges(workspaceId);
    expect(paths).toContain('.gitignore');
    expect(paths).toContain('visible.md');
    expect(paths).not.toContain('secret.txt');
  });

  it('preserves filenames with spaces verbatim', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/Seed.md', 'seed\n', 'seed');
    await runGit(repo, ['checkout', '-b', 'ali/demo']);
    await writeFile(repo, 'hello world.md', 'ok\n');

    expect(await svc.pendingChanges(workspaceId)).toEqual(['hello world.md']);
  });

  it('returns an empty list when the tree is clean', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/Seed.md', 'seed\n', 'seed');
    await runGit(repo, ['checkout', '-b', 'ali/demo']);

    expect(await svc.pendingChanges(workspaceId)).toEqual([]);
  });

  it('combines modified + deleted + staged + untracked without duplicates', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commitFile(repo, 'Knowledge/Mod.md', 'one\n', 'seed mod');
    await commitFile(repo, 'Knowledge/Del.md', 'gone\n', 'seed del');
    await runGit(repo, ['checkout', '-b', 'ali/demo']);

    // Modified tracked.
    await writeFile(repo, 'Knowledge/Mod.md', 'two\n');
    // Deleted tracked (on disk only, not staged).
    await fs.rm(path.join(repo, 'Knowledge/Del.md'));
    // Staged new file.
    await writeFile(repo, 'Knowledge/Staged.md', 'staged\n');
    await runGit(repo, ['add', 'Knowledge/Staged.md']);
    // Plain untracked.
    await writeFile(repo, 'juan.md', 'hi\n');

    const paths = await svc.pendingChanges(workspaceId);
    expect(paths.sort()).toEqual([
      'Knowledge/Del.md',
      'Knowledge/Mod.md',
      'Knowledge/Staged.md',
      'juan.md',
    ]);
  });
});

describe('parsePorcelainZ', () => {
  it('returns empty for empty input', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });

  it('parses an untracked entry', () => {
    expect(parsePorcelainZ('?? juan.md\0')).toEqual(['juan.md']);
  });

  it('parses a modified entry', () => {
    expect(parsePorcelainZ(' M Knowledge/Foo.md\0')).toEqual(['Knowledge/Foo.md']);
  });

  it('parses a rename by keeping the new path and dropping the old one', () => {
    expect(parsePorcelainZ('R  Knowledge/New.md\0Knowledge/Old.md\0'))
      .toEqual(['Knowledge/New.md']);
  });

  it('parses a copy the same way as a rename', () => {
    expect(parsePorcelainZ('C  b.md\0a.md\0')).toEqual(['b.md']);
  });

  it('dedupes multiple entries pointing at the same path', () => {
    expect(parsePorcelainZ('MM foo.md\0')).toEqual(['foo.md']);
  });

  it('preserves spaces in filenames', () => {
    expect(parsePorcelainZ('?? hello world.md\0')).toEqual(['hello world.md']);
  });

  it('parses a mix of entries in one buffer', () => {
    const buf =
      ' M Knowledge/Mod.md\0' +
      ' D Knowledge/Del.md\0' +
      'A  Knowledge/Staged.md\0' +
      '?? juan.md\0' +
      'R  Knowledge/New.md\0Knowledge/Old.md\0';
    expect(parsePorcelainZ(buf).sort()).toEqual([
      'Knowledge/Del.md',
      'Knowledge/Mod.md',
      'Knowledge/New.md',
      'Knowledge/Staged.md',
      'juan.md',
    ]);
  });
});
