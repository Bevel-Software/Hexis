import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceService } from '../workspace.service.js';

/**
 * `listClonedWorkspaces` is what the remote sync enumerates. It must read the
 * DISK, not the in-memory bootstrap cache: clones survive a restart, and a
 * hook that fires before anyone has opened a branch must still find them.
 */
describe('WorkspaceService.listClonedWorkspaces', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ws-list-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function clone(dirName: string, withGit = true) {
    const repo = path.join(root, dirName, 'knowledge-base');
    await fs.mkdir(withGit ? path.join(repo, '.git') : repo, { recursive: true });
  }

  it('finds every finished clone on disk without any branch having been opened this process', async () => {
    await clone('main');
    await clone('ali%2Fnew-skill');
    // Half-built: the directory exists but the clone never finished.
    await clone('juan%2Fabandoned', false);
    // Not one of ours: the name is not the encoding of any branch.
    await clone('weird%zz');
    // A stray file at the root is ignored.
    await fs.writeFile(path.join(root, 'notes.txt'), 'x');

    const svc = new WorkspaceService(root, 'https://example.test/kb.git', 'knowledge-base');
    const found = await svc.listClonedWorkspaces();
    expect(found.sort((a, b) => a.branch.localeCompare(b.branch))).toEqual([
      { id: 'ali%2Fnew-skill', branch: 'ali/new-skill' },
      { id: 'main', branch: 'main' },
    ]);
  });

  it('is empty when the workspaces root does not exist yet', async () => {
    const svc = new WorkspaceService(path.join(root, 'missing'), 'https://example.test/kb.git', 'knowledge-base');
    expect(await svc.listClonedWorkspaces()).toEqual([]);
  });
});

describe('WorkspaceService.listClonedWorkspaces — what is not a clone', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ws-list-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a directory whose name round-trips but is not a branch git accepts', async () => {
    // `foo!`, `-leading-dash` and `a..b` survive encodeURIComponent unchanged, so
    // only the validator can exclude them; `has space` does not round-trip and
    // is excluded one step earlier. Both guards have to hold.
    for (const name of ['main', 'foo!', '-leading-dash', 'a..b', 'has space']) {
      await fs.mkdir(path.join(root, name, 'knowledge-base', '.git'), { recursive: true });
    }
    const svc = new WorkspaceService(root, 'https://example.test/kb.git', 'knowledge-base');
    expect(await svc.listClonedWorkspaces()).toEqual([{ id: 'main', branch: 'main' }]);
  });

  it('a branch whose bootstrap is in flight right now', async () => {
    await fs.mkdir(path.join(root, 'main', 'knowledge-base', '.git'), { recursive: true });
    await fs.mkdir(path.join(root, 'ali%2Fx', 'knowledge-base', '.git'), { recursive: true });
    const svc = new WorkspaceService(root, 'https://example.test/kb.git', 'knowledge-base');
    // Reach into the bootstrap tracker the way `getOrCreateForBranch` does
    // while a clone is running: `.git` exists, the tree is not checked out yet.
    (svc as unknown as { inFlightBootstraps: Map<string, Promise<void>> }).inFlightBootstraps.set(
      'ali/x',
      new Promise(() => {}),
    );
    expect(await svc.listClonedWorkspaces()).toEqual([{ id: 'main', branch: 'main' }]);
  });

  it('a root that is a file counts as no root, not as a clone list', async () => {
    // A FILE where the root should be: readdir fails with ENOTDIR on POSIX and
    // ENOENT on Windows — both "no root", so an empty list. A permission
    // failure is the case that must propagate, and there is no portable way
    // to stage one in a temp dir; the code path is the same `throw err`.
    const file = path.join(root, 'not-a-dir');
    await fs.writeFile(file, 'x');
    const svc = new WorkspaceService(file, 'https://example.test/kb.git', 'knowledge-base');
    expect(await svc.listClonedWorkspaces()).toEqual([]);
  });
});
