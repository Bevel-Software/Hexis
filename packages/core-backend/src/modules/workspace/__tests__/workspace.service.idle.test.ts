import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { WorkspaceService } from '../workspace.service.js';

/**
 * `idleWorkspaces` names the clones the sweep may consider: those on disk that
 * nobody has OPENED for the given period. Two things decide "opened": the
 * stamp `getOrCreateForBranch` leaves, and git's own writes to `.git`. The
 * cases here are about which clones must NOT be named — a wrongly named clone
 * only costs a re-clone, but the list should still mean what it says.
 */

const DAY = 86_400_000;
const KB = 'knowledge-base';

describe('WorkspaceService.idleWorkspaces', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ws-idle-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function service(): WorkspaceService {
    return new WorkspaceService(root, 'https://example.test/kb.git', KB, new NodeFs());
  }

  /** A finished clone on disk whose `.git` was last written `ageDays` ago. */
  async function clone(id: string, ageDays: number): Promise<string> {
    const gitDir = path.join(root, id, KB, '.git');
    await fs.mkdir(gitDir, { recursive: true });
    const when = new Date(Date.now() - ageDays * DAY);
    await fs.utimes(gitDir, when, when);
    return gitDir;
  }

  it('names a clone whose .git has not been written for longer than the period, oldest first', async () => {
    await clone('ali%2Fold', 45);
    await clone('ali%2Folder', 90);
    await clone('ali%2Ffresh', 2);

    const idle = await service().idleWorkspaces(30 * DAY);
    expect(idle.map((w) => w.branch)).toEqual(['ali/older', 'ali/old']);
    expect(idle[0]!.idleMs).toBeGreaterThan(89 * DAY);
  });

  it('opening a branch makes its clone current again, across processes', async () => {
    await clone('ali%2Fold', 45);
    await service().getOrCreateForBranch('ali/old');

    // A fresh service knows nothing in memory: the verdict has to come from disk.
    expect(await service().idleWorkspaces(30 * DAY)).toEqual([]);
  });

  it('a git write to the clone counts as use even when nothing opened it', async () => {
    const gitDir = await clone('ali%2Fold', 45);
    // The stamp says "long ago"; git wrote to .git since (a commit through
    // some path that never called getOrCreateForBranch).
    const stamp = path.join(gitDir, 'hexis-last-opened');
    await fs.writeFile(stamp, '');
    const longAgo = new Date(Date.now() - 60 * DAY);
    await fs.utimes(stamp, longAgo, longAgo);
    const now = new Date();
    await fs.utimes(gitDir, now, now);

    expect(await service().idleWorkspaces(30 * DAY)).toEqual([]);
  });

  it('never names a half-built directory or one that is not a workspace', async () => {
    // No .git: a clone that never finished.
    await fs.mkdir(path.join(root, 'juan%2Fabandoned', KB), { recursive: true });
    const when = new Date(Date.now() - 100 * DAY);
    await fs.utimes(path.join(root, 'juan%2Fabandoned', KB), when, when);
    // Not the encoding of any branch.
    await fs.mkdir(path.join(root, 'weird%zz', KB, '.git'), { recursive: true });

    expect(await service().idleWorkspaces(30 * DAY)).toEqual([]);
  });

  it('is empty when the workspaces root does not exist yet', async () => {
    const svc = new WorkspaceService(path.join(root, 'missing'), 'https://example.test/kb.git', KB, new NodeFs());
    expect(await svc.idleWorkspaces(30 * DAY)).toEqual([]);
  });
});
