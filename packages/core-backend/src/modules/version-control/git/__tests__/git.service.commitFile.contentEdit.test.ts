import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { VersionControlHooks } from '../../version-control-hooks.js';
import { GitService } from '../git.service.js';

/**
 * `GitService.commitFile` says what kind of change it committed
 * (`CommitAttribution.contentEdit`): an edit of a file that was already there,
 * and whether the file's leading `---` block changed with it. The events that
 * announce the commit are marked from it, so that an open file explorer does
 * not ask for the whole tree after a save that cannot have changed it.
 */

const execFileAsync = promisify(execFile);
const USER = { id: 'u-alice', name: 'Alice', email: 'alice@bevel.software' };
const WS = 'ws-content-edit';

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com' },
  });
}

const PAGE = '---\nread: [Sales]\n---\n\n# Name\nA page\n';

describe('GitService.commitFile — what kind of change it was', () => {
  let root: string;
  let repo: string;
  let svc: GitService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-git-contentedit-'));
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, 'knowledge-base');
    await fs.mkdir(repo, { recursive: true });
    await runGit(repo, ['init', '-b', 'feature-test']);
    await runGit(repo, ['config', 'user.email', 'test@bevel.local']);
    await runGit(repo, ['config', 'user.name', 'Test Runner']);
    await runGit(repo, ['config', 'core.autocrlf', 'false']);
    await fs.writeFile(path.join(repo, 'page.md'), PAGE);
    await fs.writeFile(path.join(repo, 'plain.md'), '# Name\nNo frontmatter\n');
    await fs.writeFile(path.join(repo, 'data.csv'), 'a,b\n1,2\n');
    await runGit(repo, ['add', '-A']);
    await runGit(repo, ['commit', '-m', 'seed']);
    svc = new GitService(
      { getWorkspacePath: async () => workspaceDir } as unknown as WorkspaceService,
      new VersionControlHooks(),
      testKbContext(),
    );
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const commit = (file: string) => svc.commitFile(WS, USER, file, undefined, true);

  it('an edit of the body of an existing page is a content edit that left its frontmatter alone', async () => {
    await fs.writeFile(path.join(repo, 'page.md'), `${PAGE}\n# Log\n- a line\n`);
    expect((await commit('page.md'))?.contentEdit).toEqual({ frontmatterChanged: false });
  });

  it('an edit of an existing page without frontmatter is one too', async () => {
    await fs.writeFile(path.join(repo, 'plain.md'), '# Name\nNo frontmatter\n\nMore.\n');
    expect((await commit('plain.md'))?.contentEdit).toEqual({ frontmatterChanged: false });
  });

  it('an edit of a file whose kind carries no access entries is one, whatever its first lines look like', async () => {
    await fs.writeFile(path.join(repo, 'data.csv'), '---\nread: [Everyone]\n---\na,b\n');
    expect((await commit('data.csv'))?.contentEdit).toEqual({ frontmatterChanged: false });
  });

  it('a changed access entry in the frontmatter is reported', async () => {
    await fs.writeFile(path.join(repo, 'page.md'), PAGE.replace('[Sales]', '[Sales, Finance]'));
    expect((await commit('page.md'))?.contentEdit).toEqual({ frontmatterChanged: true });
  });

  it('a changed entry behind a fence padded with spaces is reported', async () => {
    const padded = '--- \nread: [Sales]\n--- \n\n# Name\nA page\n';
    await fs.writeFile(path.join(repo, 'page.md'), padded);
    await commit('page.md');
    await fs.writeFile(path.join(repo, 'page.md'), padded.replace('[Sales]', '[Finance]'));
    expect((await commit('page.md'))?.contentEdit).toEqual({ frontmatterChanged: true });
  });

  it('frontmatter added to a page that had none is reported', async () => {
    await fs.writeFile(path.join(repo, 'plain.md'), '---\nread: [Sales]\n---\n# Name\nNo frontmatter\n');
    expect((await commit('plain.md'))?.contentEdit).toEqual({ frontmatterChanged: true });
  });

  it('frontmatter removed from a page is reported', async () => {
    await fs.writeFile(path.join(repo, 'page.md'), '# Name\nA page\n');
    expect((await commit('page.md'))?.contentEdit).toEqual({ frontmatterChanged: true });
  });

  it('a new file is not a content edit', async () => {
    await fs.writeFile(path.join(repo, 'new.md'), '# Name\nNew\n');
    const change = await commit('new.md');
    expect(change?.sha).toBeTruthy();
    expect(change?.contentEdit).toBeUndefined();
  });

  it('a new file in a new folder is not a content edit', async () => {
    await fs.mkdir(path.join(repo, 'Folder'));
    await fs.writeFile(path.join(repo, 'Folder', 'new.md'), '# Name\nNew\n');
    expect((await commit('Folder/new.md'))?.contentEdit).toBeUndefined();
  });

  it('a deleted file is not a content edit', async () => {
    await fs.rm(path.join(repo, 'plain.md'));
    const change = await commit('plain.md');
    expect(change?.sha).toBeTruthy();
    expect(change?.contentEdit).toBeUndefined();
  });
});
