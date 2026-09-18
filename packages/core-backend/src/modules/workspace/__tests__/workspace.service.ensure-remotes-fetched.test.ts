import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { WorkspaceService } from '../workspace.service.js';
import type { IGitRunner } from '../../../shared/git.contract.js';

/**
 * `ensureRemotesFetched` is one `git fetch --prune origin` for a whole clone,
 * and it is now what a change-request LIST pays instead of one fetch per open
 * request. Two properties matter to that caller, and they pull in opposite
 * directions: it must not storm the remote, and it must not answer a read
 * that KNOWS the remote just moved out of a 30s-old window — a request whose
 * branch the clone has not fetched has no diff, which is a request missing
 * from its own author's tree.
 */
describe('WorkspaceService.ensureRemotesFetched', () => {
  let root: string;
  let runs: string[][];
  let runner: IGitRunner;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ws-fetch-'));
    await fs.mkdir(path.join(root, 'main', 'knowledge-base'), { recursive: true });
    runs = [];
    runner = {
      defaultTimeoutMs: 1000,
      run: vi.fn(async (_cwd: string, args: string[]) => {
        runs.push(args);
        return { stdout: '', stderr: '' };
      }),
    } as unknown as IGitRunner;
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const service = () =>
    new WorkspaceService(
      root,
      'https://example.test/kb.git',
      'knowledge-base',
      new NodeFs(),
      'x-access-token',
      runner,
    );

  const fetches = () => runs.filter((args) => args[0] === 'fetch');

  it('caches a successful fetch, so a poll cannot storm the remote', async () => {
    const svc = service();
    await svc.ensureRemotesFetched('main');
    await svc.ensureRemotesFetched('main');
    await svc.ensureRemotesFetched('main');
    expect(fetches()).toHaveLength(1);
  });

  it('force skips that window — an event-driven read is not a poll', async () => {
    const svc = service();
    await svc.ensureRemotesFetched('main');
    await svc.ensureRemotesFetched('main', { force: true });
    expect(fetches()).toHaveLength(2);
  });

  it('force still joins a fetch already in flight — that is the storm guard', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    runner = {
      defaultTimeoutMs: 1000,
      run: vi.fn(async (_cwd: string, args: string[]) => {
        runs.push(args);
        await gate;
        return { stdout: '', stderr: '' };
      }),
    } as unknown as IGitRunner;
    const svc = service();

    // The two list endpoints the tree asks together, both forced.
    const both = Promise.all([
      svc.ensureRemotesFetched('main', { force: true }),
      svc.ensureRemotesFetched('main', { force: true }),
    ]);
    release();
    await both;

    expect(fetches()).toHaveLength(1);
  });
});
