import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser, IVersionControlService } from '@bevel-software/platform-shared';
import { LocalFilesystem } from '@mastra/core/workspace';
import { LockingFilesystem, PathHeldError } from '../locking-filesystem.js';
import { PushNeedsAgentResolutionError, VersionControlValidationError } from '../../../shared/domain-errors.js';
import { makeAgentRolesYamlWriteValidator } from '../../access-model/index.js';

/** The clone folder at the workspace root: every path the filesystem mutates lives under it. */
const KB = 'knowledge-base';

const USER: AuthUser = {
  id: 'user-1',
  email: 'alice@example.com',
  name: 'Alice',
};

function makeVersionControl(): IVersionControlService {
  const acquireLock = vi.fn().mockResolvedValue({
    acquired: true,
    lock: {
      branch: 'feat',
      path: 'Foo.md',
      holderUserId: 'user-1',
      holderName: 'Alice',
      acquiredAt: '',
      lastHeartbeatAt: '',
      expiresAt: '',
    },
  });
  return {
    acquireLock,
    releaseLock: vi.fn().mockResolvedValue(null),
    releaseLockNoCommit: vi.fn().mockResolvedValue(undefined),
    releaseLockUntouched: vi.fn().mockResolvedValue(undefined),
    // A renewal or an ownership check answers the lock the path's last acquire
    // granted, as the lock service answers the lock its holder still holds.
    heartbeatLock: vi.fn(async (_w: string, _b: string, p: string) => {
      const calls = acquireLock.mock.calls;
      for (let i = calls.length - 1; i >= 0; i--) {
        if (calls[i]![2] === p) return ((await acquireLock.mock.results[i]!.value) as { lock?: unknown }).lock ?? {};
      }
      return {};
    }),
    getLock: vi.fn(),
    commitFileWhileLocked: vi.fn(),
    commitChanges: vi.fn().mockResolvedValue({}),
  } as unknown as IVersionControlService;
}

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-locking-fs-'));
}

describe('LockingFilesystem — every mutating op runs acquire → super → release', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writeFile acquires, writes through to disk, then releases', async () => {
    const versionControl = makeVersionControl();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fsLayer.writeFile('knowledge-base/Knowledge/Foo.md', 'hello\n');

    expect(versionControl.acquireLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'knowledge-base/Knowledge/Foo.md',
      USER,
    );
    expect(versionControl.releaseLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'knowledge-base/Knowledge/Foo.md',
      USER,
    );
    // Acquire fires before release.
    const acquireOrder = (versionControl.acquireLock as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const releaseOrder = (versionControl.releaseLock as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(releaseOrder);
    // The bytes actually landed on disk.
    expect(await fs.readFile(path.join(root, 'knowledge-base/Knowledge/Foo.md'), 'utf-8')).toBe('hello\n');
  });

  it('deleteFile acquires + deletes + releases', async () => {
    const filePath = path.join(root, 'knowledge-base/a.md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'x', 'utf-8');
    const versionControl = makeVersionControl();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fsLayer.deleteFile('knowledge-base/a.md');
    expect(versionControl.acquireLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/a.md', USER);
    expect(versionControl.releaseLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/a.md', USER);
    await expect(fs.access(filePath)).rejects.toBeDefined();
  });

  it('mkdir drops a .gitkeep through the lock-aware writeFile so the empty folder is committed', async () => {
    const versionControl = makeVersionControl();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fsLayer.mkdir('knowledge-base/empty');
    // .gitkeep got written through the lock path. The lock is on the
    // .gitkeep path (that's the file the commit attaches to).
    expect(versionControl.acquireLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'knowledge-base/empty/.gitkeep',
      USER,
    );
    expect(versionControl.releaseLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'knowledge-base/empty/.gitkeep',
      USER,
    );
    expect(await fs.readFile(path.join(root, 'knowledge-base/empty/.gitkeep'), 'utf-8')).toBe('');
  });

  it('mkdir of an already-populated dir does NOT drop a .gitkeep', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/has-content'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/has-content/real.md'), 'hi', 'utf-8');
    const versionControl = makeVersionControl();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fsLayer.mkdir('knowledge-base/has-content', { recursive: true });
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
    // The existing file is untouched.
    expect(await fs.readFile(path.join(root, 'knowledge-base/has-content/real.md'), 'utf-8')).toBe('hi');
  });

  it('rmdir is refused with a clear error — one-change-per-file invariant', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/doomed'), { recursive: true });
    const versionControl = makeVersionControl();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await expect(fsLayer.rmdir('knowledge-base/doomed')).rejects.toThrow(
      /Recursive directory removal is not supported/i,
    );
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
  });

  it(
    'retries acquire on contention then surfaces a skip error after 3 attempts',
    async () => {
      // 3 attempts × 2s ≈ 6s — bump vitest's default timeout for this one test.
      const versionControl = makeVersionControl();
      (versionControl.acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue({
        acquired: false,
        lock: {
          branch: 'feat',
          path: 'knowledge-base/Locked.md',
          holderUserId: 'bob',
          holderName: 'Bob',
          acquiredAt: '',
          lastHeartbeatAt: '',
          expiresAt: '',
        },
      });
      const fsLayer = new LockingFilesystem(
        { basePath: root, contained: true },
        { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
      );

      const err = await fsLayer.writeFile('knowledge-base/Locked.md', 'x').catch((e: unknown) => e);
      expect((err as Error).message).toMatch(/Skipped editing "knowledge-base\/Locked\.md" — locked by Bob/);
      expect(err).toBeInstanceOf(PathHeldError);
      expect(err).toMatchObject({ path: 'knowledge-base/Locked.md', holderName: 'Bob' });
      expect(versionControl.acquireLock).toHaveBeenCalledTimes(3);
      expect(versionControl.releaseLock).not.toHaveBeenCalled();
    },
    10_000,
  );

  it('drops the lock without committing when the underlying write throws', async () => {
    const versionControl = makeVersionControl();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    // The underlying write dies (disk full, permissions, whatever). The lock
    // must still go away so the next caller can edit a different file, but
    // releaseLock (which would commit + push whatever partial state is on
    // disk) must NOT fire — instead we use the no-commit variant so partial
    // writes don't silently persist as committed changes.
    const spy = vi
      .spyOn(LocalFilesystem.prototype, 'writeFile')
      .mockRejectedValue(new Error('disk exploded'));
    try {
      await expect(fsLayer.writeFile('knowledge-base/Boom.md', 'x')).rejects.toThrow('disk exploded');
    } finally {
      spy.mockRestore();
    }
    expect(versionControl.acquireLock).toHaveBeenCalled();
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalled();
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
  });
});

describe('LockingFilesystem.writeFiles — batch with deletes', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('locks writes AND deletes, applies both, returns the commit', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/Tools'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Tools/old.tool'), '{}');

    const versionControl = makeVersionControl();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        versionControl,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER, kbDirName: KB,
      },
    );

    const change = await fsLayer.writeFiles(
      [{ path: 'knowledge-base/Tools/new.tool', content: '{"type":"http","url":"https://x/m"}' }],
      'batch',
      ['knowledge-base/Tools/old.tool'],
    );

    // Both paths locked; both mutations landed; commit returned.
    expect(versionControl.acquireLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Tools/new.tool', USER);
    expect(versionControl.acquireLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Tools/old.tool', USER);
    expect(await fs.readFile(path.join(root, 'knowledge-base/Tools/new.tool'), 'utf-8')).toContain('http');
    await expect(fs.access(path.join(root, 'knowledge-base/Tools/old.tool'))).rejects.toThrow();
    expect(change).toEqual({});
  });

  it('a failing commit releases every lock WITHOUT committing', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/Tools'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Tools/old.tool'), '{}');

    const versionControl = makeVersionControl();
    (versionControl.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('push exploded'));
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        versionControl,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER, kbDirName: KB,
      },
    );

    await expect(
      fsLayer.writeFiles(
        [{ path: 'knowledge-base/Tools/new.tool', content: '{"type":"http","url":"https://x/m"}' }],
        'batch',
        ['knowledge-base/Tools/old.tool'],
      ),
    ).rejects.toThrow('push exploded');

    // Every acquired path goes through the NO-COMMIT release — which is what
    // discards the uncommitted bytes (write reverted, delete restored) in the
    // real VersionControlService via git.discardPath. The committing release must
    // never run.
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Tools/new.tool', USER);
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Tools/old.tool', USER);
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
  });

  it('a POST-commit push failure releases WITH commit-on-release (arms the worker retry), never the discard path', async () => {
    // PushNeedsAgentResolutionError means the commit LANDED and only the push
    // needs help. Routing it through releaseLockNoCommit would leave the
    // landed commit with no retry vehicle — the next identical write would
    // no-op against the committed bytes and the change stays unpublished
    // forever. The batch must releaseLock (the enqueued release commit no-ops
    // on the clean tree and the worker's unpushed-commits check re-runs the
    // push ladder) and still propagate the error.
    const versionControl = makeVersionControl();
    (versionControl.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PushNeedsAgentResolutionError('feat', 'knowledge-base/A.md', 'non-fast-forward', 'rebase failed'),
    );
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        versionControl,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER, kbDirName: KB,
      },
    );

    await expect(
      fsLayer.writeFiles([{ path: 'knowledge-base/A.md', content: 'x' }], 'batch'),
    ).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);

    expect(versionControl.releaseLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/A.md', USER);
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
  });
});

