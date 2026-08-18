import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KbStartupRunner } from '../kb-startup-runner.js';
import { redactSecret } from '../kb-git.js';
import type { OnServerStart, ServerStartContext, StepResult } from '../on-server-start.js';

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-startup-'));
  workspacesRoot = path.join(root, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });
  upstream = path.join(root, 'upstream.git');
  await git(root, ['init', '--bare', '-b', DEFAULT_BRANCH, upstream]);
  delete process.env.KB_SAFE_BOOT;
});

afterEach(async () => {
  delete process.env.KB_SAFE_BOOT;
  await fs.rm(root, { recursive: true, force: true });
});

/** A populated upstream: one commit on the default branch, both protected refs. */
async function populatedUpstream(): Promise<void> {
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await git(seed, ['init', '-b', DEFAULT_BRANCH]);
  await fs.writeFile(path.join(seed, 'marker.txt'), 'seeded', 'utf8');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'init']);
  await git(seed, ['branch', PROTECTED[1]!]);
  await git(seed, ['remote', 'add', 'origin', upstream]);
  await git(seed, ['push', 'origin', ...PROTECTED]);
}

function makeRunner(steps: OnServerStart[], overrides: Partial<Parameters<typeof runnerOpts>[1]> = {}) {
  return new KbStartupRunner(runnerOpts(steps, overrides));
}

function runnerOpts(steps: OnServerStart[], overrides: Record<string, unknown> = {}) {
  return {
    kbRepoUrl: () => upstream,
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
    ...overrides,
  };
}

function step(name: string, run: (ctx: ServerStartContext) => Promise<StepResult>): OnServerStart {
  return { name, run };
}

async function checkout(branch: string): Promise<string> {
  const dir = path.join(root, `checkout-${branch}-${Math.random().toString(36).slice(2)}`);
  await git(root, ['clone', '-b', branch, upstream, dir]);
  return dir;
}

