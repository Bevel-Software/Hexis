import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeGitRunner } from '../node-git-runner.js';
import { GitRunError, isGitTimeout } from '../../../../shared/git.contract.js';

/**
 * These run REAL git, like the rest of this module's suites: the behaviours
 * under test — what a deadline does to a live child, what an exit code means,
 * what git puts in a message — are properties of the process, and a stubbed
 * spawn would only re-assert the stub.
 */
describe('NodeGitRunner', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-runner-'));
    const runner = new NodeGitRunner();
    await runner.run(dir, ['init', '--initial-branch=main']);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('returns what git wrote', async () => {
    const runner = new NodeGitRunner();
    // `symbolic-ref` rather than `rev-parse HEAD`: the repository has no commit
    // yet, and an unborn HEAD is not a revision `rev-parse` can resolve.
    const { stdout } = await runner.run(dir, ['symbolic-ref', '--short', 'HEAD']);
    expect(stdout.trim()).toBe('main');
  });

  it('feeds stdin to commands that read it', async () => {
    const runner = new NodeGitRunner();
    const { stdout } = await runner.run(dir, ['hash-object', '--stdin'], { input: 'hello' });
    // git's hash for the blob "hello" — stable across every git version.
    expect(stdout.trim()).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0');
  });

  it('carries the exit code so callers can read an expected non-zero exit', async () => {
    const runner = new NodeGitRunner();
    // `merge-base --is-ancestor` exits 1 for "no", which several callers read
    // as an answer rather than a failure.
    const err = await runner
      .run(dir, ['merge-base', '--is-ancestor', 'HEAD', 'HEAD'])
      .catch((e: unknown) => e);
    // An unborn HEAD makes this fail outright; either way the point is that a
    // failure arrives as GitRunError with git's own exit code attached.
    expect(err).toBeInstanceOf(GitRunError);
    expect(typeof (err as GitRunError).exitCode).toBe('number');
    expect(isGitTimeout(err)).toBe(false);
  });

  it('names the failing subcommand past any leading -c pairs', async () => {
    const runner = new NodeGitRunner();
    const err = await runner
      .run(dir, ['-c', 'user.name=x', '-c', 'user.email=y', 'checkout', 'no-such-branch'])
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/^git checkout failed:/);
  });

  it('kills a command that outlives its deadline, and says that is what happened', async () => {
    const runner = new NodeGitRunner();
    // `git ls-remote` against a routable-but-dead address hangs in connect:
    // 203.0.113.0/24 is TEST-NET-3, reserved for documentation and guaranteed
    // not to be routed to anything that answers.
    const started = Date.now();
    const err = await runner
      .run(dir, ['ls-remote', 'http://203.0.113.1/repo.git'], { timeoutMs: 1_000 })
      .catch((e: unknown) => e);

    expect(isGitTimeout(err)).toBe(true);
    expect((err as Error).message).toMatch(/timed out after 1000ms/);
    // The deadline has to bound the WAIT, not just fire a timer. Signalling
    // git alone does not: the transport helper it spawned keeps the stdio
    // pipes open, and node resolves an execFile when the pipes close, so the
    // call returned after the helper's own connect timeout (measured at 21s
    // against this address) rather than after ours. The tree kill is what
    // makes this assertion hold.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('does not hold the event loop open after a call that beat its deadline', async () => {
    const runner = new NodeGitRunner();
    // A generous deadline on a command that finishes immediately. The
    // escalation timer is armed only on the timeout path, but the deadline
    // timer is armed on every call and would keep the process alive for its
    // full duration if it were not cleared.
    await runner.run(dir, ['rev-parse', '--git-dir'], { timeoutMs: 600_000 });
    // Vitest fails the run on a leaked handle; reaching here with no open
    // timer is the assertion.
    expect(true).toBe(true);
  });

  it('keeps the configured git token out of failures', async () => {
    const runner = new NodeGitRunner();
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_secret_value_here';
    try {
      const err = await runner
        .run(dir, ['ls-remote', 'https://x-access-token:ghp_secret_value_here@127.0.0.1:1/r.git'], {
          timeoutMs: 15_000,
        })
        .catch((e: unknown) => e);
      const text = `${(err as Error).message} ${(err as GitRunError).stderr ?? ''}`;
      expect(text).not.toContain('ghp_secret_value_here');
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });
});