describe('LockingFilesystem — the caller judges under the lock', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const layer = (versionControl: IVersionControlService): LockingFilesystem =>
    new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );

  it('writeFile runs the check with the lock HELD and before any byte lands', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Foo.md'), 'before\n');

    const versionControl = makeVersionControl();
    const order: string[] = [];
    (versionControl.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('acquire');
      return { acquired: true, lock: { holderName: 'Alice' } };
    });

    await layer(versionControl).writeFile('knowledge-base/Foo.md', 'after\n', undefined, async () => {
      order.push('check');
      // The check reads the state the write is about to replace.
      expect(await fs.readFile(path.join(root, 'knowledge-base/Foo.md'), 'utf-8')).toBe('before\n');
    });

    expect(order).toEqual(['acquire', 'check']);
    expect(await fs.readFile(path.join(root, 'knowledge-base/Foo.md'), 'utf-8')).toBe('after\n');
  });

  it("a writeFile check that throws writes nothing, releases UNTOUCHED, and gives the caller its own error", async () => {
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Foo.md'), 'theirs\n');

    const versionControl = makeVersionControl();
    const refusal = new Error('already exists');
    await expect(
      layer(versionControl).writeFile('knowledge-base/Foo.md', 'mine\n', undefined, () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);

    expect(await fs.readFile(path.join(root, 'knowledge-base/Foo.md'), 'utf-8')).toBe('theirs\n');
    // Untouched, never no-commit: a discard would reset the path to HEAD and
    // destroy whatever save left those bytes there.
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Foo.md', USER);
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
  });

  it('rewriteFile reads, computes and writes with the lock HELD, from the bytes on disk at that moment', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Foo.md'), 'owner: \n');

    const versionControl = makeVersionControl();
    const order: string[] = [];
    (versionControl.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('acquire');
      // Another writer lands while this call waits for the lock.
      await fs.writeFile(path.join(root, 'knowledge-base/Foo.md'), 'owner: alice\n');
      return { acquired: true, lock: { holderName: 'Alice' } };
    });
    (versionControl.releaseLock as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('release');
      return null;
    });

    let seen = '';
    await layer(versionControl).rewriteFile('knowledge-base/Foo.md', (current) => {
      order.push('rewrite');
      seen = current!.toString('utf8');
      return `${seen}note: kept\n`;
    });

    expect(order).toEqual(['acquire', 'rewrite', 'release']);
    // It was handed what the other writer left, not what was there when the call began.
    expect(seen).toBe('owner: alice\n');
    expect(await fs.readFile(path.join(root, 'knowledge-base/Foo.md'), 'utf-8')).toBe('owner: alice\nnote: kept\n');
    expect(versionControl.releaseLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Foo.md', USER);
  });

  it('a rewriteFile that throws writes nothing, releases UNTOUCHED, and gives the caller its own error', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Foo.md'), 'theirs\n');

    const versionControl = makeVersionControl();
    const refusal = new Error('old text is gone');
    await expect(
      layer(versionControl).rewriteFile('knowledge-base/Foo.md', () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);

    expect(await fs.readFile(path.join(root, 'knowledge-base/Foo.md'), 'utf-8')).toBe('theirs\n');
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Foo.md', USER);
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
  });

  it('rewriteFile hands over null when nothing is at the path', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    const versionControl = makeVersionControl();
    let seen: Buffer | null | undefined;
    await layer(versionControl).rewriteFile('knowledge-base/New.md', (current) => {
      seen = current;
      return 'made\n';
    });
    expect(seen).toBeNull();
    expect(await fs.readFile(path.join(root, 'knowledge-base/New.md'), 'utf-8')).toBe('made\n');
  });

  it('rewriteFile judges the bytes it is about to write with the pre-disk validator, under the lock', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Foo.md'), 'ok\n');
    const versionControl = makeVersionControl();
    const refusal = new Error('refused by the validator');
    const judged: string[] = [];
    const guarded = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        versionControl,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER,
        kbDirName: KB,
        validateWrite: async (_p, content) => {
          judged.push(String(content));
          throw refusal;
        },
      },
    );
    await expect(guarded.rewriteFile('knowledge-base/Foo.md', () => 'bad\n')).rejects.toBe(refusal);
    expect(judged).toEqual(['bad\n']);
    expect(await fs.readFile(path.join(root, 'knowledge-base/Foo.md'), 'utf-8')).toBe('ok\n');
    expect(versionControl.releaseLockUntouched).toHaveBeenCalled();
  });

  it('rewriteFile refuses a path outside the repository before any lock', async () => {
    const versionControl = makeVersionControl();
    await expect(layer(versionControl).rewriteFile('elsewhere/Foo.md', () => 'x')).rejects.toThrow();
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
  });

  it('writeFiles runs its check once EVERY lock is held, and lands only what the check keeps', async () => {
    const versionControl = makeVersionControl();
    const acquired: string[] = [];
    (versionControl.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async (_w, _b, p: string) => {
      acquired.push(p);
      return { acquired: true, lock: { holderName: 'Alice' } };
    });

    const writes = [
      { path: 'knowledge-base/a.md', content: 'A' },
      { path: 'knowledge-base/b.md', content: 'B' },
      { path: 'knowledge-base/c.md', content: 'C' },
    ];
    await layer(versionControl).writeFiles(writes, 'batch', [], async (pending) => {
      // Every path of the batch is locked before the check gets to judge any.
      expect([...acquired].sort()).toEqual(['knowledge-base/a.md', 'knowledge-base/b.md', 'knowledge-base/c.md']);
      expect(pending.map((w) => w.path)).toEqual(writes.map((w) => w.path));
      return pending.filter((w) => w.path !== 'knowledge-base/b.md');
    });

    expect(await fs.readFile(path.join(root, 'knowledge-base/a.md'), 'utf-8')).toBe('A');
    expect(await fs.readFile(path.join(root, 'knowledge-base/c.md'), 'utf-8')).toBe('C');
    await expect(fs.access(path.join(root, 'knowledge-base/b.md'))).rejects.toThrow();
    // The dropped path stays OUT of the commit's scope — an unscoped commit
    // there would sweep in whatever another save left dirty on it — and
    // releases untouched, because this batch never wrote a byte to it.
    expect(versionControl.commitChanges).toHaveBeenCalledWith('ws-feat', USER, 'batch', [
      'knowledge-base/a.md',
      'knowledge-base/c.md',
    ]);
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/b.md', USER);
  });

  it('writeFiles gives back the locks it holds, untouched, when taking a later one throws', async () => {
    const versionControl = makeVersionControl();
    const refusal = Object.assign(new Error('no write access'), { status: 403 });
    (versionControl.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async (_w, _b, p: string) => {
      if (p === 'knowledge-base/b.md') throw refusal;
      return { acquired: true, lock: { holderName: 'Alice' } };
    });
    await expect(
      layer(versionControl).writeFiles(
        [{ path: 'knowledge-base/a.md', content: 'A' }, { path: 'knowledge-base/b.md', content: 'B' }],
        'batch',
      ),
    ).rejects.toBe(refusal);
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/a.md', USER);
    await expect(fs.access(path.join(root, 'knowledge-base/a.md'))).rejects.toThrow();
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
  });

  it('a writeFiles check that drops EVERY write commits nothing and releases everything untouched', async () => {
    const versionControl = makeVersionControl();
    const change = await layer(versionControl).writeFiles(
      [{ path: 'knowledge-base/a.md', content: 'A' }],
      'batch',
      [],
      async () => [],
    );

    expect(change).toBeNull();
    await expect(fs.access(path.join(root, 'knowledge-base/a.md'))).rejects.toThrow();
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/a.md', USER);
  });

  it('a writeFiles check that THROWS refuses the whole batch, untouched', async () => {
    const versionControl = makeVersionControl();
    const refusal = new Error('nope');
    await expect(
      layer(versionControl).writeFiles(
        [{ path: 'knowledge-base/a.md', content: 'A' }, { path: 'knowledge-base/b.md', content: 'B' }],
        'batch',
        [],
        async () => {
          throw refusal;
        },
      ),
    ).rejects.toBe(refusal);

    await expect(fs.access(path.join(root, 'knowledge-base/a.md'))).rejects.toThrow();
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledTimes(2);
  });

  /** A lock service whose gates refuse `refusedPath`'s lock. */
  const gateRefusing = (refusedPath: string, refusal: Error): IVersionControlService => {
    const versionControl = makeVersionControl();
    (versionControl.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async (_w, _b, p: string) => {
      if (p === refusedPath) throw refusal;
      return { acquired: true, lock: { holderUserId: 'user-1', holderName: 'Alice' } };
    });
    return versionControl;
  };

  it('writeFiles drops a write whose lock the gates refuse when `refused` takes it as that path\'s alone, and lands the rest', async () => {
    const refusal = Object.assign(new Error('no write access'), { status: 403 });
    const versionControl = gateRefusing('knowledge-base/b.md', refusal);
    const asked: [string, unknown][] = [];

    await layer(versionControl).writeFiles(
      [{ path: 'knowledge-base/a.md', content: 'A' }, { path: 'knowledge-base/b.md', content: 'B' }, { path: 'knowledge-base/c.md', content: 'C' }],
      'batch',
      [],
      undefined,
      (p, err) => void asked.push([p, err]),
    );

    expect(asked).toEqual([['knowledge-base/b.md', refusal]]);
    expect(versionControl.commitChanges).toHaveBeenCalledWith('ws-feat', USER, 'batch', ['knowledge-base/a.md', 'knowledge-base/c.md']);
    await expect(fs.access(path.join(root, 'knowledge-base/b.md'))).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'knowledge-base/c.md'), 'utf-8')).toBe('C');
  });

  it('a `refused` that throws refuses the whole batch with what it threw, untouched', async () => {
    const versionControl = gateRefusing('knowledge-base/b.md', Object.assign(new Error('no write access'), { status: 403 }));
    const verdict = new Error('the archive is refused');

    await expect(
      layer(versionControl).writeFiles(
        [{ path: 'knowledge-base/a.md', content: 'A' }, { path: 'knowledge-base/b.md', content: 'B' }],
        'batch',
        [],
        undefined,
        () => {
          throw verdict;
        },
      ),
    ).rejects.toBe(verdict);

    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/a.md', USER);
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'knowledge-base/a.md'))).rejects.toThrow();
  });

  it('a delete the gates refuse is never offered to `refused`: it refuses the batch', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/b.md'), 'B');
    const refusal = Object.assign(new Error('no write access'), { status: 403 });
    const versionControl = gateRefusing('knowledge-base/b.md', refusal);
    const asked: string[] = [];

    await expect(
      layer(versionControl).writeFiles([{ path: 'knowledge-base/a.md', content: 'A' }], 'batch', ['knowledge-base/b.md'], undefined, (p) =>
        void asked.push(p),
      ),
    ).rejects.toBe(refusal);

    expect(asked).toEqual([]);
    expect(await fs.readFile(path.join(root, 'knowledge-base/b.md'), 'utf-8')).toBe('B');
  });

  it('a write dropped at its lock takes its creator seed with it when no other write wants the seed', async () => {
    const versionControl = gateRefusing('knowledge-base/KnowledgeBase/Mine/a.md', Object.assign(new Error('no'), { status: 403 }));
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        versionControl,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER,
        kbDirName: KB,
        creatorAccess: {
          planForCreate: async (_ws, _u, p: string) =>
            p.startsWith('knowledge-base/KnowledgeBase/Mine/')
              ? { kind: 'seed-access-md', wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md', apply: () => 'seed\n' }
              : null,
          noteAccessFileWritten: () => {},
        },
      },
    );

    await fsLayer.writeFiles(
      [{ path: 'knowledge-base/KnowledgeBase/Mine/a.md', content: 'A' }, { path: 'knowledge-base/other.md', content: 'O' }],
      'batch',
      [],
      undefined,
      () => {},
    );

    const locked = (versionControl.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]);
    expect(locked).not.toContain('knowledge-base/KnowledgeBase/Mine/access.md');
    expect(versionControl.commitChanges).toHaveBeenCalledWith('ws-feat', USER, 'batch', ['knowledge-base/other.md']);
    await expect(fs.access(path.join(root, 'knowledge-base/KnowledgeBase/Mine'))).rejects.toThrow();
  });
});

