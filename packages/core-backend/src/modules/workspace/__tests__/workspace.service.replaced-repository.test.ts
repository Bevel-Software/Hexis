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

function service(
  kbRepoUrl: () => string,
  setAsideRoot?: string,
  aroundSetAside?: (workspaceId: string, move: () => Promise<void>) => Promise<void>,
  gitRunner: NodeGitRunner = new NodeGitRunner(),
) {
  return new WorkspaceService(
    workspacesRoot,
    kbRepoUrl,
    testKbContext({ branchModel: { defaultBranch: BRANCH, protectedBranches: [BRANCH] } }),
    new NodeFs(),
    gitRunner,
    setAsideRoot,
    aroundSetAside,
  );
}

/**
 * A git runner that puts two callers' reads of a working copy's address in ONE
 * order, the one that matters: both read the copy that is there, and the
 * second is handed its answer only once `afterTheFirstMove` has come.
 *
 * Two holds, because holding the second answer back is only half of it. The
 * FIRST answer is held until the second read has happened, so the first caller
 * cannot move the copy before the second has looked at it — otherwise the
 * second would read whatever replaced it, and the stale answer this is about
 * would never exist. Then the second answer is held until the first move has
 * ended. Neither can wait on the other forever: the first caller is held in its
 * read, so no move is in flight for the second to wait on, and it always reads.
 * Everything else runs as it is.
 */
function withTheSecondAddressReadHeldPastTheMove(afterTheFirstMove: Promise<void>): NodeGitRunner {
  let reads = 0;
  let secondHasRead!: () => void;
  const onceTheSecondHasRead = new Promise<void>((resolve) => {
    secondHasRead = resolve;
  });
  return new Proxy(new NodeGitRunner(), {
    get(target, prop, receiver) {
      if (prop !== 'run') return Reflect.get(target, prop, receiver);
      return async (cwd: string, args: string[], opts?: never) => {
        const answer = await target.run(cwd, args, opts);
        const readsTheAddress = args[0] === 'config' && args.includes('--get') && args.includes('remote.origin.url');
        if (!readsTheAddress) return answer;
        const mine = ++reads;
        if (mine === 1) await onceTheSecondHasRead;
        if (mine === 2) {
          secondHasRead();
          await afterTheFirstMove;
        }
        return answer;
      };
    },
  });
}

const cloneDir = () => path.join(workspacesRoot, encodeURIComponent(BRANCH), 'knowledge-base');

