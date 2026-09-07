import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

const KB_DIR = 'knowledge-base';

async function writeFile(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

/**
 * `invalidate()` fires exactly when the tree changes under a model load that
 * is still reading it: a marketplace compile for one caller drops the caches
 * while a compile for another caller is mid-load, or a commit lands while the
 * explorer builds. The load that started on the OLD tree must not store its
 * model after the drop — otherwise every read for the next TTL resolves
 * against a tree that is already gone.
 */
describe('AccessControlService — a load that straddles invalidate() never repopulates the cache', () => {
  let root: string;
  const workspaceId = 'ws-invalidate-race';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-invalidate-race-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a read that starts after the drop keeps seeing the new tree once the old load lands', async () => {
    const workspaceDir = path.join(root, workspaceId);
    const repo = path.join(workspaceDir, KB_DIR);
    await writeFile(repo, 'roles.yaml', 'roles:\n  Admin:\n    - admin@x.io\n');
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    // Notes is closed to zoe on the old tree.
    await writeFile(repo, 'Notes/access.md', '---\nread:\n  - Admin\n---\n');
    await writeFile(repo, 'Notes/plan.md', '# plan\n');
    const service = new AccessControlService(
      { getWorkspacePath: async () => workspaceDir } as unknown as WorkspaceService,
      KB_DIR,
    );

    // Hold the OLD load exactly where the walk reads Notes/access.md: the
    // bytes are read now (the closed rules), but the load cannot finish until
    // released — which is what a slow disk or a large tree does for free.
    const realReadFile = fs.readFile.bind(fs);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let reachedHold: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => (reachedHold = resolve));
    let holdOnce = true;
    vi.spyOn(fs, 'readFile').mockImplementation(async (file, ...rest) => {
      const result = await (realReadFile as (...a: unknown[]) => Promise<unknown>)(file, ...rest);
      if (holdOnce && String(file).endsWith(path.join('Notes', 'access.md'))) {
        holdOnce = false;
        reachedHold();
        await held;
      }
      return result as never;
    });
    const oldLoad = service.canRead(workspaceId, 'zoe@x.io', 'Notes/plan.md');
    await reached;

    // The tree moves and the caches are dropped while that load is in flight.
    await writeFile(repo, 'Notes/access.md', '---\nread:\n  - Admin\n  - Zoe <zoe@x.io>\n---\n');
    service.invalidate(workspaceId);
    try {
      await expect(service.canRead(workspaceId, 'zoe@x.io', 'Notes/plan.md')).resolves.toBe(true);
    } finally {
      // The old load lands (also on a failed assertion, so the test cannot hang).
      release();
    }

    // It answers for the tree it read — closed — but must not become the
    // cached model for the reads that follow.
    await expect(oldLoad).resolves.toBe(false);
    await expect(service.canRead(workspaceId, 'zoe@x.io', 'Notes/plan.md')).resolves.toBe(true);
  });
});