describe('LockingFilesystem.writeFiles — a batch longer than a lease', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  const LEASE_MS = 60_000;

  /**
   * The lock service's leases, as the real one keeps them. An acquire takes a
   * path that has no live lease, stamping it with the moment it was taken
   * (`acquiredAt`) and a lease of `LEASE_MS`; a live lease is refused, the
   * same user's own included. A heartbeat refreshes only a live lease held by
   * the same user and answers that lock, its `acquiredAt` unchanged; anything
   * else it refuses as not held (`lock-not-held`). A release ends the lease
   * the user holds on the path, whoever took it. A path in `unreachable` gets
   * a heartbeat failure (the lock service down). Its commit takes
   * `commitMs`, a long commit and push, and each release `releaseMs`;
   * `liveAtRelease` records, per release, whether the lease was still live.
   */
  function leasingVersionControl(commitMs: number, releaseMs = 0) {
    const rows = new Map<string, { holder: AuthUser; acquiredAt: number; expiresAt: number }>();
    const lockOf = (p: string) => {
      const row = rows.get(p)!;
      return {
        branch: 'feat',
        path: p,
        holderUserId: row.holder.id,
        holderName: row.holder.name,
        acquiredAt: new Date(row.acquiredAt).toISOString(),
        lastHeartbeatAt: new Date(Date.now()).toISOString(),
        expiresAt: new Date(row.expiresAt).toISOString(),
      };
    };
    /** An acquire by `holder`, as the lock service answers it: the batch's own, or anyone else's. */
    const acquire = (p: string, holder: AuthUser) => {
      const now = Date.now();
      if ((rows.get(p)?.expiresAt ?? 0) > now) return { acquired: false, lock: lockOf(p) };
      rows.set(p, { holder, acquiredAt: now, expiresAt: now + LEASE_MS });
      return { acquired: true, lock: lockOf(p) };
    };
    const unreachable = new Set<string>();
    const liveAtCommit: boolean[] = [];
    let entered: () => void = () => {};
    const committing = new Promise<void>((resolve) => (entered = resolve));
    const liveAtRelease: [string, boolean][] = [];
    const release = () =>
      vi.fn(async (_w: string, _b: string, p: string, u: AuthUser) => {
        if (releaseMs > 0) await new Promise((resolve) => setTimeout(resolve, releaseMs));
        liveAtRelease.push([p, (rows.get(p)?.expiresAt ?? 0) > Date.now()]);
        if (rows.get(p)?.holder.id === u.id) rows.delete(p);
      });
    const heartbeatLock = vi.fn(async (_w: string, _b: string, p: string, u: AuthUser) => {
      if (unreachable.has(p)) throw new Error('connect ECONNREFUSED: the lock service is unreachable');
      const now = Date.now();
      const row = rows.get(p);
      if (row === undefined || row.holder.id !== u.id || row.expiresAt <= now) {
        throw new VersionControlValidationError(
          `Cannot heartbeat lock on "${p}": not held by you (or no longer exists).`,
          { kind: 'lock-not-held', branch: 'feat', path: p },
        );
      }
      row.expiresAt = now + LEASE_MS;
      return lockOf(p);
    });
    /** How many heartbeats had been sent when the commit began. */
    const heartbeatsAtCommit: number[] = [];
    const versionControl = {
      acquireLock: vi.fn(async (_w: string, _b: string, p: string, u: AuthUser) => acquire(p, u)),
      heartbeatLock,
      commitChanges: vi.fn(async (_w: string, _u: AuthUser, _s: string, paths: string[]) => {
        heartbeatsAtCommit.push(heartbeatLock.mock.calls.length);
        entered();
        if (commitMs > 0) await new Promise((resolve) => setTimeout(resolve, commitMs));
        for (const p of paths) liveAtCommit.push((rows.get(p)?.expiresAt ?? 0) > Date.now());
        return {};
      }),
      releaseLock: release(),
      releaseLockNoCommit: release(),
      releaseLockUntouched: release(),
    } as unknown as IVersionControlService;
    return { versionControl, liveAtCommit, liveAtRelease, committing, rows, acquire, unreachable, heartbeatsAtCommit };
  }

  /** A `check` that keeps the batch judging for `ms`, with `judging` resolved once it has begun. */
  function slowCheck(ms: number) {
    let begin: () => void = () => {};
    const judging = new Promise<void>((resolve) => (begin = resolve));
    const check = async <W,>(writes: readonly W[]): Promise<W[]> => {
      begin();
      await new Promise((resolve) => setTimeout(resolve, ms));
      return [...writes];
    };
    return { check, judging };
  }

  /** Every release call, of any kind, naming `p`. */
  function releasesOf(versionControl: IVersionControlService, p: string): unknown[][] {
    return [versionControl.releaseLock, versionControl.releaseLockNoCommit, versionControl.releaseLockUntouched].flatMap(
      (release) => (release as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[2] === p),
    );
  }

  const A = 'knowledge-base/a.md';
  const B = 'knowledge-base/b.md';
  const BOB: AuthUser = { id: 'user-2', email: 'bob@example.com', name: 'Bob' };

  it('renews every lock it holds until it gives them back, so a batch that outlasts the lease still holds its paths', async () => {
    const { versionControl, liveAtCommit, committing } = leasingVersionControl(2.5 * LEASE_MS);
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );

    const landing = fsLayer.writeFiles(
      [{ path: 'knowledge-base/a.md', content: 'A' }, { path: 'knowledge-base/b.md', content: 'B' }],
      'batch',
    );
    await committing;
    await vi.advanceTimersByTimeAsync(2.5 * LEASE_MS);
    await landing;

    expect(liveAtCommit).toEqual([true, true]);
    // Given back, the locks are renewed no more.
    const renewals = (versionControl.heartbeatLock as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(renewals).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(2 * LEASE_MS);
    expect((versionControl.heartbeatLock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(renewals);
  });

  it.each([
    ['the same person, in their own editor', 'same'],
    ['another person', 'other'],
  ] as const)('a lease that lapsed and was taken by %s refuses the batch before any write, and the lost lock is not released', async (_who, whose) => {
    const { versionControl, rows, acquire, unreachable } = leasingVersionControl(0);
    const taker = whose === 'same' ? USER : BOB;
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    const { check, judging } = slowCheck(1.5 * LEASE_MS);
    // a.md's renewals fail (the lock service unreachable for it) while the batch judges.
    unreachable.add(A);
    const settled = fsLayer
      .writeFiles([{ path: A, content: 'A' }, { path: B, content: 'B' }], 'batch', [], check)
      .then(() => null, (err: unknown) => err);
    await judging;
    await vi.advanceTimersByTimeAsync(LEASE_MS + 5_000);
    // The lease has lapsed: someone takes the path, and renewals answer again.
    expect(acquire(A, taker).acquired).toBe(true);
    const editorsLock = rows.get(A);
    unreachable.clear();
    await vi.advanceTimersByTimeAsync(0.5 * LEASE_MS - 5_000);

    const err = await settled;
    expect(err).toBeInstanceOf(PathHeldError);
    expect(err).toMatchObject({ path: A, holderName: null, lapsed: true, status: 409, payload: { kind: 'path-held', path: A } });
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, A))).rejects.toThrow();
    await expect(fs.access(path.join(root, B))).rejects.toThrow();
    // The new holder keeps its lock: nothing released a.md. The lock still held goes back untouched.
    expect(releasesOf(versionControl, A)).toEqual([]);
    expect(rows.get(A)).toBe(editorsLock);
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', B, USER);
  });

  it('a renewal refused as not held marks the lock lost, though its lease has not run out, and refuses the batch', async () => {
    const { versionControl, rows, acquire } = leasingVersionControl(0);
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    const { check, judging } = slowCheck(0.5 * LEASE_MS);
    const settled = fsLayer
      .writeFiles([{ path: A, content: 'A' }, { path: B, content: 'B' }], 'batch', [], check)
      .then(() => null, (err: unknown) => err);
    await judging;
    await vi.advanceTimersByTimeAsync(10_000);
    // The lock on a.md ends early (released elsewhere) and Bob takes the path.
    rows.delete(A);
    expect(acquire(A, BOB).acquired).toBe(true);
    await vi.advanceTimersByTimeAsync(0.5 * LEASE_MS - 10_000);

    const err = await settled;
    expect(err).toBeInstanceOf(PathHeldError);
    expect(err).toMatchObject({ path: A, holderName: null, status: 409, payload: { kind: 'path-held', path: A } });
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, A))).rejects.toThrow();
    expect(releasesOf(versionControl, A)).toEqual([]);
    expect(rows.get(A)?.holder).toBe(BOB);
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', B, USER);
  });

  it('never releases a lock it knows it lost, on any unwind: a check that drops every write leaves the editor its lock', async () => {
    const { versionControl, rows, acquire } = leasingVersionControl(0);
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    let begin: () => void = () => {};
    const judging = new Promise<void>((resolve) => (begin = resolve));
    const dropEverything = async <W,>(): Promise<W[]> => {
      begin();
      await new Promise((resolve) => setTimeout(resolve, 0.5 * LEASE_MS));
      return [];
    };
    const settled = fsLayer
      .writeFiles([{ path: A, content: 'A' }], 'batch', [], dropEverything)
      .then((v) => v, (err: unknown) => err);
    await judging;
    await vi.advanceTimersByTimeAsync(10_000);
    // The lock ends early and the same person's editor takes the path afresh:
    // the next renewal answers a lock acquired at another moment.
    rows.delete(A);
    expect(acquire(A, USER).acquired).toBe(true);
    await vi.advanceTimersByTimeAsync(0.5 * LEASE_MS - 10_000);

    expect(await settled).toBeNull();
    expect(releasesOf(versionControl, A)).toEqual([]);
    expect(rows.get(A)?.holder).toBe(USER);
  });

  it('a batch whose locks stay its own commits and gives every lock back, as before', async () => {
    const { versionControl, rows } = leasingVersionControl(0);
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    const { check, judging } = slowCheck(1.5 * LEASE_MS);
    const landing = fsLayer.writeFiles([{ path: A, content: 'A' }, { path: B, content: 'B' }], 'batch', [], check);
    await judging;
    await vi.advanceTimersByTimeAsync(1.5 * LEASE_MS);

    await expect(landing).resolves.toEqual({});
    expect(versionControl.commitChanges).toHaveBeenCalledWith('ws-feat', USER, 'batch', [A, B]);
    expect(await fs.readFile(path.join(root, A), 'utf-8')).toBe('A');
    expect(await fs.readFile(path.join(root, B), 'utf-8')).toBe('B');
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', A, USER);
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', B, USER);
    expect(rows.size).toBe(0);
  });

  it('a renewal that throws counts the lock as lost: nothing written, nothing committed, the lock not released', async () => {
    const { versionControl, rows, unreachable } = leasingVersionControl(0);
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    const { check, judging } = slowCheck(0.5 * LEASE_MS);
    // One renewal of a.md fails while the batch judges; the lock service answers again after.
    unreachable.add(A);
    const settled = fsLayer
      .writeFiles([{ path: A, content: 'A' }, { path: B, content: 'B' }], 'batch', [], check)
      .then(() => null, (err: unknown) => err);
    await judging;
    await vi.advanceTimersByTimeAsync(LEASE_MS / 3 + 1_000);
    unreachable.clear();
    await vi.advanceTimersByTimeAsync(0.5 * LEASE_MS - LEASE_MS / 3 - 1_000);

    const err = await settled;
    expect(err).toBeInstanceOf(PathHeldError);
    expect(err).toMatchObject({ path: A, lapsed: true, status: 409, payload: { kind: 'path-held', path: A } });
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, A))).rejects.toThrow();
    expect(releasesOf(versionControl, A)).toEqual([]);
    expect(rows.has(A)).toBe(true);
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', B, USER);
  });

  it('keeps renewing a lock until its own release has returned, so a release slower than a lease still gives back a lock that is its own', async () => {
    const { versionControl, liveAtRelease, committing } = leasingVersionControl(0, 1.5 * LEASE_MS);
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    const landing = fsLayer.writeFiles([{ path: A, content: 'A' }], 'batch');
    await committing;
    await vi.advanceTimersByTimeAsync(2 * LEASE_MS);
    await landing;

    expect(liveAtRelease).toEqual([[A, true]]);
  });

  it('keeps renewing the locks it has not given back yet, so a release loop longer than a lease still holds each lock it releases', async () => {
    const paths = ['knowledge-base/r1.md', 'knowledge-base/r2.md', 'knowledge-base/r3.md', 'knowledge-base/r4.md'];
    const { versionControl, liveAtRelease, committing } = leasingVersionControl(0, 0.4 * LEASE_MS);
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    const landing = fsLayer.writeFiles(paths.map((p) => ({ path: p, content: p })), 'batch');
    // Past the disk writes, which the fake clock does not drive.
    await committing;
    // Four releases of 0.4 of a lease each: the loop outlasts one lease.
    await vi.advanceTimersByTimeAsync(2 * LEASE_MS);
    await landing;

    expect(liveAtRelease).toEqual(paths.map((p) => [p, true]));
    // Given back, the locks are renewed no more.
    const heartbeats = (versionControl.heartbeatLock as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * LEASE_MS);
    expect((versionControl.heartbeatLock as ReturnType<typeof vi.fn>).mock.calls.length).toBe(heartbeats);
  });

  it('a creator seed whose lock is lost while the commit runs is not rolled back when that commit fails', async () => {
    const { versionControl, rows, acquire } = leasingVersionControl(0);
    const mine = 'knowledge-base/KnowledgeBase/Mine/a.md';
    const seedPath = 'knowledge-base/KnowledgeBase/Mine/access.md';
    const editorsBytes = '---\nread:\n  - Bob <bob@example.com>\n---\n';
    let editorTookIt = false;
    let begin: () => void = () => {};
    const committing = new Promise<void>((resolve) => (begin = resolve));
    (versionControl.commitChanges as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      // While the commit runs, the lease on the seed lapses, the person's own
      // editor takes the path and saves its own rules there.
      rows.delete(seedPath);
      vi.setSystemTime(Date.now() + 1_000);
      editorTookIt = acquire(seedPath, USER).acquired;
      await fs.writeFile(path.join(root, seedPath), editorsBytes);
      begin();
      // Long enough for a renewal to come round and find the other grant.
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      throw new Error('commit exploded');
    });
    const creatorAccess = {
      planForCreate: vi.fn(async (_w: string, _u: AuthUser, p: string) =>
        p === mine
          ? { kind: 'seed-access-md', wsRelPath: seedPath, apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n' }
          : null,
      ),
      noteAccessFileWritten: vi.fn(),
    };
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    const settled = fsLayer
      .writeFiles([{ path: mine, content: 'A' }], 'batch')
      .then(() => null, (err: unknown) => err);
    await committing;
    await vi.advanceTimersByTimeAsync(30_000);

    const err = await settled;
    expect(editorTookIt).toBe(true);
    expect(err).toMatchObject({ message: 'commit exploded' });
    // The seed was not there before the batch, so rolling it back would have
    // removed the file. It holds what the editor saved, under the editor's lock.
    expect(await fs.readFile(path.join(root, seedPath), 'utf-8')).toBe(editorsBytes);
    expect(releasesOf(versionControl, seedPath)).toEqual([]);
    expect(rows.get(seedPath)?.holder).toBe(USER);
    // The path still the batch's own releases as a failed commit releases it.
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', mine, USER);
  });

  it('a lock lost while the batch writes refuses it before the commit: nothing committed, the lost path neither rolled back nor released', async () => {
    const { versionControl, rows, acquire } = leasingVersionControl(0);
    const mine = 'knowledge-base/KnowledgeBase/Mine/a.md';
    const seedPath = 'knowledge-base/KnowledgeBase/Mine/access.md';
    let editorTookIt = false;
    const creatorAccess = {
      planForCreate: vi.fn(async (_w: string, _u: AuthUser, p: string) =>
        p === mine
          ? {
              kind: 'seed-access-md',
              wsRelPath: seedPath,
              // Runs after the caller's writes landed and before the commit:
              // time passes there, the lease on `mine` lapses, and the
              // person's editor takes the path.
              apply: () => {
                vi.setSystemTime(Date.now() + 15_000);
                rows.delete(mine);
                editorTookIt = acquire(mine, USER).acquired;
                return '---\nread:\n  - Alice <alice@example.com>\n---\n';
              },
            }
          : null,
      ),
      noteAccessFileWritten: vi.fn(),
    };
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    const { check, judging } = slowCheck(50_000);
    const settled = fsLayer
      .writeFiles([{ path: mine, content: 'A' }, { path: B, content: 'B' }], 'batch', [], check)
      .then(() => null, (err: unknown) => err);
    await judging;
    await vi.advanceTimersByTimeAsync(50_000);

    const err = await settled;
    expect(editorTookIt).toBe(true);
    expect(err).toBeInstanceOf(PathHeldError);
    expect(err).toMatchObject({ path: mine, holderName: null, status: 409, payload: { kind: 'path-held', path: mine } });
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    // The lost path: no release, and the bytes the batch wrote there stay, under the editor's lock.
    expect(releasesOf(versionControl, mine)).toEqual([]);
    expect(rows.get(mine)?.holder).toBe(USER);
    expect(await fs.readFile(path.join(root, mine), 'utf-8')).toBe('A');
    // The others release as a failed commit releases them: the dirtied path
    // with the discard, the seed rolled back and given back untouched.
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', B, USER);
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    await expect(fs.access(path.join(root, seedPath))).rejects.toThrow();
  });
});