/** Every working copy under a set-aside root, as repo directories. */
async function setAside(setAsideRoot = path.join(root, 'replaced-working-copies')): Promise<string[]> {
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

/**
 * WHERE it is set aside is not a detail. A deployment runs from an image whose
 * filesystem is replaced on every recreate, and only the mounted volumes
 * survive that — so a working copy kept beside the workspaces root was kept
 * until the next `docker compose up` and no longer, while the screen had
 * promised the admin it was there to recover from. The composition root roots
 * this service and the KB startup phase at ONE directory under the backups
 * volume; this is the half of that the service owes.
 */
describe('where a working copy is set aside', () => {
  it('goes to the root it was given, not beside the workspaces root', async () => {
    const old = await upstream('old', 'old repository');
    const replacement = await upstream('replacement', 'new repository');
    await fs.mkdir(path.dirname(cloneDir()), { recursive: true });
    await git(root, ['clone', '-b', BRANCH, old, cloneDir()]);
    await fs.writeFile(path.join(cloneDir(), 'unpushed.md'), 'local work', 'utf8');
    await git(cloneDir(), ['add', '-A']);
    await git(cloneDir(), ['commit', '-m', 'local work']);
    // Somewhere the workspaces root cannot be reached from by walking up:
    // the backups volume, as the deployment mounts it.
    const backups = path.join(root, 'backups', 'replaced-working-copies');

    await service(() => replacement, backups).getOrCreateForBranch(BRANCH);

    const kept = await setAside(backups);
    expect(kept).toHaveLength(1);
    expect(await fs.readFile(path.join(kept[0]!, 'unpushed.md'), 'utf8')).toBe('local work');
    // And nothing was left in the place that does not outlive the container.
    expect(await setAside()).toEqual([]);
  });

  it('falls back beside the workspaces root when no root is given', async () => {
    const old = await upstream('old', 'old repository');
    const replacement = await upstream('replacement', 'new repository');
    await fs.mkdir(path.dirname(cloneDir()), { recursive: true });
    await git(root, ['clone', '-b', BRANCH, old, cloneDir()]);

    await service(() => replacement).getOrCreateForBranch(BRANCH);

    expect(await setAside()).toHaveLength(1);
  });
});

/**
 * A branch opened onto a clone of another repository sets it aside on the
 * spot, with nobody having stopped anything for it. What the deployment does
 * around the startup phase's set-asides (the commit worker held, the copy's
 * queued commits held back, its locks dropped) it is handed here to do around
 * this one.
 */
describe('what surrounds the setting aside of one working copy', () => {
  async function onTheOldRepository() {
    const old = await upstream('old', 'old repository');
    const replacement = await upstream('replacement', 'new repository');
    await fs.mkdir(path.dirname(cloneDir()), { recursive: true });
    await git(root, ['clone', '-b', BRANCH, old, cloneDir()]);
    return { old, replacement };
  }

  it('is given the working copy and the move, and the copy is where it was until the move is run', async () => {
    const { old, replacement } = await onTheOldRepository();
    const seen: string[] = [];
    const svc = service(() => replacement, undefined, async (workspaceId, move) => {
      seen.push(`before ${workspaceId}: ${(await git(cloneDir(), ['config', '--get', 'remote.origin.url'])).trim()}`);
      await move();
      seen.push(`after: ${await fs.access(cloneDir()).then(() => 'still there', () => 'gone')}`);
    });

    await svc.getOrCreateForBranch(BRANCH);

    expect(seen).toEqual([`before ${encodeURIComponent(BRANCH)}: ${old}`, 'after: gone']);
    expect(await fs.readFile(path.join(cloneDir(), 'marker.txt'), 'utf8')).toBe('new repository');
  });

  it('refuses the branch, and leaves the copy where it was, when what must happen first fails', async () => {
    const { old, replacement } = await onTheOldRepository();
    const svc = service(() => replacement, undefined, async () => {
      throw new Error('the queue could not be held back');
    });

    await expect(svc.getOrCreateForBranch(BRANCH)).rejects.toThrow('the queue could not be held back');

    expect((await git(cloneDir(), ['config', '--get', 'remote.origin.url'])).trim()).toBe(old);
    expect(await setAside()).toEqual([]);
  });

  /**
   * What surrounds the move can wait: for the commit in flight, or for the
   * startup phase, which may set this very copy aside in the meantime.
   */
  it('moves nothing, and still opens the branch, when the startup phase took the copy while it waited', async () => {
    const { replacement } = await onTheOldRepository();
    const phaseKept = path.join(root, 'kept-by-the-phase');
    const svc: WorkspaceService = service(() => replacement, undefined, async (workspaceId, move) => {
      // The phase, while this call waited: the copy moved out, and said so.
      await fs.rename(cloneDir(), phaseKept);
      svc.forgetClone(workspaceId);
      await move();
    });

    await svc.getOrCreateForBranch(BRANCH);

    expect(await fs.readFile(path.join(cloneDir(), 'marker.txt'), 'utf8')).toBe('new repository');
    // Nothing of this call's own was set aside: the phase's copy is the only one.
    expect(await setAside()).toEqual([]);
    expect(await fs.readFile(path.join(phaseKept, 'marker.txt'), 'utf8')).toBe('old repository');
  });

  it('moves it once for two callers opening the branch together, and serves both', async () => {
    const { replacement } = await onTheOldRepository();
    let moves = 0;
    const svc = service(() => replacement, undefined, async (_workspaceId, move) => {
      moves += 1;
      await move();
    });

    const [first, second] = await Promise.all([svc.getOrCreateForBranch(BRANCH), svc.getOrCreateForBranch(BRANCH)]);

    expect(moves).toBe(1);
    expect(first.repoDir).toBe(second.repoDir);
    expect(await setAside()).toHaveLength(1);
    expect(await fs.readFile(path.join(cloneDir(), 'marker.txt'), 'utf8')).toBe('new repository');
  });

  /**
   * The same two callers, in the order the test above only sometimes got. The
   * second reads the old copy's address, and is handed the answer after the
   * first has finished moving that copy — when nothing says a move is in
   * flight any more, and what sits at the path is the fresh clone the first is
   * making. It moved that too: a second set-aside, of a working copy of the
   * RIGHT repository, taken from under the clone that was writing it.
   */
  it('moves it once when the second caller comes back with the old address after the move has ended', async () => {
    const { replacement } = await onTheOldRepository();
    let moves = 0;
    let firstMoveEnded!: () => void;
    const afterTheFirstMove = new Promise<void>((resolve) => {
      firstMoveEnded = resolve;
    });
    const svc = service(
      () => replacement,
      undefined,
      async (_workspaceId, move) => {
        moves += 1;
        await move();
        firstMoveEnded();
      },
      withTheSecondAddressReadHeldPastTheMove(afterTheFirstMove),
    );

    const [first, second] = await Promise.all([svc.getOrCreateForBranch(BRANCH), svc.getOrCreateForBranch(BRANCH)]);

    expect(moves).toBe(1);
    expect(first.repoDir).toBe(second.repoDir);
    expect(await setAside()).toHaveLength(1);
    expect(await fs.readFile(path.join(cloneDir(), 'marker.txt'), 'utf8')).toBe('new repository');
    // And the clone both were served is whole: its address is the new one.
    expect((await git(cloneDir(), ['config', '--get', 'remote.origin.url'])).trim()).toBe(replacement);
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
