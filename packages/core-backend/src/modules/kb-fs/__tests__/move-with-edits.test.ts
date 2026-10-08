import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { GitService } from '../../workflow/git/git.service.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { LockingFilesystem, MoveLockedError, MoveRacedError, MoveUndoError } from '../locking-filesystem.js';

/**
 * `LockingFilesystem.moveWithEdits` — `move_file` with link rewriting: the
 * move and every link edit in ONE commit, which git reads as a rename; and,
 * when any lock is out of reach, nothing changed at all. Committed through the
 * real `GitService.commitChanges` on a real repository.
 */

const exec = promisify(execFile);
const KB = 'knowledge-base';
const WS = 'ws-move';
const USER: AuthUser = { id: 'u-alice', name: 'Alice', email: 'alice@bevel.software' };

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x.com' },
  });
  return stdout;
}

let root: string;
let repo: string;
let workflow: IWorkflowService;
let lockedPaths: Set<string>;

async function put(rel: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await fs.writeFile(path.join(repo, rel), content);
}

const read = (rel: string) => fs.readFile(path.join(repo, rel), 'utf8');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-move-edits-'));
  repo = path.join(root, KB);
  await fs.mkdir(repo, { recursive: true });
  await git(repo, ['init', '-b', 'feature-test']);
  await git(repo, ['config', 'user.email', 'test@bevel.local']);
  await git(repo, ['config', 'user.name', 'Test Runner']);
  await put('Projects/A/One.md', '---\nnodeType: "[Task](../../NodeTypes/Task.md)"\nid: one\n---\n\n# One\nSee [two](Two.md).\n' + 'body line\n'.repeat(20));
  await put('Projects/A/Two.md', '# Two\n' + 'two line\n'.repeat(20));
  await put('Projects/A/pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  await put('Index.md', '[one](Projects/A/One.md)\n');
  await put('NodeTypes/Task.md', '# Task\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'seed']);

  const svc = new GitService(
    { getWorkspacePath: async () => root } as unknown as WorkspaceService,
    (() => {
      const hooks = new WorkflowHooks();
      hooks.onCommitValidation(vi.fn(async () => ({ ok: true, mustFix: [], warnings: [], rawOutput: '' })));
      return hooks;
    })(),
    testKbContext({ kbDirName: KB }),
  );
  lockedPaths = new Set();
  workflow = {
    acquireLock: vi.fn(async (_w: string, _b: string, p: string) =>
      lockedPaths.has(p)
        ? { acquired: false, lock: { holderName: 'Bob' } }
        : { acquired: true, lock: { holderName: 'Alice' } }),
    releaseLock: vi.fn(async () => null),
    releaseLockNoCommit: vi.fn(async () => undefined),
    releaseLockUntouched: vi.fn(async () => undefined),
    commitChanges: vi.fn((w: string, u: AuthUser, s: string, paths?: string[]) => svc.commitChanges(w, u, s, paths)),
  } as unknown as IWorkflowService;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const fsLayer = (validateWrite?: (p: string, content: unknown) => Promise<void>) =>
  new LockingFilesystem(
    { basePath: root, contained: true },
    { workflow, workspaceId: WS, branch: 'feature-test', user: USER, kbDirName: KB, ...(validateWrite ? { validateWrite } : {}) },
  );

/** The paths each release kind was called with. */
const released = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2] as string).sort();

const edits = () => [
  {
    path: `${KB}/Topics/Deep/A/One.md`,
    lockAt: `${KB}/Projects/A/One.md`,
    content: '---\nnodeType: "[Task](../../../NodeTypes/Task.md)"\nid: one\n---\n\n# One\nSee [two](Two.md).\n' + 'body line\n'.repeat(20),
  },
  { path: `${KB}/Index.md`, lockAt: `${KB}/Index.md`, content: '[one](Topics/Deep/A/One.md)\n' },
];

