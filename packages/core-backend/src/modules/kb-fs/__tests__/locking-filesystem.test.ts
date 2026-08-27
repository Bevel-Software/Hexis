import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import { LocalFilesystem } from '@mastra/core/workspace';
import { LockingFilesystem } from '../locking-filesystem.js';
import { PushNeedsAgentResolutionError, WorkflowValidationError } from '../../../shared/domain-errors.js';

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
      grantInExtractedFile: vi.fn().mockResolvedValue(null),
      noteAccessFileWritten: vi.fn(),
    };
  }

  it('writeFile runs new content through a frontmatter plan before it lands', async () => {
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'frontmatter',
      apply: (c: string) => `---\nread: Alice <alice@example.com>\n---\n${c}`,
    });
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
    expect(await fs.readFile(path.join(root, 'knowledge-base/KnowledgeBase/new.md'), 'utf-8')).toBe(
      '---\nread: Alice <alice@example.com>\n---\n# New\n',
    );
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

  /**
   * `copyFile` creates a file at `dest` without carrying its bytes, so it used
   * to meet neither gate a `writeFile` to the same path would: not the
   * path-shaped ones, and not the content ones. That made copying the way
   * around both — including onto `roles.yaml`, whose parse guard exists to stop
   * an app-wide admin lockout.
   */
  it('copyFile runs the path gate on its destination', async () => {
    await fs.mkdir(path.join(root, `${KB}/KnowledgeBase`), { recursive: true });
    await fs.writeFile(path.join(root, `${KB}/KnowledgeBase/src.md`), 'x');
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    const validateCreatePath = vi.fn(() => {
      throw new WorkflowValidationError('refused by the path gate');
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess, validateCreatePath },
    );
    await expect(
      fsLayer.copyFile(`${KB}/KnowledgeBase/src.md`, `${KB}/KnowledgeBase/dest.md`),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
    expect(validateCreatePath).toHaveBeenCalledWith(`${KB}/KnowledgeBase/dest.md`);
    // Refused before any side effect: no lock, and nothing at the destination.
    expect(workflow.acquireLock).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, `${KB}/KnowledgeBase/dest.md`))).rejects.toBeDefined();
  });

  it("copyFile runs the content gate with the SOURCE's bytes and the destination path", async () => {
    await fs.mkdir(path.join(root, `${KB}/KnowledgeBase`), { recursive: true });
    await fs.writeFile(path.join(root, `${KB}/KnowledgeBase/src.md`), 'source bytes');
    const workflow = makeWorkflow();
    const { fsLayer, validateWrite } = layer(workflow);
    await fsLayer.copyFile(`${KB}/KnowledgeBase/src.md`, `${KB}/KnowledgeBase/dest.md`);
    // The guard must see what is ACTUALLY about to land at `dest`.
    expect(validateWrite).toHaveBeenCalledWith(`${KB}/KnowledgeBase/dest.md`, 'source bytes');
  });

  it('a content gate that refuses stops the copy before the lock', async () => {
    await fs.mkdir(path.join(root, `${KB}/KnowledgeBase`), { recursive: true });
    await fs.writeFile(path.join(root, `${KB}/KnowledgeBase/src.md`), 'malformed: [');
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    const validateWrite = vi.fn(() => {
      throw new WorkflowValidationError('would not parse');
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, kbDirName: KB, creatorAccess, validateWrite },
    );
    await expect(
      fsLayer.copyFile(`${KB}/KnowledgeBase/src.md`, `${KB}/roles.yaml`),
    ).rejects.toBeInstanceOf(WorkflowValidationError);
    expect(workflow.acquireLock).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, `${KB}/roles.yaml`))).rejects.toBeDefined();
  });

  /**
   * An unreadable source is `super.copyFile`'s failure to report. Inventing one
   * here would answer a missing file with a validation error.
   */
  it('an unreadable source is left to the copy itself to fail on', async () => {
    const workflow = makeWorkflow();
    const { fsLayer, validateWrite } = layer(workflow);
    await expect(
      fsLayer.copyFile(`${KB}/KnowledgeBase/missing.md`, `${KB}/KnowledgeBase/dest.md`),
    ).rejects.toBeDefined();
    expect(validateWrite).not.toHaveBeenCalled();
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
