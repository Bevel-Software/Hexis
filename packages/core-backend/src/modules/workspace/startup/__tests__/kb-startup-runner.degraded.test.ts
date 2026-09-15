import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KbRemoteUnreachableError, KbStartupRunner } from '../kb-startup-runner.js';
import { NodeGitRunner } from '../../../workflow/git/node-git-runner.js';
import type { OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

/**
 * What the runner does when the remote is not there — the one failure a boot
 * now survives. Real git against a real bare upstream, like the sibling suite;
 * "unreachable" is a path where no repository exists, which `ls-remote`
 * refuses at once.
 */

const execFileAsync = promisify(execFile);
const PROTECTED = ['current-company-state', 'target-company-state'];
const DEFAULT_BRANCH = 'current-company-state';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
  return stdout.toString();
}

let root: string;
let upstream: string;
let workspacesRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-startup-degraded-'));
  workspacesRoot = path.join(root, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });
  upstream = path.join(root, 'upstream.git');
  await git(root, ['init', '--bare', '-b', DEFAULT_BRANCH, upstream]);
  delete process.env.KB_SAFE_BOOT;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function step(name: string, run: (ctx: ServerStartContext) => Promise<StepResult>): OnServerStart {
  return { name, run };
}

function makeRunner(steps: OnServerStart[], url: () => string) {
  return new KbStartupRunner({
    gitRunner: new NodeGitRunner(),
    kbRepoUrl: url,
    gitUsername: () => 'x-access-token',
    workspacesRoot,
    kbDirName: 'knowledge-base',
    templateDir: path.join(root, 'template'),
    defaultBranch: () => DEFAULT_BRANCH,
    protectedBranches: () => PROTECTED,
    seedAdminEmails: ['admin@example.com'],
    steps,
    buildSeedTree: async (dir: string) => {
      await fs.writeFile(path.join(dir, 'seeded.md'), 'from template', 'utf8');
      return [];
    },
  });
}

describe('KbStartupRunner with an unreachable remote', () => {
  it('fails as unreachable, and stands on that failure until a run finishes', async () => {
    const runner = makeRunner([], () => path.join(root, 'nowhere.git'));

    await expect(runner.runAll()).rejects.toBeInstanceOf(KbRemoteUnreachableError);
    expect(runner.lastFailure()).toMatch(/could not be reached/);

    // The failure is the runner's own state, not the caller's: the gate reads
    // it from here, whichever caller ran the phase.
    const healthy = makeRunner([], () => upstream);
    await healthy.runAll();
    expect(healthy.lastFailure()).toBeNull();
  });

  it('a broken step is not "unreachable": that failure is the knowledge base being wrong', async () => {
    const runner = makeRunner(
      [step('broken', async () => ({ outcome: 'stopBoot', message: 'template is not what it should be' }))],
      () => upstream,
    );
    const err = await runner.runAll().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(KbRemoteUnreachableError);
    expect(runner.lastFailure()).toMatch(/template is not what it should be/);
  });

  it('two callers at once share one run rather than racing the clones', async () => {
    let runs = 0;
    const runner = makeRunner(
      [
        step('count', async () => {
          runs += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { outcome: 'ok' };
        }),
      ],
      () => upstream,
    );

    await Promise.all([runner.runAll(), runner.runAll()]);
    expect(runs).toBe(1);
    // And a run after the shared one has settled is a new run.
    await runner.runAll();
    expect(runs).toBe(2);
  });

  it('keeps trying, with a growing wait, until the remote is back — then stops', async () => {
    let url = path.join(root, 'nowhere.git');
    const runner = makeRunner([], () => url);
    await runner.runAll().catch(() => undefined);
    expect(runner.lastFailure()).not.toBeNull();

    const waits: number[] = [];
    let attempt = 0;
    const retry = runner.retryUntilMaintained({
      initialDelayMs: 100,
      maxDelayMs: 250,
      log: () => undefined,
      sleep: async (ms) => {
        waits.push(ms);
        attempt += 1;
        // The remote comes back before the third attempt.
        if (attempt === 3) url = upstream;
      },
    });

    // Let the loop run its attempts to completion.
    for (let i = 0; i < 50 && runner.lastFailure() !== null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runner.lastFailure()).toBeNull();
    // 100 → 200 → capped at 250; the loop asked three times and then stopped.
    expect(waits).toEqual([100, 200, 250]);

    // Stopped on success: no further sleeps arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waits).toHaveLength(3);
    retry.stop();
  });

  it('stops retrying on a failure that is not the remote — asking again would not change it', async () => {
    let url = path.join(root, 'nowhere.git');
    const runner = makeRunner(
      [step('broken', async () => ({ outcome: 'stopBoot', message: 'the template is wrong' }))],
      () => url,
    );
    await runner.runAll().catch(() => undefined);

    const waits: number[] = [];
    runner.retryUntilMaintained({
      initialDelayMs: 10,
      log: () => undefined,
      sleep: async (ms) => {
        waits.push(ms);
        url = upstream; // reachable now — and the step fails instead
      },
    });
    for (let i = 0; i < 50 && !(runner.lastFailure() ?? '').includes('template is wrong'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waits).toHaveLength(1);
    expect(runner.lastFailure()).toMatch(/template is wrong/);
  });
});