describe('LockingFilesystem.moveWithEdits', () => {
  it('lands the folder move and every edit as ONE commit that git reads as renames', async () => {
    const before = (await git(repo, ['rev-list', '--count', 'HEAD'])).trim();
    await fsLayer().moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A');

    expect((await git(repo, ['rev-list', '--count', 'HEAD'])).trim()).toBe(String(Number(before) + 1));
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');
    const stat = (await git(repo, ['show', '-M', '--name-status', '--format=%s', 'HEAD'])).trim().split('\n');
    expect(stat[0]).toBe('Move A');
    const rows = stat.slice(1).filter(Boolean).map((l) => l.split('\t'));
    expect(rows.map((r) => [r[0].replace(/\d+$/, ''), ...r.slice(1)]).sort()).toEqual([
      ['M', 'Index.md'],
      ['R', 'Projects/A/One.md', 'Topics/Deep/A/One.md'],
      ['R', 'Projects/A/Two.md', 'Topics/Deep/A/Two.md'],
      ['R', 'Projects/A/pic.png', 'Topics/Deep/A/pic.png'],
    ]);
    expect(await read('Index.md')).toBe('[one](Topics/Deep/A/One.md)\n');
    expect(await read('Topics/Deep/A/One.md')).toContain('../../../NodeTypes/Task.md');
    // The binary moved byte for byte.
    expect([...(await fs.readFile(path.join(repo, 'Topics/Deep/A/pic.png')))]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  });

  it('a single file moved with edits is one commit with a rename', async () => {
    const body = 'index line\n'.repeat(20);
    await put('Index.md', `[one](Projects/A/One.md)\n${body}`);
    await git(repo, ['commit', '-am', 'longer index']);
    await fsLayer().moveWithEdits(`${KB}/Index.md`, `${KB}/Home/Index.md`, [
      { path: `${KB}/Home/Index.md`, lockAt: `${KB}/Index.md`, content: `[one](../Projects/A/One.md)\n${body}` },
    ], 'Move Index');
    const stat = (await git(repo, ['show', '-M', '--name-status', '--format=', 'HEAD'])).trim();
    expect(stat).toMatch(/^R\d+\tIndex\.md\tHome\/Index\.md$/);
  });

  it('a lock held past the retries changes nothing and names the busy file', async () => {
    // A file inside the moved folder, locked in the middle of the sorted
    // order: the locks taken before it must all be given back.
    lockedPaths.add(`${KB}/Projects/A/Two.md`);
    const head = await git(repo, ['rev-parse', 'HEAD']);
    // The real retry window: three attempts, two seconds apart.
    const err = await fsLayer().moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveLockedError);
    expect((err as Error).message).toContain(`"${KB}/Projects/A/Two.md" is being edited by Bob`);
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');
    expect(workflow.commitChanges).not.toHaveBeenCalled();
    // Every lock taken was given back untouched.
    expect(released(workflow.releaseLockUntouched)).toEqual([`${KB}/Index.md`, `${KB}/Projects/A`, `${KB}/Projects/A/One.md`]);
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    expect(await read('Index.md')).toBe('[one](Projects/A/One.md)\n');
  }, 20_000);

  it('a file saved into the folder while the locks were being taken refuses the move, nothing moved', async () => {
    const acquire = workflow.acquireLock as ReturnType<typeof vi.fn>;
    let arrived = false;
    acquire.mockImplementation(async () => {
      // The first lock is the moment somebody else's save lands in the folder.
      if (!arrived) {
        arrived = true;
        await put('Projects/A/Late.md', 'late\n');
      }
      return { acquired: true, lock: { holderName: 'Alice' } };
    });
    const head = await git(repo, ['rev-parse', 'HEAD']);
    const err = await fsLayer().moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveRacedError);
    expect((err as Error).message).toContain(`"${KB}/Projects/A/Late.md" was added`);
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect(workflow.commitChanges).not.toHaveBeenCalled();
    expect(await read('Projects/A/Late.md')).toBe('late\n');
    expect(await read('Index.md')).toBe('[one](Projects/A/One.md)\n');
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(released(workflow.releaseLockUntouched).length).toBeGreaterThan(0);
  });

  it('a move that fails and cannot be undone releases every lock with the discard, and says both', async () => {
    (workflow.commitChanges as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // Something takes the old place while the move is in flight, so the
      // undo's rename finds its destination occupied.
      await put('Projects/A/Taken.md', 'x\n');
      throw new Error('commit exploded');
    });
    const err = await fsLayer().moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveUndoError);
    expect((err as Error).message).toContain('commit exploded');
    expect((err as Error).message).toContain('could not be undone');
    // Nothing is handed back as untouched: every path goes with the discard.
    expect(workflow.releaseLockUntouched).not.toHaveBeenCalled();
    const discarded = released(workflow.releaseLockNoCommit);
    expect(discarded).toContain(`${KB}/Projects/A`);
    expect(discarded).toContain(`${KB}/Topics/Deep/A/One.md`);
    expect(discarded).toContain(`${KB}/Index.md`);
  });

  it('locks every file of a moved folder at its old and its new path', async () => {
    await fsLayer().moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A');
    const locked = (workflow.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2] as string);
    for (const name of ['One.md', 'Two.md', 'pic.png']) {
      expect(locked).toContain(`${KB}/Projects/A/${name}`);
      expect(locked).toContain(`${KB}/Topics/Deep/A/${name}`);
    }
    expect(locked).toEqual([...locked].sort());
  });

  it('a lock store that throws gives back the locks already held, and changes nothing', async () => {
    (workflow.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async (_w: string, _b: string, p: string) => {
      if (p === `${KB}/Projects/A/One.md`) throw new Error('lock store down');
      return { acquired: true, lock: { holderName: 'Alice' } };
    });
    await expect(
      fsLayer().moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A'),
    ).rejects.toThrow('lock store down');
    expect(released(workflow.releaseLockUntouched)).toEqual([`${KB}/Index.md`, `${KB}/Projects/A`]);
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('every edit is judged again once the locks are held, and a refusal there changes nothing', async () => {
    const acquire = workflow.acquireLock as ReturnType<typeof vi.fn>;
    // A validator whose verdict depends on the state under the locks.
    const validateWrite = vi.fn(async (p: string) => {
      if (acquire.mock.calls.length > 0 && p.endsWith('Index.md')) throw new Error('refused under lock');
    });
    const head = await git(repo, ['rev-parse', 'HEAD']);
    await expect(
      fsLayer(validateWrite).moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A'),
    ).rejects.toThrow('refused under lock');
    expect(validateWrite.mock.calls.filter((c) => c[0] === `${KB}/Index.md`)).toHaveLength(2);
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(released(workflow.releaseLockUntouched)).toContain(`${KB}/Index.md`);
  });

  it('an edit whose bytes cannot be put back is released with the discard, not untouched', async () => {
    (workflow.commitChanges as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // The restore of Index.md will fail: a folder now sits at its path.
      await fs.rm(path.join(repo, 'Index.md'));
      await fs.mkdir(path.join(repo, 'Index.md'));
      throw new Error('commit exploded');
    });
    await expect(
      fsLayer().moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A'),
    ).rejects.toThrow('commit exploded');
    expect(released(workflow.releaseLockNoCommit)).toEqual([`${KB}/Index.md`]);
    expect(released(workflow.releaseLockUntouched)).not.toContain(`${KB}/Index.md`);
    // The moved file's edit was put back, and its lock released untouched.
    expect(await read('Projects/A/One.md')).toContain('../../NodeTypes/Task.md');
    expect(released(workflow.releaseLockUntouched)).toContain(`${KB}/Projects/A/One.md`);
  });

  it('a check refusal under the locks changes nothing', async () => {
    const head = await git(repo, ['rev-parse', 'HEAD']);
    await expect(
      fsLayer().moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A', async () => {
        throw new Error('changed meanwhile');
      }),
    ).rejects.toThrow('changed meanwhile');
    expect(await git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    expect((await git(repo, ['status', '--porcelain'])).trim()).toBe('');
  });

  it('a failing commit puts every byte back and undoes the move', async () => {
    (workflow.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('commit exploded'));
    await expect(
      fsLayer().moveWithEdits(`${KB}/Projects/A`, `${KB}/Topics/Deep/A`, edits(), 'Move A'),
    ).rejects.toThrow('commit exploded');
    expect((await git(repo, ['status', '--porcelain', '--untracked-files=all'])).trim()).toBe('');
    expect(await read('Index.md')).toBe('[one](Projects/A/One.md)\n');
    expect(await read('Projects/A/One.md')).toContain('../../NodeTypes/Task.md');
  });
});
