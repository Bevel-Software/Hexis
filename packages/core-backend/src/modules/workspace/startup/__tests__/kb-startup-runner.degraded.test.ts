import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KbRemoteUnreachableError, KbStartupRunner } from '../kb-startup-runner.js';
import { NodeGitRunner } from '../../../workflow/git/node-git-runner.js';
import { GitRunError, NO_GIT_CREDENTIALS, type IGitRunner } from '../../../../shared/git.contract.js';
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

/**
 * Poll until `condition` holds. Bounded generously: each retry attempt here is
 * a real clone, which takes well over a second on a machine running the whole
 * suite, and a bound sized for an idle machine fails the test under load.
 */
async function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeRunner(steps: OnServerStart[], url: () => string, gitRunner: IGitRunner = new NodeGitRunner()) {
  return new KbStartupRunner({
    gitRunner,
    kbRepoUrl: url,
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

  it('a git that never ran is not "unreachable" either: that failure is this host, and it stops the boot', async () => {
    const noGit: IGitRunner = {
      defaultTimeoutMs: 1000,
      credentials: NO_GIT_CREDENTIALS,
      run: (async () => {
        throw new GitRunError('git ls-remote failed: spawn git ENOENT');
      }) as IGitRunner['run'],
    };
    const runner = makeRunner([], () => upstream, noGit);
    const err = await runner.runAll().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(KbRemoteUnreachableError);
    expect((err as Error).message).toMatch(/spawn git ENOENT/);
  });

  it('records its attempts to reach the remote, for the readiness answer', async () => {
    const runner = makeRunner([], () => path.join(root, 'nowhere.git'));
    expect(runner.lastRemoteContact()).toBeNull();
    await runner.runAll().catch(() => undefined);
    expect(runner.lastRemoteContact()).toMatchObject({ ok: false });

    const healthy = makeRunner([], () => upstream);
    await healthy.runAll();
    expect(healthy.lastRemoteContact()).toMatchObject({ ok: true });
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
    await waitFor(() => runner.lastFailure() === null);
    expect(runner.lastFailure()).toBeNull();
    // 100 → 200 → capped at 250; the loop asked three times and then stopped.
    expect(waits).toEqual([100, 200, 250]);

    // Stopped on success: no further sleeps arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waits).toHaveLength(3);
    retry.stop();
  });

  it('does not run again when another caller finished the phase while it slept', async () => {
    let url = path.join(root, 'nowhere.git');
    let runs = 0;
    const runner = makeRunner(
      [
        step('count', async () => {
          runs += 1;
          return { outcome: 'ok' };
        }),
      ],
      () => url,
    );
    await runner.runAll().catch(() => undefined);
    expect(runs).toBe(0);

    let slept = 0;
    runner.retryUntilMaintained({
      initialDelayMs: 10,
      log: () => undefined,
      sleep: async () => {
        slept += 1;
        // The setup save, landing while the loop sleeps: the remote is
        // reachable and the phase finishes through that caller.
        url = upstream;
        await runner.runAll();
      },
    });
    await waitFor(() => runs === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The loop woke to a finished phase and did not run it a second time.
    expect(runs).toBe(1);
    expect(slept).toBe(1);
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
    await waitFor(() => (runner.lastFailure() ?? '').includes('template is wrong'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waits).toHaveLength(1);
    expect(runner.lastFailure()).toMatch(/template is wrong/);
  });
});

describe('KbStartupRunner with a remote that rejects the credentials', () => {
  it('survives the boot as that failure, not as "unreachable" — the admin is told the token is wrong', async () => {
    // A rotated token: git exits 128 with the host's refusal. The port
    // classifies it as credentials-rejected on the way up; a boot must not
    // re-label it as a network the server cannot reach — the setup screen
    // would send the admin to check the address and the retry loop would
    // re-dial a host that will never accept the token.
    const rejecting: IGitRunner = {
      defaultTimeoutMs: 1000,
      credentials: NO_GIT_CREDENTIALS,
      run: (async () => {
        // The shape `NodeGitRunner` throws: git's words in the message (that
        // is what the boot classifies) and again in `stderr`.
        const said = "remote: Invalid username or token.\nfatal: Authentication failed for 'https://example.com/acme/kb.git/'";
        throw new GitRunError(`git ls-remote failed: Command failed: git ls-remote\n${said}`, {
          exitCode: 128,
          stderr: said,
        });
      }) as IGitRunner['run'],
    };
    const runner = makeRunner([], () => 'https://example.com/acme/kb.git', rejecting);

    const err = await runner.runAll().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KbRemoteUnreachableError);
    expect((err as KbRemoteUnreachableError).failure.kind).toBe('credentials-rejected');
    expect(runner.lastFailureKind()?.kind).toBe('credentials-rejected');
  });
});

describe('KbStartupRunner retry after a boot that survived a rejected token', () => {
  it('does not re-dial on a timer: only an unreachable remote is worth asking again unchanged', async () => {
    let dials = 0;
    const rejecting: IGitRunner = {
      defaultTimeoutMs: 1000,
      credentials: NO_GIT_CREDENTIALS,
      run: (async () => {
        dials += 1;
        const said = "fatal: Authentication failed for 'https://example.com/acme/kb.git/'";
        throw new GitRunError(`git ls-remote failed: Command failed: git ls-remote\n${said}`, {
          exitCode: 128,
          stderr: said,
        });
      }) as IGitRunner['run'],
    };
    const runner = makeRunner([], () => 'https://example.com/acme/kb.git', rejecting);
    await runner.runAll().catch(() => undefined);
    expect(runner.lastFailureKind()?.kind).toBe('credentials-rejected');
    expect(dials).toBe(1);

    const waits: number[] = [];
    const logged: string[] = [];
    const retry = runner.retryUntilMaintained({
      initialDelayMs: 5,
      log: (m) => logged.push(m),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    retry.stop();

    // No timer, no second dial: the standing failure is still there for the
    // setup screen, and the save that fixes the token runs the phase itself.
    expect(waits).toEqual([]);
    expect(dials).toBe(1);
    expect(runner.lastFailureKind()?.kind).toBe('credentials-rejected');
    expect(logged.join('\n')).toMatch(/saving the setup form retries/);
  });
});

describe('KbStartupRunner retry when the token is rejected while it sleeps', () => {
  it('stops instead of re-dialing: the setup save that failed with the rejected token owns the retry', async () => {
    // The boot fails as unreachable, so the loop starts. While it sleeps, a
    // setup save runs the phase with a token the host refuses: the standing
    // failure is now one a retry cannot change, and the loop must read that
    // AFTER the sleep, not only when it started.
    let dials = 0;
    const rejecting: IGitRunner = {
      defaultTimeoutMs: 1000,
      credentials: NO_GIT_CREDENTIALS,
      run: (async () => {
        dials += 1;
        const said = "fatal: Authentication failed for 'https://example.com/acme/kb.git/'";
        throw new GitRunError(`git ls-remote failed: Command failed: git ls-remote\n${said}`, {
          exitCode: 128,
          stderr: said,
        });
      }) as IGitRunner['run'],
    };
    let current: IGitRunner = new NodeGitRunner();
    const switching: IGitRunner = {
      defaultTimeoutMs: 1000,
      credentials: NO_GIT_CREDENTIALS,
      run: ((...args: Parameters<IGitRunner['run']>) => current.run(...args)) as IGitRunner['run'],
    };
    let url = path.join(root, 'nowhere.git');
    const runner = makeRunner([], () => url, switching);
    await runner.runAll().catch(() => undefined);
    expect(runner.lastFailureKind()?.kind).not.toBe('credentials-rejected');

    const waits: number[] = [];
    const logged: string[] = [];
    runner.retryUntilMaintained({
      initialDelayMs: 5,
      log: (m) => logged.push(m),
      sleep: async (ms) => {
        waits.push(ms);
        // The setup save, landing while the loop sleeps, with a rotated token.
        current = rejecting;
        url = 'https://example.com/acme/kb.git';
        await runner.runAll().catch(() => undefined);
      },
    });
    await waitFor(() => logged.some((m) => m.includes('asking again cannot change')));
    expect(runner.lastFailureKind()?.kind).toBe('credentials-rejected');
    // One dial: the save's. The loop did not add one of its own.
    expect(dials).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(waits).toHaveLength(1);
  });
});
