import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';

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

async function writeFile(repo: string, relativePath: string, contents: string): Promise<void> {
  const absolutePath = path.join(repo, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
}

async function commit(repo: string, subject: string, files: Record<string, string>): Promise<void> {
  for (const [rel, contents] of Object.entries(files)) await writeFile(repo, rel, contents);
  await runGit(repo, ['add', '-A']);
  await runGit(repo, ['commit', '-m', subject]);
}

async function makeSvc(root: string, workspaceId: string) {
  const workspaceDir = path.join(root, workspaceId);
  const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
  await fs.mkdir(repo, { recursive: true });
  await runGit(repo, ['init', '-b', 'current-company-state']);
  const svc = new GitService(
    {
      getWorkspacePath: async (id: string) => {
        if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
        return workspaceDir;
      },
    } as unknown as WorkspaceService,
    new WorkflowHooks(),
    PROCESS_MAP_DIR,
  );
  return { svc, repo };
}

/**
 * The recency signal behind "where should I start reading?". A knowledge base
 * answers that with what the team has been working on, and the branch's own
 * history is the only place that knows it.
 */
describe('GitService.recentlyChangedPaths', () => {
  let root: string;
  const workspaceId = 'ws-recent-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-recent-paths-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('lists the newest work first', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commit(repo, 'first', { 'KnowledgeBase/GTM/Pricing.md': 'a\n' });
    await commit(repo, 'second', { 'KnowledgeBase/Legal/NDA.md': 'b\n' });

    expect(await svc.recentlyChangedPaths(workspaceId)).toEqual([
      'KnowledgeBase/Legal/NDA.md',
      'KnowledgeBase/GTM/Pricing.md',
    ]);
  });

  it('names a file edited over and over exactly once, at its most recent touch', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commit(repo, 'add both', {
      'KnowledgeBase/GTM/Pricing.md': 'a\n',
      'KnowledgeBase/Legal/NDA.md': 'b\n',
    });
    await commit(repo, 'revise pricing', { 'KnowledgeBase/GTM/Pricing.md': 'a2\n' });

    // A busy page would otherwise fill every slot with itself.
    expect(await svc.recentlyChangedPaths(workspaceId)).toEqual([
      'KnowledgeBase/GTM/Pricing.md',
      'KnowledgeBase/Legal/NDA.md',
    ]);
  });

  it('never offers a page that is no longer there', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commit(repo, 'add', {
      'KnowledgeBase/GTM/Pricing.md': 'a\n',
      'KnowledgeBase/Legal/NDA.md': 'b\n',
    });
    // Edited, THEN deleted in a later commit. Excluding deletions from the log
    // is not enough on its own: the earlier edit still names the file, which
    // is why the candidates are intersected with what the branch still holds.
    await commit(repo, 'revise', { 'KnowledgeBase/GTM/Pricing.md': 'a2\n' });
    await fs.rm(path.join(repo, 'KnowledgeBase/GTM/Pricing.md'));
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'remove pricing']);

    expect(await svc.recentlyChangedPaths(workspaceId)).toEqual(['KnowledgeBase/Legal/NDA.md']);
  });

  it('keeps a non-ASCII name as a path that still matches a file', async () => {
    const { svc, repo } = await makeSvc(root, workspaceId);
    await commit(repo, 'add', { 'KnowledgeBase/Legal/Kündigung.md': 'a\n' });

    // git's default `core.quotePath` would report this as "Kündigung.md"
    // wrapped in quotes with octal escapes, which matches no file on the way
    // back out and would silently drop the page.
    expect(await svc.recentlyChangedPaths(workspaceId)).toEqual([
      'KnowledgeBase/Legal/Kündigung.md',
    ]);
  });

  it('answers with nothing on a branch that has no commits yet', async () => {
    const { svc } = await makeSvc(root, workspaceId);
    expect(await svc.recentlyChangedPaths(workspaceId)).toEqual([]);
  });
});
