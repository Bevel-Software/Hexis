import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { realDisk } from '../../../__tests__/real-disk.js';
import type { WorkspaceService } from '../../workspace/index.js';
import { AccessControlService } from '../access-control.service.js';
import { DISK_READS_AT_ONCE } from '../head-access-map.js';

const KB = 'knowledge-base';
const PAGES = 200;

/**
 * A batch check where no map answers reads each path's own entries from the
 * checkout. The file tree asks about every file of a folder at once, so the
 * batch reads them a few at a time (`mapPooled`), never one open file per
 * path: a folder of thousands would otherwise run out of file handles.
 */
describe('AccessControlService: a batch reads the checkout a few files at a time', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-batch-disk-reads-'));
    // A folder that is no repository: no map can answer, so every own entry is read from disk.
    const repo = path.join(root, 'ws', KB);
    await fs.mkdir(path.join(repo, 'Pages'), { recursive: true });
    await fs.writeFile(path.join(repo, 'roles.yaml'), 'roles:\n  Admin:\n    - admin@x.io\n');
    await fs.writeFile(path.join(repo, 'access.md'), '---\nread:\n  - everyone\n---\n');
    for (let i = 0; i < PAGES; i++) {
      await fs.writeFile(path.join(repo, 'Pages', `p${i}.md`), i % 2 ? '---\nread:\n  - deny everyone\n---\n# closed\n' : '# open\n');
    }
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it(`has at most ${DISK_READS_AT_ONCE} files open at once, and answers every path`, async () => {
    let open = 0;
    let most = 0;
    // Counts the files the checkout's reads hold open, and passes every call to the real one.
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      open++;
      most = Math.max(most, open);
      const handle = await realOpen(...args);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        open--;
        return close();
      };
      return handle;
    });
    const workspaces = { getWorkspacePath: async (id: string) => path.join(root, id) } as unknown as WorkspaceService;
    const svc = new AccessControlService(workspaces, KB, realDisk());
    const paths = Array.from({ length: PAGES }, (_, i) => `Pages/p${i}.md`);

    const verdicts = await svc.canReadBatch('ws', 'nobody@x.io', paths);

    expect(paths.map((p, i) => verdicts.get(p) === (i % 2 === 0))).not.toContain(false);
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThanOrEqual(DISK_READS_AT_ONCE);
  });
});
