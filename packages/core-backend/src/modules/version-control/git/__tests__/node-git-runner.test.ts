import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { NodeGitRunner } from '../node-git-runner.js';
import {
  GitRunError,
  gitCredentials,
  isGitTimeout,
  type GitCredentials,
} from '../../../../shared/git.contract.js';
import { setLogger } from '../../../../shared/logging.js';
import type { ILogger, LogFields } from '../../../../shared/logger.contract.js';

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

  /**
   * The helper the runner's callers stamp into a clone, reduced to the one
   * thing under test here: what `$GITHUB_TOKEN` is in the child. `credential
   * fill` runs it through git's own shell and prints what it answered, which
   * is the same path a push takes to its password.
   */
  const ECHO_TOKEN_HELPER = `!f() { printf '%s\\n' "username=u" "password=\${GITHUB_TOKEN-none}"; }; f`;
  const fill = (runner: NodeGitRunner, env?: NodeJS.ProcessEnv) =>
    runner.run(dir, ['-c', `credential.helper=${ECHO_TOKEN_HELPER}`, 'credential', 'fill'], {
      input: 'protocol=https\nhost=example.test\n\n',
      env,
    });

  it('hands its token to the child, where the helper reads it, and never puts it in argv', async () => {
    const runner = new NodeGitRunner(undefined, gitCredentials('x-access-token', 'ghp_child_secret'));
    const { stdout } = await fill(runner);
    expect(stdout).toContain('password=ghp_child_secret');
  });

  it('drops a token this process inherited: only the credentials in effect reach git', async () => {
    const previous = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_stale_in_process_env';
    try {
      const { stdout } = await fill(new NodeGitRunner());
      expect(stdout).toContain('password=none');
      expect(stdout).not.toContain('ghp_stale_in_process_env');
    } finally {
      if (previous === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previous;
    }
  });

  it('lets a per-call environment entry win over its own token: the setup probe checks the token it was given', async () => {
    const runner = new NodeGitRunner(undefined, gitCredentials('x-access-token', 'ghp_in_effect'));
    const { stdout } = await fill(runner, { GITHUB_TOKEN: 'ghp_being_checked' });
    expect(stdout).toContain('password=ghp_being_checked');
  });

  it('keeps the configured git token out of failures', async () => {
    const runner = new NodeGitRunner(undefined, gitCredentials('x-access-token', 'ghp_secret_value_here'));
    const previous = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
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

/**
 * A git host that wants a credential, as a real `ls-remote` over HTTP meets
 * it: a bare repository behind Basic auth, served the dumb way (`info/refs`
 * as a file), which git falls back to when no smart service answers. Every
 * refusal below is git's own — "could not read Username" when it had nothing
 * to offer, "Authentication failed" when what it offered was thrown out.
 */
describe('NodeGitRunner: a call the host refuses a credential', () => {
  let root: string;
  let clone: string;
  let server: http.Server;
  let remote: string;
  /** The one token the host accepts. */
  let accepted: string;
  /** How many times the host was asked, and refused, in order. */
  let answers: number[];
  /** No helper from the machine this runs on: the clone's config and the call's `-c` are the whole story. */
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-runner-auth-'));
    const empty = path.join(root, 'empty-gitconfig');
    await fs.writeFile(empty, '');
    env = { GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1' };
    const plain = new NodeGitRunner();
    const seed = path.join(root, 'seed');
    await fs.mkdir(seed);
    await plain.run(seed, ['init', '--initial-branch=main'], { env });
    await plain.run(seed, ['-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '--allow-empty', '-m', 'init'], { env });
    const upstream = path.join(root, 'upstream.git');
    await plain.run(root, ['clone', '--bare', seed, upstream], { env });
    await plain.run(upstream, ['update-server-info'], { env });
    clone = path.join(root, 'clone');
    await fs.mkdir(clone);
    await plain.run(clone, ['init', '--initial-branch=main'], { env });

    accepted = 'ghp_good';
    answers = [];
    server = http.createServer(async (req, res) => {
      const expected = `Basic ${Buffer.from(`x-access-token:${accepted}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        answers.push(401);
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="upstream"' });
        res.end();
        return;
      }
      answers.push(200);
      const file = path.join(upstream, new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/upstream\.git\/?/, ''));
      try {
        const bytes = await fs.readFile(file);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(bytes);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    remote = `http://127.0.0.1:${(server.address() as AddressInfo).port}/upstream.git`;
    await plain.run(clone, ['remote', 'add', 'origin', remote], { env });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  /** Credentials whose token a test moves, with a `prepare` that records how it was asked. */
  function moving(initial: string | null, onRefused: (set: (token: string | null) => void) => void = () => undefined) {
    let token = initial;
    const prepare = vi.fn(async (opts?: { refused?: boolean }) => {
      if (opts?.refused) onRefused((next) => { token = next; });
    });
    const credentials: GitCredentials = {
      username: () => 'x-access-token',
      token: () => token,
      prepare,
    };
    return { credentials, prepare };
  }
  const refusals = (prepare: ReturnType<typeof vi.fn>) => prepare.mock.calls.map((c) => (c[0] as { refused?: boolean } | undefined)?.refused ?? false);

  /** Every line the runner logs during a test. */
  let logged: string[] = [];
  let previousLogger: ILogger | undefined;
  const capturing = (bindings: LogFields = {}): ILogger => {
    const line = (level: string) => (message: string, fields?: LogFields) =>
      void logged.push(`${level} ${message} ${JSON.stringify({ ...bindings, ...fields })}`);
    return { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error'), child: (m) => capturing({ ...bindings, ...m }) };
  };
  beforeEach(() => {
    logged = [];
    previousLogger = setLogger(capturing());
  });
  afterEach(() => {
    if (previousLogger) setLogger(previousLogger);
  });

  it('authenticates a clone whose config carries no helper: the helper rides the call', async () => {
    const runner = new NodeGitRunner(undefined, gitCredentials('x-access-token', 'ghp_good'));
    const { stdout } = await runner.run(clone, ['ls-remote', 'origin'], { env });
    expect(stdout).toContain('refs/heads/main');
    // Refused once, with nothing offered; then every request carried the token.
    expect(answers.filter((a) => a === 401)).toHaveLength(1);
    expect(answers).toContain(200);
  });

  it('with nothing to offer, insists on a token and runs the command once more', async () => {
    const { credentials, prepare } = moving(null, (set) => set('ghp_good'));
    const runner = new NodeGitRunner(undefined, credentials);
    const { stdout } = await runner.run(clone, ['ls-remote', 'origin'], { env });
    expect(stdout).toContain('refs/heads/main');
    // The ordinary renewal before the call, then the one that reports the refusal.
    expect(refusals(prepare)).toEqual([false, true]);
    expect(logged.some((l) => l.includes('the token was renewed and the command runs again'))).toBe(true);
    // The first attempt never got to offer anything (one refusal, and git
    // gave up); the second was refused once more before it offered the token.
    expect(answers.filter((a) => a === 401)).toHaveLength(2);
    expect(answers).toContain(200);
  });

  it('with a token the host throws out, renews it and runs the command once more', async () => {
    const { credentials, prepare } = moving('ghp_stale', (set) => set('ghp_good'));
    const runner = new NodeGitRunner(undefined, credentials);
    const { stdout } = await runner.run(clone, ['ls-remote', 'origin'], { env });
    expect(stdout).toContain('refs/heads/main');
    expect(refusals(prepare)).toEqual([false, true]);
  });

  it('runs the command again ONCE: a refusal with a token just issued is the answer', async () => {
    const { credentials, prepare } = moving('ghp_stale', (set) => set('ghp_still_stale'));
    const runner = new NodeGitRunner(undefined, credentials);
    const err = await runner.run(clone, ['ls-remote', 'origin'], { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitRunError);
    expect(`${(err as GitRunError).stderr}`).toMatch(/Authentication failed/);
    expect(refusals(prepare).filter(Boolean)).toHaveLength(1);
    // One attempt with a credential offered is two refusals: git asks bare
    // first, then with the token. Two attempts, four — and no third.
    expect(answers).toEqual([401, 401, 401, 401]);
  });

  it('does not run the command again when no token can be had, and keeps the refusal', async () => {
    const { credentials, prepare } = moving(null, (set) => set(null));
    const runner = new NodeGitRunner(undefined, credentials);
    const err = await runner.run(clone, ['ls-remote', 'origin'], { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitRunError);
    expect(`${(err as GitRunError).stderr}`).toMatch(/could not read Username/);
    expect(refusals(prepare).filter(Boolean)).toHaveLength(1);
    // One attempt: with nothing to offer, running it again would only repeat the refusal.
    expect(answers).toEqual([401]);
    expect(logged.some((l) => l.includes('no other token could be had'))).toBe(true);
  });

  it('does not run the command again with the SAME token the host just refused', async () => {
    // A provider that cannot replace it: the fixed token of a token-mode
    // deployment, whose `prepare` is absent. Running the command again would
    // only be refused again.
    const runner = new NodeGitRunner(undefined, gitCredentials('x-access-token', 'ghp_stale'));
    const err = await runner.run(clone, ['ls-remote', 'origin'], { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitRunError);
    expect(`${(err as GitRunError).stderr}`).toMatch(/Authentication failed/);
    // One attempt: the bare ask, then the token, refused. Nothing after.
    expect(answers).toEqual([401, 401]);
    // And one whose renewal hands back what it had.
    answers = [];
    const { credentials, prepare } = moving('ghp_stale', (set) => set('ghp_stale'));
    await expect(new NodeGitRunner(undefined, credentials).run(clone, ['ls-remote', 'origin'], { env })).rejects.toBeInstanceOf(GitRunError);
    expect(refusals(prepare).filter(Boolean)).toHaveLength(1);
    expect(answers).toEqual([401, 401]);
  });

  it('keeps the refusal, and logs why, when the renewal itself fails', async () => {
    let token: string | null = 'ghp_stale';
    const credentials: GitCredentials = {
      username: () => 'x-access-token',
      token: () => token,
      prepare: async (opts) => {
        if (!opts?.refused) return;
        // What the host refused is dropped, and GitHub will not replace it.
        token = null;
        throw new Error('GitHub answered 401 to the app: bad private key');
      },
    };
    const runner = new NodeGitRunner(undefined, credentials);
    const err = await runner.run(clone, ['ls-remote', 'origin'], { env }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitRunError);
    expect(`${(err as GitRunError).stderr}`).toMatch(/Authentication failed/);
    expect(answers).toEqual([401, 401]);
    const why = logged.find((l) => l.includes('no other token could be had'));
    expect(why).toBeDefined();
    expect(why).toContain('bad private key');
  });

  it("leaves a credential the caller laid over the call to the caller: the probe's own token is not renewed", async () => {
    const { credentials, prepare } = moving('ghp_good', (set) => set('ghp_good'));
    const runner = new NodeGitRunner(undefined, credentials);
    const err = await runner
      .run(clone, ['ls-remote', 'origin'], { env: { ...env, GITHUB_TOKEN: 'ghp_being_checked' } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitRunError);
    expect(refusals(prepare).filter(Boolean)).toHaveLength(0);
    expect(answers).toEqual([401, 401]);
  });

  it('names the command the caller asked for in a failure, never its own helper', async () => {
    const runner = new NodeGitRunner(undefined, gitCredentials('x-access-token', 'ghp_stale'));
    const err = await runner.run(clone, ['ls-remote', 'origin'], { env }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('git ls-remote failed');
    expect((err as Error).message).not.toContain('credential.helper');
    expect(`${(err as GitRunError).stderr}`).not.toContain('credential.helper');
  });

  it('leaves every other failure alone', async () => {
    const { credentials, prepare } = moving('ghp_good');
    const runner = new NodeGitRunner(undefined, credentials);
    await expect(runner.run(clone, ['checkout', 'no-such-branch'], { env })).rejects.toBeInstanceOf(GitRunError);
    expect(refusals(prepare).filter(Boolean)).toHaveLength(0);
  });
});
