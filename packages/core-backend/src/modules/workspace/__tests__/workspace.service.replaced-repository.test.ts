import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceService } from '../workspace.service.js';
import { NodeGitRunner } from '../../workflow/git/node-git-runner.js';

const execFileAsync = promisify(execFile);

/**
 * A working copy left on disk by a deployment that has since been pointed at
 * a DIFFERENT repository.
 *
 * The workspace service adopts whatever clone it finds on disk, and a clone
 * fetches through the address stored in its own `remote.origin.url` — so an
 * adopted one of the repository that was replaced answers "repository not
 * found" on every fetch from then on, with nothing to re-clone it. It is set
 * aside and cloned fresh instead.
 *
 * SET ASIDE, never deleted — the same rule, and the same destination, as the
 * KB startup phase's sweep. This path has reached no remote of its own: it
 * runs wherever the address is stored but unproven (a gated boot, a
 * break-glass start, a save that changed the address before the phase got to
 * it), so a mistyped host name must not cost anyone commits that exist
 * nowhere else.
 */

const BRANCH = 'main';

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
let workspacesRoot: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-replaced-'));
  workspacesRoot = path.join(root, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A bare repository with one commit on `main`, whose file says `marker`. */
async function upstream(name: string, marker: string): Promise<string> {
  const bare = path.join(root, `${name}.git`);
  await git(root, ['init', '--bare', '-b', BRANCH, bare]);
  const seed = path.join(root, `.seed-${name}`);
  await fs.mkdir(seed);
  await git(seed, ['init', '-b', BRANCH]);
  await fs.writeFile(path.join(seed, 'marker.txt'), marker, 'utf8');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'init']);
  await git(seed, ['remote', 'add', 'origin', bare]);
  await git(seed, ['push', 'origin', BRANCH]);
  return bare;
}

function service(kbRepoUrl: () => string) {
  return new WorkspaceService(
    workspacesRoot,
    kbRepoUrl,
    testKbContext({ branchModel: { defaultBranch: BRANCH, protectedBranches: [BRANCH] } }),
    new NodeFs(),
    new NodeGitRunner(),
  );
}

const cloneDir = () => path.join(workspacesRoot, encodeURIComponent(BRANCH), 'knowledge-base');

/** Every working copy under the set-aside root, as repo directories. */
async function setAside(): Promise<string[]> {
  const setAsideRoot = path.join(root, 'replaced-working-copies');
  const stamps = await fs.readdir(setAsideRoot).catch(() => [] as string[]);
  const kept: string[] = [];
  for (const stamp of stamps) {
    for (const id of await fs.readdir(path.join(setAsideRoot, stamp))) {
      kept.push(path.join(setAsideRoot, stamp, id));
    }
  }
  return kept;
}

describe('a working copy of a repository that was replaced', () => {
  it('is set aside and cloned fresh from the configured address', async () => {
    const old = await upstream('old', 'old repository');
    const replacement = await upstream('replacement', 'new repository');
    // A clone of the OLD repository, sitting on disk from before the change.
    await fs.mkdir(path.dirname(cloneDir()), { recursive: true });
    await git(root, ['clone', '-b', BRANCH, old, cloneDir()]);

    await service(() => replacement).getOrCreateForBranch(BRANCH);

    expect((await git(cloneDir(), ['config', '--get', 'remote.origin.url'])).trim()).toBe(replacement);
    expect(await fs.readFile(path.join(cloneDir(), 'marker.txt'), 'utf8')).toBe('new repository');
  });

  it('keeps the work that was only ever committed there, in the set-aside folder', async () => {
    const old = await upstream('old', 'old repository');
    const replacement = await upstream('replacement', 'new repository');
    await fs.mkdir(path.dirname(cloneDir()), { recursive: true });
    await git(root, ['clone', '-b', BRANCH, old, cloneDir()]);
    // Committed here and pushed nowhere. The address may yet turn out to be a
    // typo, so this is the last copy of it in the world.
    await fs.writeFile(path.join(cloneDir(), 'unpushed.md'), 'local work', 'utf8');
    await git(cloneDir(), ['add', '-A']);
    await git(cloneDir(), ['commit', '-m', 'local work']);
    const head = (await git(cloneDir(), ['rev-parse', 'HEAD'])).trim();

    await service(() => replacement).getOrCreateForBranch(BRANCH);

    const kept = await setAside();
    expect(kept).toHaveLength(1);
    // Still a repository, still holding the commit, still reachable by hand:
    // `git log` there shows it and `git push <address> <branch>` sends it on.
    expect((await git(kept[0]!, ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await fs.readFile(path.join(kept[0]!, 'unpushed.md'), 'utf8')).toBe('local work');
    // And the fresh clone really is of the new repository.
    expect(await fs.readFile(path.join(cloneDir(), 'marker.txt'), 'utf8')).toBe('new repository');
  });

  it('leaves a clone of the configured repository exactly where it is', async () => {
    const configured = await upstream('configured', 'configured');
    await fs.mkdir(path.dirname(cloneDir()), { recursive: true });
    await git(root, ['clone', '-b', BRANCH, configured, cloneDir()]);
    // Committed here and never pushed: a needless re-clone would lose it.
    await fs.writeFile(path.join(cloneDir(), 'unpushed.md'), 'local work', 'utf8');
    await git(cloneDir(), ['add', '-A']);
    await git(cloneDir(), ['commit', '-m', 'local work']);
    const head = (await git(cloneDir(), ['rev-parse', 'HEAD'])).trim();

    await service(() => configured).getOrCreateForBranch(BRANCH);

    expect((await git(cloneDir(), ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await setAside()).toEqual([]);
  });

  it('keeps a clone whose address differs only in spelling', async () => {
    const configured = await upstream('configured', 'configured');
    await fs.mkdir(path.dirname(cloneDir()), { recursive: true });
    await git(root, ['clone', '-b', BRANCH, configured, cloneDir()]);
    await fs.writeFile(path.join(cloneDir(), 'unpushed.md'), 'local work', 'utf8');
    await git(cloneDir(), ['add', '-A']);
    await git(cloneDir(), ['commit', '-m', 'local work']);
    const head = (await git(cloneDir(), ['rev-parse', 'HEAD'])).trim();

    // The same path with a trailing slash — the same repository.
    await service(() => `${configured}/`).getOrCreateForBranch(BRANCH);

    expect((await git(cloneDir(), ['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await setAside()).toEqual([]);
  });

  it('keeps a clone when the process does not know where the repository is', async () => {
    const configured = await upstream('configured', 'configured');
    await fs.mkdir(path.dirname(cloneDir()), { recursive: true });
    await git(root, ['clone', '-b', BRANCH, configured, cloneDir()]);

    // Nothing configured yet: "could not tell" is no reason to move work.
    await service(() => '').getOrCreateForBranch(BRANCH);

    expect((await git(cloneDir(), ['config', '--get', 'remote.origin.url'])).trim()).toBe(configured);
    expect(await setAside()).toEqual([]);
  });
});

describe('forgetClone', () => {
  it('drops the cached directory, so the next open clones again', async () => {
    const configured = await upstream('configured', 'configured');
    const svc = service(() => configured);
    await svc.getOrCreateForBranch(BRANCH);
    // What the KB startup phase does to a clone of another repository: moves
    // it out of the workspaces root and says so.
    await fs.rm(cloneDir(), { recursive: true, force: true });
    svc.forgetClone(encodeURIComponent(BRANCH));

    await svc.getOrCreateForBranch(BRANCH);

    expect(await fs.readFile(path.join(cloneDir(), 'marker.txt'), 'utf8')).toBe('configured');
  });
});
