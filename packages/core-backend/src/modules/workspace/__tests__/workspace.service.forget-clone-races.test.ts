import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { WorkspaceService } from '../workspace.service.js';
import type { IGitRunner } from '../../../shared/git.contract.js';

/**
 * What happens to work ALREADY IN FLIGHT when the knowledge-base repository is
 * replaced under a running server.
 *
 * `forgetClone` clearing the caches is not enough on its own: a bootstrap or a
 * fetch started before the replacement finishes afterwards and writes its
 * result back into those very caches — about a working copy that no longer
 * exists. Both readers record how many times the copy has been taken away and
 * check that before publishing anything.
 */

const BRANCH = 'main';
const WORKSPACE_ID = encodeURIComponent(BRANCH);

let root: string;
let workspacesRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-forget-races-'));
  workspacesRoot = path.join(root, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

/** A git runner whose every call is a promise this test resolves by hand. */
function heldRunner() {
  const calls: Array<{ args: string[]; settle: () => void; fail: (err: Error) => void }> = [];
  const runner = {
    defaultTimeoutMs: 1000,
    credentials: { token: () => null, username: () => null, fingerprint: () => 'none' },
    run: vi.fn(
      (_cwd: string, args: string[]) =>
        new Promise((resolve, reject) => {
          calls.push({
            args,
            settle: () => resolve({ stdout: '', stderr: '', exitCode: 0 }),
            fail: (err: Error) => reject(err),
          });
        }),
    ),
  } as unknown as IGitRunner;
  return { runner, calls };
}

function service(runner: IGitRunner) {
  return new WorkspaceService(
    workspacesRoot,
    () => `${root}/configured.git`,
    testKbContext({ branchModel: { defaultBranch: BRANCH, protectedBranches: [BRANCH] } }),
    new NodeFs(),
    runner,
  );
}

/** A working copy on disk, as far as anything that only looks for `.git` cares. */
async function cloneOnDisk(): Promise<string> {
  const repoDir = path.join(workspacesRoot, WORKSPACE_ID, 'knowledge-base');
  await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
  return repoDir;
}

describe('a fetch in flight when the working copy is taken away', () => {
  it('does not stamp its result onto the clone that replaced it', async () => {
    const { runner, calls } = heldRunner();
    const svc = service(runner);
    const repoDir = await cloneOnDisk();

    // A fetch of the working copy as it is now, held open.
    const fetching = svc.ensureRemotesFetched(WORKSPACE_ID);
    await vi.waitFor(() => expect(calls.length).toBe(1));

    // The replacement lands mid-fetch: the copy is set aside, a fresh one is
    // cloned to the same path, and this process is told to forget the old one.
    svc.forgetClone(WORKSPACE_ID);
    calls[0]!.settle();
    await fetching;

    // The next reader must actually refresh the NEW clone. Were the stale
    // fetch's success stamped, it would be inside the TTL and skipped — the
    // app would serve the refs of a working copy that is gone for 30 seconds.
    const second = svc.ensureRemotesFetched(WORKSPACE_ID);
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]!.args).toEqual(calls[0]!.args);
    expect(calls[1]!.args).toContain('fetch');
    calls[1]!.settle();
    await second;
    expect(repoDir).toContain(WORKSPACE_ID);
  });

  it('does not leave a strict caller reading the old copy’s failure', async () => {
    const { runner, calls } = heldRunner();
    const svc = service(runner);
    await cloneOnDisk();

    const fetching = svc.ensureRemotesFetched(WORKSPACE_ID);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    svc.forgetClone(WORKSPACE_ID);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    calls[0]!.fail(new Error('repository not found'));
    await fetching;

    // The failure belonged to the working copy that was replaced. The fresh
    // one gets its own answer, and a successful fetch of it is a success.
    const strict = svc.ensureRemotesFetched(WORKSPACE_ID, { strict: true });
    await vi.waitFor(() => expect(calls.length).toBe(2));
    calls[1]!.settle();
    await expect(strict).resolves.toBeUndefined();
  });
});

describe('a bootstrap in flight when the working copy is taken away', () => {
  it('is refused rather than cached as the path of a directory that is gone', async () => {
    const { runner, calls } = heldRunner();
    const svc = service(runner);
    // Nothing on disk: this is a first clone, which is what takes seconds.
    const opening = svc.getOrCreateForBranch(BRANCH);
    // Told, rather than handed a cached path to a working copy of the
    // repository that was replaced — which every later read would ENOENT on,
    // with nothing left to re-clone it. The expectation is attached NOW: the
    // refusal lands somewhere inside the timer turns below, and a rejection
    // with no handler on it across a turn is what Vitest reports as unhandled
    // — a flake that failed the suite on CI with every test green.
    const refused = expect(opening).rejects.toThrow(/replaced while the "main" working copy was being created/);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));

    // The replacement lands while the clone runs.
    svc.forgetClone(WORKSPACE_ID);
    // Let the clone — and every config call after it — finish.
    for (let i = 0; i < 40 && calls.length > 0; i++) {
      const pending = calls.splice(0, calls.length);
      for (const call of pending) call.settle();
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    }

    await refused;
  });
});
