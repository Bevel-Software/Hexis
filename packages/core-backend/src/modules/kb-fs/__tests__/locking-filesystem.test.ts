import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import { LocalFilesystem } from '@mastra/core/workspace';
import { LockingFilesystem } from '../locking-filesystem.js';
import { PushNeedsAgentResolutionError, WorkflowValidationError } from '../../../shared/domain-errors.js';
import {
  makeAgentRolesYamlWriteValidator,
  RolesYamlInvalidError,
  RolesYamlNewRoleError,
} from '../../access-model/roles-yaml-guard.js';

/** The clone folder at the workspace root: every path the filesystem mutates lives under it. */
const KB = 'knowledge-base';

const USER: AuthUser = {
  id: 'user-1',
  email: 'alice@example.com',
  name: 'Alice',
};

function makeWorkflow(): IWorkflowService {
  return {
    acquireLock: vi.fn().mockResolvedValue({
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
    }),
    releaseLock: vi.fn().mockResolvedValue(null),
    releaseLockNoCommit: vi.fn().mockResolvedValue(undefined),
    releaseLockUntouched: vi.fn().mockResolvedValue(undefined),
    heartbeatLock: vi.fn(),
    getLock: vi.fn(),
    commitFileWhileLocked: vi.fn(),
    commitChanges: vi.fn().mockResolvedValue({}),
  } as unknown as IWorkflowService;
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
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fsLayer.writeFile('knowledge-base/Knowledge/Foo.md', 'hello\n');

    expect(workflow.acquireLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'knowledge-base/Knowledge/Foo.md',
      USER,
    );
    expect(workflow.releaseLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'knowledge-base/Knowledge/Foo.md',
      USER,
    );
    // Acquire fires before release.
    const acquireOrder = (workflow.acquireLock as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const releaseOrder = (workflow.releaseLock as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(releaseOrder);
    // The bytes actually landed on disk.
    expect(await fs.readFile(path.join(root, 'knowledge-base/Knowledge/Foo.md'), 'utf-8')).toBe('hello\n');
  });

  it('deleteFile acquires + deletes + releases', async () => {
    const filePath = path.join(root, 'knowledge-base/a.md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'x', 'utf-8');
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fsLayer.deleteFile('knowledge-base/a.md');
    expect(workflow.acquireLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/a.md', USER);
    expect(workflow.releaseLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/a.md', USER);
    await expect(fs.access(filePath)).rejects.toBeDefined();
  });

  it('mkdir drops a .gitkeep through the lock-aware writeFile so the empty folder is committed', async () => {
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fsLayer.mkdir('knowledge-base/empty');
    // .gitkeep got written through the lock path. The lock is on the
    // .gitkeep path (that's the file the commit attaches to).
    expect(workflow.acquireLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'knowledge-base/empty/.gitkeep',
      USER,
    );
    expect(workflow.releaseLock).toHaveBeenCalledWith(
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
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fsLayer.mkdir('knowledge-base/has-content', { recursive: true });
    expect(workflow.acquireLock).not.toHaveBeenCalled();
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    // The existing file is untouched.
    expect(await fs.readFile(path.join(root, 'knowledge-base/has-content/real.md'), 'utf-8')).toBe('hi');
  });

  it('rmdir is refused with a clear error — one-change-per-file invariant', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/doomed'), { recursive: true });
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await expect(fsLayer.rmdir('knowledge-base/doomed')).rejects.toThrow(
      /Recursive directory removal is not supported/i,
    );
    expect(workflow.acquireLock).not.toHaveBeenCalled();
  });

  it(
    'retries acquire on contention then surfaces a skip error after 3 attempts',
    async () => {
      // 3 attempts × 2s ≈ 6s — bump vitest's default timeout for this one test.
      const workflow = makeWorkflow();
      (workflow.acquireLock as ReturnType<typeof vi.fn>).mockResolvedValue({
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
        { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
      );

      await expect(fsLayer.writeFile('knowledge-base/Locked.md', 'x')).rejects.toThrow(
        /Skipped editing "knowledge-base\/Locked\.md" — locked by Bob/,
      );
      expect(workflow.acquireLock).toHaveBeenCalledTimes(3);
      expect(workflow.releaseLock).not.toHaveBeenCalled();
    },
    10_000,
  );

  it('drops the lock without committing when the underlying write throws', async () => {
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
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
    expect(workflow.acquireLock).toHaveBeenCalled();
    expect(workflow.releaseLockNoCommit).toHaveBeenCalled();
    expect(workflow.releaseLock).not.toHaveBeenCalled();
  });
});

describe('LockingFilesystem.writeFiles — batch with deletes + one batched change event', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('locks writes AND deletes, applies both, emits ONE batched onFilesChanged', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/Tools'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Tools/old.tool'), '{}');

    const workflow = makeWorkflow();
    const emitted: unknown[] = [];
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        workflow,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER, kbDirName: KB,
        fileChanges: { emit: (c: unknown) => emitted.push(c) } as never,
      },
    );

    const change = await fsLayer.writeFiles(
      [{ path: 'knowledge-base/Tools/new.tool', content: '{"type":"http","url":"https://x/m"}' }],
      'batch',
      ['knowledge-base/Tools/old.tool'],
    );

    // Both paths locked; both mutations landed; commit returned.
    expect(workflow.acquireLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Tools/new.tool', USER);
    expect(workflow.acquireLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Tools/old.tool', USER);
    expect(await fs.readFile(path.join(root, 'knowledge-base/Tools/new.tool'), 'utf-8')).toContain('http');
    await expect(fs.access(path.join(root, 'knowledge-base/Tools/old.tool'))).rejects.toThrow();
    expect(change).toEqual({});
    // ONE event carrying the whole batch (sorted), attributed to the user.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      workspaceId: 'ws-feat',
      branch: 'feat',
      paths: ['knowledge-base/Tools/new.tool', 'knowledge-base/Tools/old.tool'],
      byUser: USER,
    });
  });

  it('a failing commit releases every lock WITHOUT committing and emits nothing', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/Tools'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Tools/old.tool'), '{}');

    const workflow = makeWorkflow();
    (workflow.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('push exploded'));
    const emitted: unknown[] = [];
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        workflow,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER, kbDirName: KB,
        fileChanges: { emit: (c: unknown) => emitted.push(c) } as never,
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
    // real WorkflowService via git.discardPath. The committing release must
    // never run, and no change event fires for a failed batch.
    expect(workflow.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Tools/new.tool', USER);
    expect(workflow.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Tools/old.tool', USER);
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('a POST-commit push failure releases WITH commit-on-release (arms the worker retry), never the discard path', async () => {
    // PushNeedsAgentResolutionError means the commit LANDED and only the push
    // needs help. Routing it through releaseLockNoCommit would leave the
    // landed commit with no retry vehicle — the next identical write would
    // no-op against the committed bytes and the change stays unpublished
    // forever. The batch must releaseLock (the enqueued release commit no-ops
    // on the clean tree and the worker's unpushed-commits check re-runs the
    // push ladder) and still propagate the error.
    const workflow = makeWorkflow();
    (workflow.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PushNeedsAgentResolutionError('feat', 'knowledge-base/A.md', 'non-fast-forward', 'rebase failed'),
    );
    const emitted: unknown[] = [];
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        workflow,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER, kbDirName: KB,
        fileChanges: { emit: (c: unknown) => emitted.push(c) } as never,
      },
    );

    await expect(
      fsLayer.writeFiles([{ path: 'knowledge-base/A.md', content: 'x' }], 'batch'),
    ).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);

    expect(workflow.releaseLock).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/A.md', USER);
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it('emits nothing on a no-op commit (clean tree)', async () => {
    const workflow = makeWorkflow();
    (workflow.commitChanges as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const emitted: unknown[] = [];
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        workflow,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER, kbDirName: KB,
        fileChanges: { emit: (c: unknown) => emitted.push(c) } as never,
      },
    );
    await fsLayer.writeFiles([{ path: 'knowledge-base/A.md', content: 'same' }], 'noop');
    expect(emitted).toHaveLength(0);
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

  const layer = (workflow: IWorkflowService): LockingFilesystem =>
    new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );

  it('writeFile runs the check with the lock HELD and before any byte lands', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Foo.md'), 'before\n');

    const workflow = makeWorkflow();
    const order: string[] = [];
    (workflow.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('acquire');
      return { acquired: true, lock: { holderName: 'Alice' } };
    });

    await layer(workflow).writeFile('knowledge-base/Foo.md', 'after\n', undefined, async () => {
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

    const workflow = makeWorkflow();
    const refusal = new Error('already exists');
    await expect(
      layer(workflow).writeFile('knowledge-base/Foo.md', 'mine\n', undefined, () => {
        throw refusal;
      }),
    ).rejects.toBe(refusal);

    expect(await fs.readFile(path.join(root, 'knowledge-base/Foo.md'), 'utf-8')).toBe('theirs\n');
    // Untouched, never no-commit: a discard would reset the path to HEAD and
    // destroy whatever save left those bytes there.
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/Foo.md', USER);
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(workflow.releaseLock).not.toHaveBeenCalled();
  });

  it('writeFiles runs its check once EVERY lock is held, and lands only what the check keeps', async () => {
    const workflow = makeWorkflow();
    const acquired: string[] = [];
    (workflow.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async (_w, _b, p: string) => {
      acquired.push(p);
      return { acquired: true, lock: { holderName: 'Alice' } };
    });

    const writes = [
      { path: 'knowledge-base/a.md', content: 'A' },
      { path: 'knowledge-base/b.md', content: 'B' },
      { path: 'knowledge-base/c.md', content: 'C' },
    ];
    await layer(workflow).writeFiles(writes, 'batch', [], async (pending) => {
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
    expect(workflow.commitChanges).toHaveBeenCalledWith('ws-feat', USER, 'batch', [
      'knowledge-base/a.md',
      'knowledge-base/c.md',
    ]);
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/b.md', USER);
  });

  it('a writeFiles check that drops EVERY write commits nothing and releases everything untouched', async () => {
    const workflow = makeWorkflow();
    const change = await layer(workflow).writeFiles(
      [{ path: 'knowledge-base/a.md', content: 'A' }],
      'batch',
      [],
      async () => [],
    );

    expect(change).toBeNull();
    await expect(fs.access(path.join(root, 'knowledge-base/a.md'))).rejects.toThrow();
    expect(workflow.commitChanges).not.toHaveBeenCalled();
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/a.md', USER);
  });

  it('a writeFiles check that THROWS refuses the whole batch, untouched', async () => {
    const workflow = makeWorkflow();
    const refusal = new Error('nope');
    await expect(
      layer(workflow).writeFiles(
        [{ path: 'knowledge-base/a.md', content: 'A' }, { path: 'knowledge-base/b.md', content: 'B' }],
        'batch',
        [],
        async () => {
          throw refusal;
        },
      ),
    ).rejects.toBe(refusal);

    await expect(fs.access(path.join(root, 'knowledge-base/a.md'))).rejects.toThrow();
    expect(workflow.commitChanges).not.toHaveBeenCalled();
    expect(workflow.releaseLockUntouched).toHaveBeenCalledTimes(2);
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
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
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
    const workflow = makeWorkflow();
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.writeFile('knowledge-base/KnowledgeBase/Mine/doc.md', 'body');
    const locked = (workflow.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map(
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
    const workflow = makeWorkflow();
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
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
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
      apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
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
    expect(workflow.commitChanges).toHaveBeenCalledTimes(1);
    const locked = (workflow.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map(
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
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
      apply: (current: string) => current, // grant already present → no-op
    });
    const emitted: { paths: string[] }[] = [];
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        workflow,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER, kbDirName: KB,
        creatorAccess,
        fileChanges: { emit: (c: { paths: string[] }) => emitted.push(c) } as never,
      },
    );
    await fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');

    // The seed's lock cycle still ran (acquired + released)...
    const locked = (workflow.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]);
    expect(locked).toContain('knowledge-base/KnowledgeBase/Mine/access.md');
    // ...but the commit is scoped to the caller's path only.
    const commitPaths = (workflow.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['knowledge-base/KnowledgeBase/Mine/doc.md']);
    expect(emitted[0].paths).toEqual(['knowledge-base/KnowledgeBase/Mine/doc.md']);
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
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
      apply: (current: string) => current, // grant already present → no-op
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');

    // The batch's OWN committed path releases no-commit (clean — discard no-ops)...
    expect(workflow.releaseLockNoCommit).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/doc.md', USER,
    );
    // ...but the merely-locked seed path releases UNTOUCHED — never the
    // enqueue, never the discard.
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/access.md', USER,
    );
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/access.md', USER,
    );
  });

  it('locks acquired before an acquire CONTENTION release UNTOUCHED (nothing written yet)', async () => {
    // First path acquires, second is contended: nothing has been written, so
    // the first path may hold ONLY someone else's still-queued bytes — the
    // unwind must neither discard them nor enqueue them under this user.
    const workflow = makeWorkflow();
    (workflow.acquireLock as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ acquired: true, lock: { holderUserId: 'user-1', holderName: 'Alice' } })
      .mockResolvedValue({ acquired: false, lock: { holderUserId: 'bob', holderName: 'Bob' } });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await expect(
      fsLayer.writeFiles(
        [
          { path: 'knowledge-base/A.md', content: 'a' },
          { path: 'knowledge-base/B.md', content: 'b' },
        ],
        'batch',
      ),
    ).rejects.toThrow(/locked by Bob/);
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'knowledge-base/A.md', USER);
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
  }, 10_000);

  it('a DELETE batch whose later lock is contended deletes nothing — a folder never half-disappears', async () => {
    // The all-or-none property `delete_folder` relies on, asserted on disk:
    // every lock is taken before the first delete, so a contended path means
    // no file under the folder is gone and nothing is committed.
    await fs.mkdir(path.join(root, 'knowledge-base/Archive'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/Archive/a.md'), 'a');
    await fs.writeFile(path.join(root, 'knowledge-base/Archive/b.md'), 'b');
    const workflow = makeWorkflow();
    (workflow.acquireLock as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ acquired: true, lock: { holderUserId: 'user-1', holderName: 'Alice' } })
      .mockResolvedValue({ acquired: false, lock: { holderUserId: 'bob', holderName: 'Bob' } });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );

    await expect(
      fsLayer.writeFiles([], 'Delete Archive', ['knowledge-base/Archive/a.md', 'knowledge-base/Archive/b.md']),
    ).rejects.toThrow(/locked by Bob/);

    expect(await fs.readFile(path.join(root, 'knowledge-base/Archive/a.md'), 'utf-8')).toBe('a');
    expect(await fs.readFile(path.join(root, 'knowledge-base/Archive/b.md'), 'utf-8')).toBe('b');
    expect(workflow.commitChanges).not.toHaveBeenCalled();
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
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: seedPath,
      apply: (current: string) => current + 'read: Alice\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
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
    const commitPaths = (workflow.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['knowledge-base/KnowledgeBase/Mine/doc.md']);
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalledWith(
      'ws-feat', 'feat', seedPath, USER,
    );
    expect(workflow.releaseLock).not.toHaveBeenCalled();
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
    const workflow = makeWorkflow();
    (workflow.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValue(
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await expect(
      fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch'),
    ).rejects.toThrow('commit exploded');
    // The landed grant was rolled back to the pre-image, byte-identical…
    expect(await fs.readFile(path.join(root, seedPath), 'utf-8')).toBe(priorBytes);
    // …and the seed releases UNTOUCHED (the prior queued bytes are not this
    // batch's to discard), while the caller's own write releases via discard.
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(workflow.releaseLockNoCommit).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/doc.md', USER,
    );
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalledWith(
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
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: seedPath,
      apply: (current: string) => current + 'read: Alice\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
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
    expect(workflow.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(workflow.releaseLockUntouched).not.toHaveBeenCalledWith(
      'ws-feat', 'feat', seedPath, USER,
    );
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    const commitPaths = (workflow.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
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
    const workflow = makeWorkflow();
    (workflow.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValue(
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await expect(
      fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch'),
    ).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);
    expect(workflow.releaseLock).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'knowledge-base/KnowledgeBase/Mine/doc.md', USER,
    );
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(workflow.releaseLock).not.toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
  });

  it('a LANDED seed rides the commit scope with the caller paths', async () => {
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'knowledge-base/KnowledgeBase/Mine/access.md',
      apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
    );
    await fsLayer.writeFiles([{ path: 'knowledge-base/KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');
    const commitPaths = (workflow.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['knowledge-base/KnowledgeBase/Mine/doc.md', 'knowledge-base/KnowledgeBase/Mine/access.md']);
  });

  it('a planner failure never blocks the write', async () => {
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockRejectedValue(new Error('planner down'));
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess },
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

  function layer(workflow: IWorkflowService) {
    const creatorAccess = makeCreatorAccess();
    const validateWrite = vi.fn();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess, validateWrite },
    );
    return { fsLayer, creatorAccess, validateWrite };
  }

  async function expectRefused(
    op: Promise<unknown>,
    workflow: IWorkflowService,
    creatorAccess: ReturnType<typeof makeCreatorAccess>,
    validateWrite: ReturnType<typeof vi.fn>,
  ): Promise<void> {
    await expect(op).rejects.toBeInstanceOf(WorkflowValidationError);
    // The corrected path is spelled out, under the clone folder.
    await expect(op).rejects.toThrow('"knowledge-base/KnowledgeBase/Reviews');
    // Refused before any side effect.
    expect(workflow.acquireLock).not.toHaveBeenCalled();
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(workflow.commitChanges).not.toHaveBeenCalled();
    expect(creatorAccess.planForCreate).not.toHaveBeenCalled();
    expect(validateWrite).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'KnowledgeBase'))).rejects.toBeDefined();
  }

  it('writeFile', async () => {
    const workflow = makeWorkflow();
    const { fsLayer, creatorAccess, validateWrite } = layer(workflow);
    await expectRefused(fsLayer.writeFile(STRAY, '<p>review</p>'), workflow, creatorAccess, validateWrite);
  });

  it('appendFile', async () => {
    const workflow = makeWorkflow();
    const { fsLayer, creatorAccess, validateWrite } = layer(workflow);
    await expectRefused(fsLayer.appendFile('KnowledgeBase/Reviews/review.log', 'line\n'), workflow, creatorAccess, validateWrite);
  });

  it('writeFiles refuses the whole batch when one path is outside: nothing written, nothing locked', async () => {
    const workflow = makeWorkflow();
    const { fsLayer, creatorAccess, validateWrite } = layer(workflow);
    await expectRefused(
      fsLayer.writeFiles(
        [
          { path: 'knowledge-base/KnowledgeBase/ok.md', content: 'fine' },
          { path: STRAY, content: '<p>review</p>' },
        ],
        'batch',
      ),
      workflow,
      creatorAccess,
      validateWrite,
    );
    await expect(fs.access(path.join(root, 'knowledge-base/KnowledgeBase/ok.md'))).rejects.toBeDefined();
  });

  it('mkdir', async () => {
    const workflow = makeWorkflow();
    const { fsLayer, creatorAccess, validateWrite } = layer(workflow);
    await expectRefused(fsLayer.mkdir('KnowledgeBase/Reviews'), workflow, creatorAccess, validateWrite);
  });

  it('moveFile refuses a destination outside the repository and leaves the source in place', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/KnowledgeBase/PR-12.html'), 'x');
    const workflow = makeWorkflow();
    const { fsLayer, creatorAccess, validateWrite } = layer(workflow);
    await expectRefused(
      fsLayer.moveFile('knowledge-base/KnowledgeBase/PR-12.html', STRAY),
      workflow,
      creatorAccess,
      validateWrite,
    );
    expect(await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/PR-12.html'), 'utf-8')).toBe('x');
  });

  it('copyFile refuses a destination outside the repository', async () => {
    await fs.mkdir(path.join(root, 'knowledge-base/KnowledgeBase'), { recursive: true });
    await fs.writeFile(path.join(root, 'knowledge-base/KnowledgeBase/PR-12.html'), 'x');
    const workflow = makeWorkflow();
    const { fsLayer, creatorAccess, validateWrite } = layer(workflow);
    await expectRefused(
      fsLayer.copyFile('knowledge-base/KnowledgeBase/PR-12.html', STRAY),
      workflow,
      creatorAccess,
      validateWrite,
    );
  });

  it('a `..` under the prefix is refused before the lock: the bytes would land beside the clone', async () => {
    // Containment is checked against the WORKSPACE dir, so the underlying
    // filesystem would happily resolve `knowledge-base/../stray.md` to a file
    // next to the clone. The prefix alone is not proof of being inside.
    const workflow = makeWorkflow();
    const { fsLayer, creatorAccess, validateWrite } = layer(workflow);
    await expect(fsLayer.writeFile('knowledge-base/../stray.md', 'x')).rejects.toBeInstanceOf(WorkflowValidationError);
    expect(workflow.acquireLock).not.toHaveBeenCalled();
    expect(creatorAccess.planForCreate).not.toHaveBeenCalled();
    expect(validateWrite).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'stray.md'))).rejects.toBeDefined();
  });

  it('the folder is matched as a whole segment: `knowledge-based/x.md` is outside too', async () => {
    const workflow = makeWorkflow();
    const { fsLayer } = layer(workflow);
    await expect(fsLayer.writeFile('knowledge-based/x.md', 'x')).rejects.toBeInstanceOf(WorkflowValidationError);
    expect(workflow.acquireLock).not.toHaveBeenCalled();
  });

  it('deleteFile still removes a file the old behaviour left beside the repository', async () => {
    // Removal is deliberately not gated: an agent that discovers a stray it
    // created before this guard existed must be able to clean it up.
    await fs.mkdir(path.join(root, 'KnowledgeBase/Reviews'), { recursive: true });
    await fs.writeFile(path.join(root, STRAY), 'stray');
    const workflow = makeWorkflow();
    const { fsLayer } = layer(workflow);
    await fsLayer.deleteFile(STRAY);
    await expect(fs.access(path.join(root, STRAY))).rejects.toBeDefined();
  });

  it('moveFile still rescues a stray INTO the repository', async () => {
    await fs.mkdir(path.join(root, 'KnowledgeBase/Reviews'), { recursive: true });
    await fs.writeFile(path.join(root, STRAY), 'stray');
    await fs.mkdir(path.join(root, 'knowledge-base'), { recursive: true });
    const workflow = makeWorkflow();
    const { fsLayer } = layer(workflow);
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

  function layer(workflow: IWorkflowService) {
    const validateWrite = makeAgentRolesYamlWriteValidator(KB, () =>
      fs.readFile(path.join(root, ROLES), 'utf-8').catch(() => null),
    );
    return new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, validateWrite },
    );
  }

  async function expectRefused(op: Promise<unknown>, workflow: IWorkflowService): Promise<void> {
    await expect(op).rejects.toBeInstanceOf(RolesYamlNewRoleError);
    expect(workflow.acquireLock).not.toHaveBeenCalled();
    expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(CURRENT);
  }

  it('writeFile', async () => {
    const workflow = makeWorkflow();
    await expectRefused(layer(workflow).writeFile(ROLES, CURRENT + NEW_ROLE), workflow);
  });

  it('writeFiles refuses the whole batch', async () => {
    const workflow = makeWorkflow();
    await expectRefused(
      layer(workflow).writeFiles([{ path: `${KB}/KnowledgeBase/ok.md`, content: 'fine' }, { path: ROLES, content: CURRENT + NEW_ROLE }], 'batch'),
      workflow,
    );
    await expect(fs.access(path.join(root, KB, 'KnowledgeBase/ok.md'))).rejects.toBeDefined();
  });

  it('appendFile, judged by the file it would leave', async () => {
    const workflow = makeWorkflow();
    await expectRefused(layer(workflow).appendFile(ROLES, NEW_ROLE), workflow);
  });

  it('copyFile, judged by the source bytes', async () => {
    const workflow = makeWorkflow();
    await expectRefused(layer(workflow).copyFile(DRAFT, ROLES, { overwrite: true }), workflow);
  });

  it('moveFile, leaving the source where it was', async () => {
    const workflow = makeWorkflow();
    await expectRefused(layer(workflow).moveFile(DRAFT, ROLES, { overwrite: true }), workflow);
    expect(await fs.readFile(path.join(root, DRAFT), 'utf-8')).toBe(CURRENT + NEW_ROLE);
  });

  it('a members-only write and append land as before', async () => {
    const workflow = makeWorkflow();
    const fsLayer = layer(workflow);
    await fsLayer.writeFile(ROLES, `${CURRENT}    - b@x.eu\n`);
    await fsLayer.appendFile(ROLES, '    - c@x.eu\n');
    expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(`${CURRENT}    - b@x.eu\n    - c@x.eu\n`);
    expect(workflow.releaseLock).toHaveBeenCalledTimes(2);
  });

  describe('judged again under the lock, against what a concurrent writer left there', () => {
    const WITH_PHOENIX = CURRENT + NEW_ROLE;

    /** A workflow whose acquire lets `race` rewrite disk first — the lock holder that finished just before us. */
    function racingWorkflow(race: () => Promise<void>): IWorkflowService {
      const workflow = makeWorkflow();
      const acquired = (workflow.acquireLock as ReturnType<typeof vi.fn>).getMockImplementation()!;
      let raced = false;
      (workflow.acquireLock as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => {
        if (!raced) {
          raced = true;
          await race();
        }
        return acquired(...args);
      });
      return workflow;
    }

    async function expectRefusedUnderLock(op: Promise<unknown>, workflow: IWorkflowService, locks: number): Promise<void> {
      await expect(op).rejects.toBeInstanceOf(RolesYamlNewRoleError);
      expect(workflow.releaseLockUntouched).toHaveBeenCalledTimes(locks);
      expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
      expect(workflow.releaseLock).not.toHaveBeenCalled();
      expect(workflow.commitChanges).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(CURRENT);
    }

    const deletePhoenix = () => fs.writeFile(path.join(root, ROLES), CURRENT);

    beforeEach(async () => {
      await fs.writeFile(path.join(root, ROLES), WITH_PHOENIX);
    });

    it('writeFile cannot reinstate a role deleted while it waited for the lock', async () => {
      const workflow = racingWorkflow(deletePhoenix);
      await expectRefusedUnderLock(layer(workflow).writeFile(ROLES, `${WITH_PHOENIX}    - q@x.eu\n`), workflow, 1);
    });

    it('writeFiles re-judges the whole batch once every lock is held', async () => {
      const workflow = racingWorkflow(deletePhoenix);
      await expectRefusedUnderLock(
        layer(workflow).writeFiles([{ path: `${KB}/KnowledgeBase/ok.md`, content: 'fine' }, { path: ROLES, content: WITH_PHOENIX }], 'batch'),
        workflow,
        2,
      );
      await expect(fs.access(path.join(root, KB, 'KnowledgeBase/ok.md'))).rejects.toBeDefined();
    });

    it('appendFile is judged by the file it would leave after the concurrent write', async () => {
      // Appending never adds a role the file had before, so what a race can
      // change is validity: the same line appended to the rewritten file breaks it.
      const rewritten = 'roles:\n  Admin:\n    - a@x.eu';
      const workflow = racingWorkflow(() => fs.writeFile(path.join(root, ROLES), rewritten));
      await expect(layer(workflow).appendFile(ROLES, '    - b@x.eu\n')).rejects.toBeInstanceOf(RolesYamlInvalidError);
      expect(workflow.releaseLockUntouched).toHaveBeenCalledTimes(1);
      expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(rewritten);
    });

    it('copyFile judges — and writes — the source bytes read under the lock', async () => {
      await fs.writeFile(path.join(root, DRAFT), WITH_PHOENIX);
      const workflow = racingWorkflow(deletePhoenix);
      await expectRefusedUnderLock(layer(workflow).copyFile(DRAFT, ROLES, { overwrite: true }), workflow, 1);
    });

    it('moveFile re-judges with both locks held, and both release untouched', async () => {
      await fs.writeFile(path.join(root, DRAFT), WITH_PHOENIX);
      const workflow = racingWorkflow(deletePhoenix);
      await expectRefusedUnderLock(layer(workflow).moveFile(DRAFT, ROLES, { overwrite: true }), workflow, 2);
      expect(await fs.readFile(path.join(root, DRAFT), 'utf-8')).toBe(WITH_PHOENIX);
    });

    it('a members-only write whose roles all survive the wait still lands', async () => {
      const workflow = racingWorkflow(() => fs.writeFile(path.join(root, ROLES), `${WITH_PHOENIX}    - q@x.eu\n`));
      await layer(workflow).writeFile(ROLES, `${CURRENT}    - b@x.eu\n`);
      expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(`${CURRENT}    - b@x.eu\n`);
      expect(workflow.releaseLock).toHaveBeenCalledTimes(1);
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
      const workflow = makeWorkflow();
      const fsLayer = new LockingFilesystem(
        { basePath: root, contained: true },
        { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, validateWrite: refusesUnderLockWith('refused') },
      );
      await expect(fsLayer.writeFile(ROLES, CURRENT)).rejects.toBe('refused');
      expect(workflow.releaseLockUntouched).toHaveBeenCalledTimes(1);
      expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, ROLES), 'utf-8')).toBe(WITH_PHOENIX);
    });

    it('a move whose check throws a non-Error releases BOTH locks untouched', async () => {
      const workflow = makeWorkflow();
      const fsLayer = new LockingFilesystem(
        { basePath: root, contained: true },
        { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, validateWrite: refusesUnderLockWith('refused') },
      );
      await expect(fsLayer.moveFile(DRAFT, ROLES, { overwrite: true })).rejects.toBe('refused');
      expect(workflow.releaseLockUntouched).toHaveBeenCalledTimes(2);
      expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(root, DRAFT), 'utf-8')).toBe(WITH_PHOENIX);
    });
  });

  it('a copy elsewhere never reads its source for a validator that does not claim the destination', async () => {
    const workflow = makeWorkflow();
    const validateWrite = Object.assign(vi.fn(), { appliesTo: vi.fn(() => false) });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, validateWrite },
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
      { workflow: makeWorkflow(), workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
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
    const workflow = makeWorkflow();
    const layer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB },
    );
    await fs.writeFile(onDisk(TAKEN), 'the winner of the race');

    await expect(layer.moveFile(SOURCE, TAKEN)).rejects.toMatchObject({ name: 'DestinationTakenError' });

    // Both ends of the move: the destination is the one holding the winner's
    // bytes, and the source was not written either.
    for (const p of [SOURCE, TAKEN]) {
      expect(workflow.releaseLockUntouched, p).toHaveBeenCalledWith('ws-feat', 'feat', p, USER);
    }
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
    expect(workflow.releaseLock).not.toHaveBeenCalled();
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