describe('KbStartupRunner', () => {
  it('seeds an empty remote with every protected branch before any step runs', async () => {
    const seen: string[] = [];
    await makeRunner([
      step('probe', async (ctx) => {
        for (const b of await ctx.protectedBranches()) seen.push(b.name);
        return { outcome: 'ok' };
      }),
    ]).runAll();
    expect(seen.sort()).toEqual([...PROTECTED].sort());
    for (const b of PROTECTED) {
      const dir = await checkout(b);
      expect(await fs.readFile(path.join(dir, 'seeded.md'), 'utf8')).toBe('from template');
    }
  });

  it('rejects a repository URL with embedded credentials — operator error, fail-closed', async () => {
    let stepRan = false;
    await expect(
      makeRunner(
        [step('never', async () => { stepRan = true; return { outcome: 'ok' }; })],
        { kbRepoUrl: () => 'https://alice:hunter2@example.com/kb.git' },
      ).runAll(),
    ).rejects.toThrow(/embeds credentials.*process listings/s);
    expect(stepRan).toBe(false);
  });

  it('accepts a concurrent replica\'s seed when the empty-remote seed push loses the race', async () => {
    // The WINNER lands its seed between this replica's empty ls-remote and
    // its push — buildSeedTree runs exactly in that window, which makes the
    // race deterministic with real git.
    const seen: string[] = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await makeRunner(
        [
          step('probe', async (ctx) => {
            for (const b of await ctx.protectedBranches()) seen.push(b.name);
            return { outcome: 'ok' };
          }),
        ],
        {
          buildSeedTree: async (dir: string) => {
            const winner = path.join(root, 'winner-seed');
            await fs.mkdir(winner);
            await git(winner, ['init', '-b', DEFAULT_BRANCH]);
            await fs.writeFile(path.join(winner, 'seeded.md'), 'winner content', 'utf8');
            await git(winner, ['add', '-A']);
            await git(winner, ['commit', '-m', 'winner seed']);
            await git(winner, ['branch', PROTECTED[1]!]);
            await git(winner, ['remote', 'add', 'origin', upstream]);
            await git(winner, ['push', 'origin', ...PROTECTED]);
            await fs.writeFile(path.join(dir, 'seeded.md'), 'loser content', 'utf8');
            return [];
          },
        },
      ).runAll(); // resolves — the loser accepts the winner's identical work
    } finally {
      vi.restoreAllMocks();
    }
    expect(seen.sort()).toEqual([...PROTECTED].sort());
    // The remote carries the WINNER's seed; the loser's never landed.
    for (const b of PROTECTED) {
      const dir = await checkout(b);
      expect(await fs.readFile(path.join(dir, 'seeded.md'), 'utf8')).toBe('winner content');
    }
  });

  it('applies a step\'s buffered ops before the next step runs, and commits once per branch with the notes', async () => {
    await populatedUpstream();
    const secondSaw: string[] = [];
    await makeRunner([
      step('first', async (ctx) => {
        const b = await ctx.defaultBranch();
        b.write('a/one.md', 'one');
        b.note('Add one.md');
        return { outcome: 'ok' };
      }),
      step('second', async (ctx) => {
        const b = await ctx.defaultBranch();
        // The previous step's op is REAL on disk by now.
        secondSaw.push(await fs.readFile(path.join(await b.repoDir(), 'a/one.md'), 'utf8'));
        b.write('b/two.md', 'two');
        b.note('Add two.md');
        return { outcome: 'ok' };
      }),
    ]).runAll();
    expect(secondSaw).toEqual(['one']);
    const dir = await checkout(DEFAULT_BRANCH);
    expect(await fs.readFile(path.join(dir, 'a/one.md'), 'utf8')).toBe('one');
    expect(await fs.readFile(path.join(dir, 'b/two.md'), 'utf8')).toBe('two');
    const log = await git(dir, ['log', '--format=%s%n%b', '-1']);
    expect(log).toContain('Add one.md');
    expect(log).toContain('Add two.md');
    // ONE commit carried both steps' changes.
    const count = (await git(dir, ['rev-list', '--count', 'HEAD'])).trim();
    expect(count).toBe('2'); // init + the one startup commit
  });

  it('discards a skipped step\'s ops unapplied — the tree is untouched by construction', async () => {
    await populatedUpstream();
    await makeRunner([
      step('flaky', async (ctx) => {
        (await ctx.defaultBranch()).write('never.md', 'x');
        return { outcome: 'skipped', reason: 'precondition unmet' };
      }),
      step('after', async (ctx) => {
        const repo = await (await ctx.defaultBranch()).repoDir();
        expect(await fs.access(path.join(repo, 'never.md')).then(() => true, () => false)).toBe(false);
        return { outcome: 'ok' };
      }),
    ]).runAll();
    const dir = await checkout(DEFAULT_BRANCH);
    await expect(fs.access(path.join(dir, 'never.md'))).rejects.toThrow();
  });

  it('an unhandled step throw stops the boot with the step named; nothing commits', async () => {
    await populatedUpstream();
    await expect(
      makeRunner([
        step('good', async (ctx) => {
          const b = await ctx.defaultBranch();
          b.write('good.md', 'ok');
          return { outcome: 'ok' };
        }),
        step('broken', async () => {
          throw new Error('ECONNREFUSED somewhere');
        }),
      ]).runAll(),
    ).rejects.toThrow(/step "broken" failed: .*ECONNREFUSED/);
    // The good step's APPLIED but uncommitted work never reached the remote.
    const dir = await checkout(DEFAULT_BRANCH);
    await expect(fs.access(path.join(dir, 'good.md'))).rejects.toThrow();
  });

  it('stopBoot is the deliberate kill switch and carries the message', async () => {
    await populatedUpstream();
    await expect(
      makeRunner([
        step('guard', async () => ({ outcome: 'stopBoot', message: 'KB layout is newer than this build' })),
      ]).runAll(),
    ).rejects.toThrow(/stopped the boot: KB layout is newer/);
  });

  it('KB_SAFE_BOOT=1 abandons the phase on failure, resets uncommitted work, and boots', async () => {
    await populatedUpstream();
    const originSha = (await git(path.join(root, '.seed'), ['rev-parse', 'HEAD'])).trim();
    process.env.KB_SAFE_BOOT = '1';
    await makeRunner([
      step('good', async (ctx) => {
        (await ctx.defaultBranch()).write('good.md', 'ok');
        return { outcome: 'ok' };
      }),
      step('broken', async () => {
        throw new Error('boom');
      }),
    ]).runAll(); // resolves — the server boots
    // The applied-but-uncommitted change was reset; the remote never saw it.
    const local = path.join(workspacesRoot, DEFAULT_BRANCH, 'knowledge-base');
    await expect(fs.access(path.join(local, 'good.md'))).rejects.toThrow();
    // The rollback lands EXACTLY on the pre-phase sha recorded at clone time.
    expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(originSha);
    const dir = await checkout(DEFAULT_BRANCH);
    await expect(fs.access(path.join(dir, 'good.md'))).rejects.toThrow();
  });

  it('KB_SAFE_BOOT rollback undoes even a created-but-unpushed finalize commit (reset to the pre-phase sha)', async () => {
    await populatedUpstream();
    const originSha = (await git(path.join(root, '.seed'), ['rev-parse', 'HEAD'])).trim();
    // A pre-receive hook that refuses every push: a POLICY refusal, not the
    // concurrent-replica carve-out — finalize rethrows AFTER committing, and
    // safe boot must roll that commit back or it strands locally forever.
    const hookPath = path.join(upstream, 'hooks', 'pre-receive');
    await fs.mkdir(path.dirname(hookPath), { recursive: true });
    await fs.writeFile(hookPath, '#!/bin/sh\necho "policy says no" >&2\nexit 1\n', { mode: 0o755 });
    process.env.KB_SAFE_BOOT = '1';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await makeRunner([
        step('write', async (ctx) => {
          const b = await ctx.defaultBranch();
          b.write('managed.md', 'phase');
          b.note('Add managed.md');
          return { outcome: 'ok' };
        }),
      ]).runAll(); // resolves — safe boot abandons after the push refusal
    } finally {
      vi.restoreAllMocks();
    }
    const local = path.join(workspacesRoot, DEFAULT_BRANCH, 'knowledge-base');
    expect((await git(local, ['rev-parse', 'HEAD'])).trim()).toBe(originSha);
    await expect(fs.access(path.join(local, 'managed.md'))).rejects.toThrow();
  });

  it("finalize stages only the phase's paths — pre-existing dirt in a surviving clone stays out of the commit and in the tree", async () => {
    await populatedUpstream();
    // Materialize the surviving clone, then drop operator dirt into it.
    await makeRunner([
      step('touch', async (ctx) => {
        await (await ctx.defaultBranch()).repoDir();
        return { outcome: 'ok' };
      }),
    ]).runAll();
    const local = path.join(workspacesRoot, DEFAULT_BRANCH, 'knowledge-base');
    await fs.writeFile(path.join(local, 'stray.md'), 'operator dirt', 'utf8');

    await makeRunner([
      step('write', async (ctx) => {
        const b = await ctx.defaultBranch();
        b.write('managed.md', 'phase');
        b.note('Add managed.md');
        return { outcome: 'ok' };
      }),
    ]).runAll();

    // The commit carries ONLY the phase's path.
    const committed = (await git(local, ['show', '--name-only', '--format=', 'HEAD'])).trim();
    expect(committed.split('\n')).toEqual(['managed.md']);
    const dir = await checkout(DEFAULT_BRANCH);
    expect(await fs.readFile(path.join(dir, 'managed.md'), 'utf8')).toBe('phase');
    await expect(fs.access(path.join(dir, 'stray.md'))).rejects.toThrow();
    // The dirt remains in the working tree, uncommitted — not this phase's to touch.
    expect(await fs.readFile(path.join(local, 'stray.md'), 'utf8')).toBe('operator dirt');
    expect((await git(local, ['status', '--porcelain', '--', 'stray.md'])).trim()).toBe('?? stray.md');
  });

  it('draft branches are reachable AND writable through allBranches()', async () => {
    await populatedUpstream();
    const seed = path.join(root, '.seed');
    await git(seed, ['checkout', '-b', 'alice/draft']);
    await fs.writeFile(path.join(seed, 'draft.md'), 'draft', 'utf8');
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '-m', 'draft work']);
    await git(seed, ['push', 'origin', 'alice/draft']);

    await makeRunner([
      step('uniform', async (ctx) => {
        for (const b of await ctx.allBranches()) {
          expect(typeof b.isProtected).toBe('boolean');
          b.write('uniform.md', `maintained ${b.name}`);
          b.note(`Maintain ${b.name}`);
        }
        return { outcome: 'ok' };
      }),
    ]).runAll();

    const draft = await checkout('alice/draft');
    expect(await fs.readFile(path.join(draft, 'uniform.md'), 'utf8')).toBe('maintained alice/draft');
    expect(await fs.readFile(path.join(draft, 'draft.md'), 'utf8')).toBe('draft');
  });

  it('refuses op paths that escape, target .git, or traverse a symlink', async () => {
    await populatedUpstream();
    for (const bad of ['../outside.md', '.git/hooks/x', '']) {
      await expect(
        makeRunner([
          step('hostile', async (ctx) => {
            (await ctx.defaultBranch()).write(bad, 'x');
            return { outcome: 'ok' };
          }),
        ]).runAll(),
      ).rejects.toThrow(/op path/);
    }
  });

  it('self-skips when the branch model is set but the repository URL is not', async () => {
    let stepRan = false;
    // A partially set-up deployment (branch model saved, repo URL not yet):
    // running would `ls-remote ''` and fail forever, with the setup screen
    // that could fix it unreachable behind the failed boot.
    await makeRunner(
      [step('never', async () => { stepRan = true; return { outcome: 'ok' }; })],
      { kbRepoUrl: () => '' },
    ).runAll(); // resolves — nothing to maintain yet
    expect(stepRan).toBe(false);
  });

  it("discards a skipped step's notes with its ops — a later commit never carries them", async () => {
    await populatedUpstream();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await makeRunner([
        step('flaky', async (ctx) => {
          const b = await ctx.defaultBranch();
          b.write('never.md', 'x');
          b.note('Never say this');
          return { outcome: 'skipped', reason: 'precondition unmet' };
        }),
        step('after', async (ctx) => {
          const b = await ctx.defaultBranch();
          b.write('after.md', 'y');
          b.note('Add after.md');
          return { outcome: 'ok' };
        }),
      ]).runAll();
    } finally {
      vi.restoreAllMocks();
    }
    const dir = await checkout(DEFAULT_BRANCH);
    const log = await git(dir, ['log', '--format=%s%n%b', '-1']);
    expect(log).toContain('Add after.md');
    expect(log).not.toContain('Never say this');
  });

  it('the push-race rollback undoes exactly the startup commit — a pre-existing AHEAD commit survives', async () => {
    await populatedUpstream();
    // Materialize the clone, then give it a committed-but-unpushed (AHEAD)
    // commit — the crash-before-push state ensureClone deliberately preserves.
    await makeRunner([
      step('touch', async (ctx) => {
        await (await ctx.defaultBranch()).repoDir();
        return { outcome: 'ok' };
      }),
    ]).runAll();
    const local = path.join(workspacesRoot, DEFAULT_BRANCH, 'knowledge-base');
    await fs.writeFile(path.join(local, 'unpushed.md'), 'precious', 'utf8');
    await git(local, ['add', '-A']);
    await git(local, ['commit', '-m', 'committed but unpushed']);

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await makeRunner([
        step('dirty-and-race', async (ctx) => {
          const b = await ctx.defaultBranch();
          b.write('startup.md', 'maintenance');
          b.note('Add startup.md');
          // A concurrent replica lands its own commit upstream AFTER this
          // runner's fetch, so the finalize push is rejected non-fast-forward.
          const other = await checkout(DEFAULT_BRANCH);
          await fs.writeFile(path.join(other, 'winner.md'), 'replica won', 'utf8');
          await git(other, ['add', '-A']);
          await git(other, ['commit', '-m', 'replica commit']);
          await git(other, ['push', 'origin', DEFAULT_BRANCH]);
          return { outcome: 'ok' };
        }),
      ]).runAll(); // resolves — the carve-out rolls back and continues
    } finally {
      vi.restoreAllMocks();
    }
    // The rollback undid the startup commit and ONLY it: the AHEAD commit is
    // still HEAD (a reset to origin/<branch> would have discarded it too).
    expect(await fs.readFile(path.join(local, 'unpushed.md'), 'utf8')).toBe('precious');
    expect((await git(local, ['log', '--format=%s', '-1'])).trim()).toBe('committed but unpushed');
    expect(await fs.access(path.join(local, 'startup.md')).then(() => true, () => false)).toBe(false);
  });

  it('a surviving clone that is AHEAD keeps its unpushed commit — not this phase\'s to discard', async () => {
    await populatedUpstream();
    // First pass touches the branch so the clone exists (handles are lazy —
    // a pass that never asks for repoDir never clones).
    await makeRunner([
      step('touch', async (ctx) => {
        await (await ctx.defaultBranch()).repoDir();
        return { outcome: 'ok' };
      }),
    ]).runAll();
    const local = path.join(workspacesRoot, DEFAULT_BRANCH, 'knowledge-base');
    // A crash-before-push scenario: a committed local change origin never got.
    await fs.writeFile(path.join(local, 'unpushed.md'), 'precious', 'utf8');
    await git(local, ['add', '-A']);
    await git(local, ['commit', '-m', 'committed but unpushed']);

    await makeRunner([step('noop', async () => ({ outcome: 'ok' }))]).runAll();
    expect(await fs.readFile(path.join(local, 'unpushed.md'), 'utf8')).toBe('precious');
  });
});

describe('redactSecret', () => {
  it('scrubs the configured token wherever it appears', () => {
    const prev = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_supersecret';
    try {
      expect(redactSecret('fatal: ghp_supersecret was rejected')).toBe('fatal: *** was rejected');
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = prev;
    }
  });

  it('scrubs URL userinfo — a user:pass@ remote must not leak the password', () => {
    expect(redactSecret("fetch of 'https://alice:hunter2@example.com/kb.git' failed")).toBe(
      "fetch of 'https://***@example.com/kb.git' failed",
    );
    // A plain URL is untouched.
    expect(redactSecret('https://example.com/kb.git')).toBe('https://example.com/kb.git');
  });
});