describe('LockingFilesystem — creator read grants on creation', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeCreatorAccess() {
    return {
      planForCreate: vi.fn().mockResolvedValue(null),
      noteAccessFileWritten: vi.fn(),
    };
  }

  it('writeFile asks the planner about the new file and lands the content untouched', async () => {
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.writeFile('knowledge-base/KnowledgeBase/new.md', '# New\n');
    expect(creatorAccess.planForCreate).toHaveBeenCalledWith(
      'ws-feat',
      USER,
      'knowledge-base/KnowledgeBase/new.md',
      'file',
    );
    // No plan kind rewrites file content any more: the one grant that exists
    // is seeded into a new root folder's access.md, never into the file.
    expect(await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/new.md'), 'utf-8')).toBe('# New\n');
  });

  it('writeFile seeds a subtree access.md (own lock cycle) before the file itself', async () => {
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockImplementation(async (_w, _u, p: string) =>
      p === 'knowledge-base/KnowledgeBase/Mine/doc.md'
        ? {
            kind: 'seed-access-md',
            wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
            apply: (current: string) =>
              current + '---\nread:\n  - Alice <alice@example.com>\n---\n',
          }
        : null,
    );
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.writeFile('knowledge-base/KnowledgeBase/Mine/doc.md', 'body');
    const locked = (versionControl.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[2],
    );
    expect(locked).toEqual(['knowledge-base/KnowledgeBase/Mine/access.md', 'knowledge-base/KnowledgeBase/Mine/doc.md']);
    expect(
      await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/Mine/access.md'), 'utf-8'),
    ).toContain('Alice <alice@example.com>');
    // The file content is untouched — the grant lives in the seeded access.md.
    expect(await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/Mine/doc.md'), 'utf-8')).toBe('body');
    expect(creatorAccess.noteAccessFileWritten).toHaveBeenCalledWith('ws-feat');
  });

  it('mkdir seeds the new folder access.md and then skips the .gitkeep (dir not empty)', async () => {
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockImplementation(async (_w, _u, p: string, kind: string) =>
      kind === 'dir'
        ? {
            kind: 'seed-access-md',
            wsRelPath: `${p}/access.md`,
            apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n',
          }
        : null,
    );
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.mkdir('knowledge-base/KnowledgeBase/Projects');
    expect(
      await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/Projects/access.md'), 'utf-8'),
    ).toContain('Alice <alice@example.com>');
    await expect(
      fs.access(path.join(root, 'knowledge-base/KnowledgeBase/Projects/.gitkeep')),
    ).rejects.toBeDefined();
  });

  it('writeFiles folds seeds into the same atomic batch, deduped across files', async () => {
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
      apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.writeFiles(
      [
        { path: 'knowledge-base/KnowledgeBase/Mine/a.md', content: 'A' },
        { path: 'knowledge-base/KnowledgeBase/Mine/b.md', content: 'B' },
      ],
      'batch',
    );
    // One seed for the shared new folder, committed with the batch.
    expect(
      await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/Mine/access.md'), 'utf-8'),
    ).toContain('Alice <alice@example.com>');
    expect(versionControl.commitChanges).toHaveBeenCalledTimes(1);
    const locked = (versionControl.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[2],
    );
    expect(locked).toEqual([
      'knowledge-base/KnowledgeBase/Mine/a.md',
      'knowledge-base/KnowledgeBase/Mine/b.md',
      'knowledge-base/KnowledgeBase/Mine/access.md',
    ]);
    expect(creatorAccess.noteAccessFileWritten).toHaveBeenCalledWith('ws-feat');
  });

  it('a NO-OP seed stays OUT of the commit scope (its dirty bytes must never ride this batch)', async () => {
    // The seed's access.md already carries the grant — apply() returns the
    // current bytes unchanged. The lock is still taken (and released), but the
    // path must NOT be passed to commitChanges: on the shared workspace it may
    // be dirty from ANOTHER save whose commit is still queued, and scoping the
    // batch to a merely-locked path would sweep those bytes in under this
    // batch's author/summary.
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase/Mine'), { recursive: true });
    const seedContent = '---\nread:\n  - Alice <alice@example.com>\n---\n';
    await fs.writeFile(path.join(root, 'knowledge-base/KnowledgeBase/Mine/access.md'), seedContent);
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
      apply: (current: string) => current, // grant already present → no-op
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        versionControl,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER, kbDirName: KB,
        creatorAccess,
      },
    );
    await fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');

    // The seed's lock cycle still ran (acquired + released)...
    const locked = (versionControl.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]);
    expect(locked).toContain('knowledge-base/KnowledgeBase/Mine/access.md');
    // ...but the commit is scoped to the caller's path only.
    const commitPaths = (versionControl.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['knowledge-base/KnowledgeBase/Mine/doc.md']);
    // The seeded file is untouched.
    expect(await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/Mine/access.md'), 'utf-8')).toBe(
      seedContent,
    );
  });

  it('a NO-OP seed lock releases UNTOUCHED — a prior save\'s queued bytes must survive as-is', async () => {
    // The prior-save-pending scenario: a previous save on the access.md
    // released its lock via releaseLock, so its bytes are DIRTY on the shared
    // workspace with the commit still queued. This batch then takes the seed
    // lock, finds the grant already present (apply() no-ops), and commits
    // only its own paths. Releasing the seed lock with NO-COMMIT semantics
    // would git-discard the path back to HEAD — silently destroying the prior
    // save. Releasing it with COMMIT-ON-RELEASE would be almost as bad: the
    // enqueue refreshes the existing pending row's author to THIS user and
    // resets its retry ladder — the prior save's bytes would publish under
    // the wrong name. The seed lock must release UNTOUCHED (drop the lock
    // row, leave disk and queue exactly as they are).
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase/Mine'), { recursive: true });
    const priorSave = '---\nread:\n  - Alice <alice@example.com>\n---\nprior queued bytes\n';
    await fs.writeFile(path.join(root, 'knowledge-base/KnowledgeBase/Mine/access.md'), priorSave);
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
      apply: (current: string) => current, // grant already present → no-op
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');

    // The batch's OWN committed path releases no-commit (clean — discard no-ops)...
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/doc.md', USER,
    );
    // ...but the merely-locked seed path releases UNTOUCHED — never the
    // enqueue, never the discard.
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/access.md', USER,
    );
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/access.md', USER,
    );
  });

  it('locks acquired before an acquire CONTENTION release UNTOUCHED (nothing written yet)', async () => {
    // First path acquires, second is contended: nothing has been written, so
    // the first path may hold ONLY someone else's still-queued bytes — the
    // unwind must neither discard them nor enqueue them under this user.
    const versionControl = makeVersionControl();
    (versionControl.acquireLock as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ acquired: true, lock: { holderUserId: 'user-1', holderName: 'Alice' } })
      .mockResolvedValue({ acquired: false, lock: { holderUserId: 'bob', holderName: 'Bob' } });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await expect(
      fsLayer.writeFiles(
        [
          { path: 'knowledge-base/A.md', content: 'a' },
          { path: 'knowledge-base/B.md', content: 'b' },
        ],
        'batch',
      ),
    ).rejects.toSatisfy((err: unknown) => err instanceof PathHeldError && err.path === 'knowledge-base/B.md' && err.holderName === 'Bob');
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/A.md', USER);
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
  }, 10_000);

  it('gives back every caller lock it holds, untouched, when taking a creator seed\'s lock throws', async () => {
    const versionControl = makeVersionControl();
    const failure = new Error('Lock contention race on "knowledge-base/KnowledgeBase/Mine/access.md" — please retry.');
    (versionControl.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async (_w, _b, p: string) => {
      if (p.endsWith('/access.md')) throw failure;
      return { acquired: true, lock: { holderUserId: 'user-1', holderName: 'Alice' } };
    });
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
      apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );

    await expect(
      fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/a.md', content: 'a' }], 'batch'),
    ).rejects.toBe(failure);

    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/a.md', USER);
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'knowledge-base/KnowledgeBase/Mine'))).rejects.toThrow();
  });

  it('a DELETE batch whose later lock is contended deletes nothing — a folder never half-disappears', async () => {
    // The all-or-none property `delete_folder` relies on, asserted on disk:
    // every lock is taken before the first delete, so a contended path means
    // no file under the folder is gone and nothing is committed.
    await fs.mkdir(path.join(root, 'knowledge-base/Archive'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Archive/a.md'), 'a');
    await fs.writeFile(path.join(root, 'knowledge-base/Archive/b.md'), 'b');
    const versionControl = makeVersionControl();
    (versionControl.acquireLock as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ acquired: true, lock: { holderUserId: 'user-1', holderName: 'Alice' } })
      .mockResolvedValue({ acquired: false, lock: { holderUserId: 'bob', holderName: 'Bob' } });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );

    await expect(
      fsLayer.writeFiles([], 'Delete Archive', ['knowledge-base/Archive/a.md', 'knowledge-base/Archive/b.md']),
    ).rejects.toThrow(/locked by Bob/);

    expect(await fs.readFile(path.join(root, 'knowledge-base/Archive/a.md'), 'utf-8')).toBe('a');
    expect(await fs.readFile(path.join(root, 'knowledge-base/Archive/b.md'), 'utf-8')).toBe('b');
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
  }, 10_000);

  it('a seed write that dies MID-WRITE restores the pre-image and releases UNTOUCHED', async () => {
    // The partial-write hazard: super.writeFile throws after touching disk,
    // leaving bytes that are neither the old content nor the new. The seed
    // loop read the pre-image under this very lock, so it can put it back —
    // after which the path is byte-identical to before the batch and must
    // release untouched (a prior save's queued bytes, if any, survive).
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase/Mine'), { recursive: true });
    const priorBytes = 'prior queued bytes\n';
    const seedPath = 'knowledge-base/KnowledgeBase/Mine/access.md';
    await fs.writeFile(path.join(root, seedPath), priorBytes);
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: seedPath,
      apply: (current: string) => current + 'read: Alice\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    // Fail the SEED write once (simulating a mid-write death that left
    // partial bytes); every other write — including the restore — passes
    // through to the real filesystem.
    const original = LocalFilesystem.prototype.writeFile;
    let failedOnce = false;
    const spy = vi
      .spyOn(LocalFilesystem.prototype, 'writeFile')
      .mockImplementation(async function (this: unknown, p, c, o) {
        if (p === seedPath && !failedOnce) {
          failedOnce = true;
          await original.call(this as LocalFilesystem, p, 'PARTIAL');
          throw new Error('disk exploded mid-write');
        }
        return original.call(this as LocalFilesystem, p, c, o);
      });
    try {
      await fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');
    } finally {
      spy.mockRestore();
    }
    // Pre-image restored — the partial bytes did not outlive the batch.
    expect(await fs.readFile(path.join(root, seedPath), 'utf-8')).toBe(priorBytes);
    // The failed seed stays OUT of the commit scope and releases untouched.
    const commitPaths = (versionControl.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['knowledge-base/KnowledgeBase/Mine/doc.md']);
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalledWith(
      'ws-feat', 'feat', seedPath, USER,
    );
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
  });

  it('a LANDED seed rolls back to its pre-image when the batch commit fails — grant bytes must not outlive the batch uncommitted', async () => {
    // The gap this pins: the seed write SUCCEEDED (path in `touched`) but
    // `commitChanges` then failed, so nothing of the batch was committed.
    // Releasing the seed untouched would leave its uncommitted grant bytes
    // on disk as if they were real; discarding to HEAD would destroy a prior
    // save's queued bytes. The right restore is the pre-image read under the
    // seed's own lock.
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase/Mine'), { recursive: true });
    const priorBytes = 'prior queued bytes\n';
    const seedPath = 'knowledge-base/KnowledgeBase/Mine/access.md';
    await fs.writeFile(path.join(root, seedPath), priorBytes);
    const versionControl = makeVersionControl();
    (versionControl.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('commit exploded'),
    );
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: seedPath,
      apply: (current: string) => current + 'read: Alice\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await expect(
      fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch'),
    ).rejects.toThrow('commit exploded');
    // The landed grant was rolled back to the pre-image, byte-identical…
    expect(await fs.readFile(path.join(root, seedPath), 'utf-8')).toBe(priorBytes);
    // …and the seed releases UNTOUCHED (the prior queued bytes are not this
    // batch's to discard), while the caller's own write releases via discard.
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/doc.md', USER,
    );
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalledWith(
      'ws-feat', 'feat', seedPath, USER,
    );
  });

  it('a seed whose write AND restore both fail releases with DISCARD — partial bytes must never land', async () => {
    // The double-failure residual: the seed write died mid-write and even the
    // pre-image restore failed, so the path holds known-partial bytes. The
    // release must reset it to HEAD (releaseLockNoCommit) — never enqueue the
    // corrupt bytes as a commit, never leave them for the next acquirer.
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase/Mine'), { recursive: true });
    const seedPath = 'knowledge-base/KnowledgeBase/Mine/access.md';
    await fs.writeFile(path.join(root, seedPath), 'prior\n');
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: seedPath,
      apply: (current: string) => current + 'read: Alice\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    const original = LocalFilesystem.prototype.writeFile;
    const spy = vi
      .spyOn(LocalFilesystem.prototype, 'writeFile')
      .mockImplementation(async function (this: unknown, p, c, o) {
        if (p === seedPath) throw new Error('disk exploded'); // seed write AND restore
        return original.call(this as LocalFilesystem, p, c, o);
      });
    try {
      await fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');
    } finally {
      spy.mockRestore();
    }
    // The unrecoverable seed path releases via the discard, everything else
    // untouched-or-no-commit as usual; the batch itself still succeeds.
    expect(versionControl.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(versionControl.releaseLockUntouched).not.toHaveBeenCalledWith(
      'ws-feat', 'feat', seedPath, USER,
    );
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
    const commitPaths = (versionControl.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['knowledge-base/KnowledgeBase/Mine/doc.md']);
  });

  it('push-retry unwind: committed paths re-arm via releaseLock, a merely-locked seed stays untouched', async () => {
    // PushNeedsAgentResolutionError with a no-op seed in the batch: the
    // committed caller path must release commit-on-release (that enqueued row
    // IS the push-retry vehicle), while the seed that never wrote must NOT be
    // swept into the same enqueue — its path may carry a prior save's queued
    // row that a fresh enqueue would re-attribute and reset.
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase/Mine'), { recursive: true });
    const seedPath = 'knowledge-base/KnowledgeBase/Mine/access.md';
    await fs.writeFile(path.join(root, seedPath), 'grant already present\n');
    const versionControl = makeVersionControl();
    (versionControl.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PushNeedsAgentResolutionError('feat', '(batch)', 'non-fast-forward', 'rebase failed'),
    );
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: seedPath,
      apply: (current: string) => current, // no-op — merely locked
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await expect(
      fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch'),
    ).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);
    expect(versionControl.releaseLock).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/doc.md', USER,
    );
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(versionControl.releaseLock).not.toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
  });

  it('a LANDED seed rides the commit scope with the caller paths', async () => {
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
      apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');
    const commitPaths = (versionControl.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['knowledge-base/KnowledgeBase/Mine/doc.md', 'knowledge-base/KnowledgeBase/Mine/access.md']);
  });

  it('a planner failure never blocks the write', async () => {
    const versionControl = makeVersionControl();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockRejectedValue(new Error('planner down'));
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.writeFile('knowledge-base/KnowledgeBase/new.md', 'x');
    expect(await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/new.md'), 'utf-8')).toBe('x');
  });
});

