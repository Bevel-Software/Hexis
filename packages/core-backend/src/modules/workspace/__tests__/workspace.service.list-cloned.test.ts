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