describe('LockingFilesystem refuses to create anything outside the repository folder', () => {
  // The bug this pins: the filesystem is rooted at the WORKSPACE dir, one level
  // above the git clone, so a repo-relative path (`KnowledgeBase/…`, the shape
  // every doc and URL shows) is "contained" and its bytes land BESIDE the
  // repository. The release commit then finds nothing dirty and returns null,
  // the tool reports success, and the explorer re-roots on the stray folder.
  // The refusal has to fire before any side effect: no lock, no creator-grant
  // plan, no validator call, no bytes on disk.
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const STRAY = 'KnowledgeBase/Reviews/PR-12.html';
  const CORRECTED = 'knowledge-base/KnowledgeBase/Reviews/PR-12.html';

  function makeCreatorAccess() {
    return {
      planForCreate: vi.fn().mockResolvedValue(null),
      grantInExtractedFile: vi.fn().mockResolvedValue(null),
      noteAccessFileWritten: vi.fn(),
    };
  }

  function layer(versionControl: IVersionControlService) {
    const creatorAccess = makeCreatorAccess();
    const validateWrite = vi.fn();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess, validateWrite },
    );
    return { fsLayer, creatorAccess, validateWrite };
  }

  async function expectRefused(
    op: Promise<unknown>,
    versionControl: IVersionControlService,
    creatorAccess: ReturnType<typeof makeCreatorAccess>,
    validateWrite: ReturnType<typeof vi.fn>,
  ): Promise<void> {
    await expect(op).rejects.toBeInstanceOf(VersionControlValidationError);
    // The corrected path is spelled out, under the clone folder.
    await expect(op).rejects.toThrow('"knowledge-base/KnowledgeBase/Reviews');
    // Refused before any side effect.
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(versionControl.commitChanges).not.toHaveBeenCalled();
    expect(creatorAccess.planForCreate).not.toHaveBeenCalled();
    expect(validateWrite).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'KnowledgeBase'))).rejects.toBeDefined();
  }

  it('writeFile', async () => {
    const versionControl = makeVersionControl();
    const { fsLayer, creatorAccess, validateWrite } = layer(versionControl);
    await expectRefused(fsLayer.writeFile(STRAY, '<p>review</p>'), versionControl, creatorAccess, validateWrite);
  });

  it('appendFile', async () => {
    const versionControl = makeVersionControl();
    const { fsLayer, creatorAccess, validateWrite } = layer(versionControl);
    await expectRefused(fsLayer.appendFile('KnowledgeBase/Reviews/review.log', 'line\n'), versionControl, creatorAccess, validateWrite);
  });

  it('writeFiles refuses the whole batch when one path is outside: nothing written, nothing locked', async () => {
    const versionControl = makeVersionControl();
    const { fsLayer, creatorAccess, validateWrite } = layer(versionControl);
    await expectRefused(
      fsLayer.writeFiles(
        [
          { path: 'knowledge-base/KnowledgeBase/ok.md', content: 'fine' },
          { path: STRAY, content: '<p>review</p>' },
        ],
        'batch',
      ),
      versionControl,
      creatorAccess,
      validateWrite,
    );
    await expect(fs.access(path.join(root, 'knowledge-base/KnowledgeBase/ok.md'))).rejects.toBeDefined();
  });

  it('mkdir', async () => {
    const versionControl = makeVersionControl();
    const { fsLayer, creatorAccess, validateWrite } = layer(versionControl);
    await expectRefused(fsLayer.mkdir('KnowledgeBase/Reviews'), versionControl, creatorAccess, validateWrite);
  });

  it('moveFile refuses a destination outside the repository and leaves the source in place', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/KnowledgeBase/PR-12.html'), 'x');
    const versionControl = makeVersionControl();
    const { fsLayer, creatorAccess, validateWrite } = layer(versionControl);
    await expectRefused(
      fsLayer.moveFile('knowledge-base/KnowledgeBase/PR-12.html', STRAY),
      versionControl,
      creatorAccess,
      validateWrite,
    );
    expect(await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/PR-12.html'), 'utf-8')).toBe('x');
  });

  it('copyFile refuses a destination outside the repository', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/KnowledgeBase/PR-12.html'), 'x');
    const versionControl = makeVersionControl();
    const { fsLayer, creatorAccess, validateWrite } = layer(versionControl);
    await expectRefused(
      fsLayer.copyFile('knowledge-base/KnowledgeBase/PR-12.html', STRAY),
      versionControl,
      creatorAccess,
      validateWrite,
    );
  });

  it('a `..` under the prefix is refused before the lock: the bytes would land beside the clone', async () => {
    // Containment is checked against the WORKSPACE dir, so the underlying
    // filesystem would happily resolve `knowledge-base/../stray.md` to a file
    // next to the clone. The prefix alone is not proof of being inside.
    const versionControl = makeVersionControl();
    const { fsLayer, creatorAccess, validateWrite } = layer(versionControl);
    await expect(fsLayer.writeFile('knowledge-base/../stray.md', 'x')).rejects.toBeInstanceOf(VersionControlValidationError);
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
    expect(creatorAccess.planForCreate).not.toHaveBeenCalled();
    expect(validateWrite).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'stray.md'))).rejects.toBeDefined();
  });

  it('the folder is matched as a whole segment: `knowledge-based/x.md` is outside too', async () => {
    const versionControl = makeVersionControl();
    const { fsLayer } = layer(versionControl);
    await expect(fsLayer.writeFile('knowledge-based/x.md', 'x')).rejects.toBeInstanceOf(VersionControlValidationError);
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
  });

  it('deleteFile still removes a file the old behaviour left beside the repository', async () => {
    // Removal is deliberately not gated: an agent that discovers a stray it
    // created before this guard existed must be able to clean it up.
    await fs.mkdir(path.join(root, 'KnowledgeBase/Reviews'), { recursive: true });
    await fs.writeFile(path.join(root, STRAY), 'stray');
    const versionControl = makeVersionControl();
    const { fsLayer } = layer(versionControl);
    await fsLayer.deleteFile(STRAY);
    await expect(fs.access(path.join(root, STRAY))).rejects.toBeDefined();
  });

  it('moveFile still rescues a stray INTO the repository', async () => {
    await fs.mkdir(path.join(root, 'KnowledgeBase/Reviews'), { recursive: true });
    await fs.writeFile(path.join(root, STRAY), 'stray');
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    const versionControl = makeVersionControl();
    const { fsLayer } = layer(versionControl);
    await fsLayer.moveFile(STRAY, CORRECTED);
    expect(await fs.readFile(path.join(root, CORRECTED), 'utf-8')).toBe('stray');
    await expect(fs.access(path.join(root, STRAY))).rejects.toBeDefined();
  });
});

describe('LockingFilesystem — the agent roles.yaml gate covers every op that lands bytes there', () => {
  const ROLES = `${KB}/roles.yaml`;
  const DRAFT = `${KB}/KnowledgeBase/draft.yaml`;
  const CURRENT = 'roles:\n  Admin:\n    - a@x.eu\n';
  const NEW_ROLE = '  Phoenix:\n    - p@x.eu\n';
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    await fs.mkdir(path.join(root, KB, 'KnowledgeBase'), { recursive: true });
    await fs.writeFile(path.join(root, ROLES), CURRENT);
    await fs.writeFile(path.join(root, DRAFT), CURRENT + NEW_ROLE);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function layer(versionControl: IVersionControlService) {
    const validateWrite = makeAgentRolesYamlWriteValidator(KB, () =>
      fs.readFile(path.join(root, ROLES), 'utf-8').catch(() => null),
    );
    return new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, validateWrite },
    );
  }

  async function expectRefused(op: Promise<unknown>, versionControl: IVersionControlService): Promise<void> {
    await expect(op).rejects.toMatchObject({ status: 422, payload: { kind: 'roles-yaml-new-role' } });
    expect(versionControl.acquireLock).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(CURRENT);
  }

  it('writeFile', async () => {
    const versionControl = makeVersionControl();
    await expectRefused(layer(versionControl).writeFile(ROLES, CURRENT + NEW_ROLE), versionControl);
  });

  it('writeFiles refuses the whole batch', async () => {
    const versionControl = makeVersionControl();
    await expectRefused(
      layer(versionControl).writeFiles([{ path: `${KB}/KnowledgeBase/ok.md`, content: 'fine' }, { path: ROLES, content: CURRENT + NEW_ROLE }], 'batch'),
      versionControl,
    );
    await expect(fs.access(path.join(root, KB, 'KnowledgeBase/ok.md'))).rejects.toBeDefined();
  });

  it('appendFile, judged by the file it would leave', async () => {
    const versionControl = makeVersionControl();
    await expectRefused(layer(versionControl).appendFile(ROLES, NEW_ROLE), versionControl);
  });

  it('copyFile, judged by the source bytes', async () => {
    const versionControl = makeVersionControl();
    await expectRefused(layer(versionControl).copyFile(DRAFT, ROLES, { overwrite: true }), versionControl);
  });

  it('moveFile, leaving the source where it was', async () => {
    const versionControl = makeVersionControl();
    await expectRefused(layer(versionControl).moveFile(DRAFT, ROLES, { overwrite: true }), versionControl);
    expect(await fs.readFile(path.join(root, DRAFT), 'utf-8')).toBe(CURRENT + NEW_ROLE);
  });

  it('a members-only write and append land as before', async () => {
    const versionControl = makeVersionControl();
    const fsLayer = layer(versionControl);
    await fsLayer.writeFile(ROLES, `${CURRENT}    - b@x.eu\n`);
    await fsLayer.appendFile(ROLES, '    - c@x.eu\n');
    expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(`${CURRENT}    - b@x.eu\n    - c@x.eu\n`);
    expect(versionControl.releaseLock).toHaveBeenCalledTimes(2);
  });

  describe('judged again under the lock, against what a concurrent writer left there', () => {
    const WITH_PHOENIX = CURRENT + NEW_ROLE;

    /** A version-control service whose acquire lets `race` rewrite disk first — the lock holder that finished just before us. */
    function racingVersionControl(race: () => Promise<void>): IVersionControlService {
      const versionControl = makeVersionControl();
      const acquired = (versionControl.acquireLock as ReturnType<typeof vi.fn>).getMockImplementation()!;
      let raced = false;
      (versionControl.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => {
        if (!raced) {
          raced = true;
          await race();
        }
        return acquired(...args);
      });
      return versionControl;
    }

    async function expectRefusedUnderLock(op: Promise<unknown>, versionControl: IVersionControlService, locks: number): Promise<void> {
      await expect(op).rejects.toMatchObject({ status: 422, payload: { kind: 'roles-yaml-new-role' } });
      expect(versionControl.releaseLockUntouched).toHaveBeenCalledTimes(locks);
      expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
      expect(versionControl.releaseLock).not.toHaveBeenCalled();
      expect(versionControl.commitChanges).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(CURRENT);
    }

    const deletePhoenix = () => fs.writeFile(path.join(root, ROLES), CURRENT);

    beforeEach(async () => {
      await fs.writeFile(path.join(root, ROLES), WITH_PHOENIX);
    });

    it('writeFile cannot reinstate a role deleted while it waited for the lock', async () => {
      const versionControl = racingVersionControl(deletePhoenix);
      await expectRefusedUnderLock(layer(versionControl).writeFile(ROLES, `${WITH_PHOENIX}    - q@x.eu\n`), versionControl, 1);
    });

    it('writeFiles re-judges the whole batch once every lock is held', async () => {
      const versionControl = racingVersionControl(deletePhoenix);
      await expectRefusedUnderLock(
        layer(versionControl).writeFiles([{ path: `${KB}/KnowledgeBase/ok.md`, content: 'fine' }, { path: ROLES, content: WITH_PHOENIX }], 'batch'),
        versionControl,
        2,
      );
      await expect(fs.access(path.join(root, KB, 'KnowledgeBase/ok.md'))).rejects.toBeDefined();
    });

    it('appendFile is judged by the file it would leave after the concurrent write', async () => {
      // Appending never adds a role the file had before, so what a race can
      // change is validity: the same line appended to the rewritten file breaks it.
      const rewritten = 'roles:\n  Admin:\n    - a@x.eu';
      const versionControl = racingVersionControl(() => fs.writeFile(path.join(root, ROLES), rewritten));
      await expect(layer(versionControl).appendFile(ROLES, '    - b@x.eu\n')).rejects.toMatchObject({ status: 422, payload: { kind: 'roles-yaml-invalid' } });
      expect(versionControl.releaseLockUntouched).toHaveBeenCalledTimes(1);
      expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(rewritten);
    });

    it('copyFile judges — and writes — the source bytes read under the lock', async () => {
      await fs.writeFile(path.join(root, DRAFT), WITH_PHOENIX);
      const versionControl = racingVersionControl(deletePhoenix);
      await expectRefusedUnderLock(layer(versionControl).copyFile(DRAFT, ROLES, { overwrite: true }), versionControl, 1);
    });

    it('moveFile re-judges with both locks held, and both release untouched', async () => {
      await fs.writeFile(path.join(root, DRAFT), WITH_PHOENIX);
      const versionControl = racingVersionControl(deletePhoenix);
      await expectRefusedUnderLock(layer(versionControl).moveFile(DRAFT, ROLES, { overwrite: true }), versionControl, 2);
      expect(await fs.readFile(path.join(root, DRAFT), 'utf-8')).toBe(WITH_PHOENIX);
    });

    it('a members-only write whose roles all survive the wait still lands', async () => {
      const versionControl = racingVersionControl(() => fs.writeFile(path.join(root, ROLES), `${WITH_PHOENIX}    - q@x.eu\n`));
      await layer(versionControl).writeFile(ROLES, `${CURRENT}    - b@x.eu\n`);
      expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(`${CURRENT}    - b@x.eu\n`);
      expect(versionControl.releaseLock).toHaveBeenCalledTimes(1);
    });

    /** A validator that passes before the lock and refuses under it by throwing a bare string. */
    function refusesUnderLockWith(reason: string) {
      let calls = 0;
      return Object.assign(
        async () => {
          if (++calls > 1) throw reason;
        },
        { appliesTo: (p: string) => p === ROLES },
      );
    }

    it('a check that throws a non-Error still releases untouched, and the caller gets that value', async () => {
      const versionControl = makeVersionControl();
      const fsLayer = new LockingFilesystem(
        { basePath: root, contained: true },
        { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, validateWrite: refusesUnderLockWith('refused') },
      );
      await expect(fsLayer.writeFile(ROLES, CURRENT)).rejects.toBe('refused');
      expect(versionControl.releaseLockUntouched).toHaveBeenCalledTimes(1);
      expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(WITH_PHOENIX);
    });

    it('a move whose check throws a non-Error releases BOTH locks untouched', async () => {
      const versionControl = makeVersionControl();
      const fsLayer = new LockingFilesystem(
        { basePath: root, contained: true },
        { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, validateWrite: refusesUnderLockWith('refused') },
      );
      await expect(fsLayer.moveFile(DRAFT, ROLES, { overwrite: true })).rejects.toBe('refused');
      expect(versionControl.releaseLockUntouched).toHaveBeenCalledTimes(2);
      expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, DRAFT), 'utf-8')).toBe(WITH_PHOENIX);
    });
  });

  it('a copy elsewhere never reads its source for a validator that does not claim the destination', async () => {
    const versionControl = makeVersionControl();
    const validateWrite = Object.assign(vi.fn(), { appliesTo: vi.fn(() => false) });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, validateWrite },
    );
    await fsLayer.copyFile(DRAFT, `${KB}/KnowledgeBase/copy.yaml`);
    expect(validateWrite.appliesTo).toHaveBeenCalledWith(`${KB}/KnowledgeBase/copy.yaml`);
    expect(validateWrite).not.toHaveBeenCalled();
  });
});

/**
 * A move or a copy through this layer never replaces what is at its
 * destination. The tools above it look first, for the sentence; this is the
 * guarantee underneath, which holds for a name claimed after that look — so
 * these call straight onto a taken name, which is what losing the race
 * amounts to.
 */
describe('LockingFilesystem — a destination that is taken is refused, never replaced', () => {
  const SOURCE = `${KB}/KnowledgeBase/source.md`;
  const TAKEN = `${KB}/KnowledgeBase/taken.md`;
  let root: string;
  let fsLayer: LockingFilesystem;

  const onDisk = (rel: string) => path.join(root, rel);

  beforeEach(async () => {
    root = await mkTmpRoot();
    await fs.mkdir(path.join(root, KB, 'KnowledgeBase'), { recursive: true });
    await fs.writeFile(onDisk(SOURCE), 'source');
    fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl: makeVersionControl(), workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses a move onto a taken name with the clash sentence, and keeps both files', async () => {
    await fs.writeFile(onDisk(TAKEN), 'taken');

    await expect(fsLayer.moveFile(SOURCE, TAKEN)).rejects.toMatchObject({
      name: 'DestinationTakenError',
      status: 409,
      message: 'A file named taken.md already exists in KnowledgeBase.',
    });

    expect(await fs.readFile(onDisk(TAKEN), 'utf-8')).toBe('taken');
    expect(await fs.readFile(onDisk(SOURCE), 'utf-8')).toBe('source');
  });

  it('refuses a copy onto a taken name with the same sentence, and copies nothing', async () => {
    await fs.writeFile(onDisk(TAKEN), 'taken');

    await expect(fsLayer.copyFile(SOURCE, TAKEN)).rejects.toMatchObject({
      name: 'DestinationTakenError',
      message: 'A file named taken.md already exists in KnowledgeBase.',
    });

    expect(await fs.readFile(onDisk(TAKEN), 'utf-8')).toBe('taken');
  });

  /**
   * The refusal must not cost a bystander their file. The destination of a
   * lost race holds the WINNER's just-landed move, whose commit is still
   * queued (the worker publishes it out of band). A discarding release resets
   * that path to HEAD — it cannot know the dirty bytes are not the loser's —
   * so unwinding the loser that way deletes the winner's file. The refusal
   * writes nothing (the no-clobber call fails without creating anything), so
   * every lock it unwinds releases untouched.
   */
  it('releases UNTOUCHED when the destination is taken, so a lost race cannot eat the winner', async () => {
    const versionControl = makeVersionControl();
    const layer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fs.writeFile(onDisk(TAKEN), 'the winner of the race');

    await expect(layer.moveFile(SOURCE, TAKEN)).rejects.toMatchObject({ name: 'DestinationTakenError' });

    // Both ends of the move: the destination is the one holding the winner's
    // bytes, and the source was not written either.
    for (const p of [SOURCE, TAKEN]) {
      expect(versionControl.releaseLockUntouched, p).toHaveBeenCalledWith('ws-feat', 'feat', p, USER);
    }
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
    expect(await fs.readFile(onDisk(TAKEN), 'utf-8')).toBe('the winner of the race');
  });

  /**
   * The same race for an EXCLUSIVE write (`overwrite: false`), which is how
   * `copy_file` lands bytes read out of the workspace's tmp folder: the
   * refusal is the clash sentence, and the lock releases untouched rather
   * than discarding the winner's queued file.
   */
  it('an exclusive write onto a taken name is the same refusal, and releases UNTOUCHED', async () => {
    const versionControl = makeVersionControl();
    const layer = new LockingFilesystem(
      { basePath: root, contained: true },
      { versionControl, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fs.writeFile(onDisk(TAKEN), 'the winner of the race');

    await expect(layer.writeFile(TAKEN, 'the loser', { overwrite: false })).rejects.toMatchObject({
      name: 'DestinationTakenError',
      message: 'A file named taken.md already exists in KnowledgeBase.',
    });

    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', TAKEN, USER);
    expect(versionControl.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(versionControl.releaseLock).not.toHaveBeenCalled();
    expect(await fs.readFile(onDisk(TAKEN), 'utf-8')).toBe('the winner of the race');
  });

  it.skipIf(process.platform === 'win32')('answers the clash sentence when a DANGLING link holds the name', async () => {
    // A link to nothing still owns the directory entry, so the exclusive
    // create fails — and an existence probe that follows links would say the
    // name is free and let the raw filesystem error out as a 500 instead.
    await fs.symlink(onDisk(`${KB}/KnowledgeBase/gone.md`), onDisk(TAKEN));

    await expect(fsLayer.copyFile(SOURCE, TAKEN)).rejects.toMatchObject({
      name: 'DestinationTakenError',
      message: 'A file named taken.md already exists in KnowledgeBase.',
    });
    await expect(fsLayer.moveFile(SOURCE, TAKEN)).rejects.toMatchObject({
      name: 'DestinationTakenError',
      message: 'A file named taken.md already exists in KnowledgeBase.',
    });

    expect((await fs.lstat(onDisk(TAKEN))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(onDisk(SOURCE), 'utf-8')).toBe('source');
  });

  it('moves and copies onto a free name exactly as before', async () => {
    await fsLayer.copyFile(SOURCE, `${KB}/KnowledgeBase/copy.md`);
    await fsLayer.moveFile(SOURCE, `${KB}/KnowledgeBase/moved.md`);

    expect(await fs.readFile(onDisk(`${KB}/KnowledgeBase/copy.md`), 'utf-8')).toBe('source');
    expect(await fs.readFile(onDisk(`${KB}/KnowledgeBase/moved.md`), 'utf-8')).toBe('source');
    await expect(fs.access(onDisk(SOURCE))).rejects.toBeDefined();
  });
});
