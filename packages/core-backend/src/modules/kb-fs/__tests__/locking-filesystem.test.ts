import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import { LocalFilesystem } from '@mastra/core/workspace';
import { LockingFilesystem } from '../locking-filesystem.js';
import { PushNeedsAgentResolutionError } from '../../../shared/domain-errors.js';

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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER },
    );
    await fsLayer.writeFile('Knowledge/Foo.md', 'hello\n');

    expect(workflow.acquireLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'Knowledge/Foo.md',
      USER,
    );
    expect(workflow.releaseLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'Knowledge/Foo.md',
      USER,
    );
    // Acquire fires before release.
    const acquireOrder = (workflow.acquireLock as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const releaseOrder = (workflow.releaseLock as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(acquireOrder).toBeLessThan(releaseOrder);
    // The bytes actually landed on disk.
    expect(await fs.readFile(path.join(root, 'Knowledge/Foo.md'), 'utf-8')).toBe('hello\n');
  });

  it('deleteFile acquires + deletes + releases', async () => {
    const filePath = path.join(root, 'a.md');
    await fs.writeFile(filePath, 'x', 'utf-8');
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER },
    );
    await fsLayer.deleteFile('a.md');
    expect(workflow.acquireLock).toHaveBeenCalledWith('ws-feat', 'feat', 'a.md', USER);
    expect(workflow.releaseLock).toHaveBeenCalledWith('ws-feat', 'feat', 'a.md', USER);
    await expect(fs.access(filePath)).rejects.toBeDefined();
  });

  it('mkdir drops a .gitkeep through the lock-aware writeFile so the empty folder is committed', async () => {
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER },
    );
    await fsLayer.mkdir('empty');
    // .gitkeep got written through the lock path. The lock is on the
    // .gitkeep path (that's the file the commit attaches to).
    expect(workflow.acquireLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'empty/.gitkeep',
      USER,
    );
    expect(workflow.releaseLock).toHaveBeenCalledWith(
      'ws-feat',
      'feat',
      'empty/.gitkeep',
      USER,
    );
    expect(await fs.readFile(path.join(root, 'empty/.gitkeep'), 'utf-8')).toBe('');
  });

  it('mkdir of an already-populated dir does NOT drop a .gitkeep', async () => {
    await fs.mkdir(path.join(root, 'has-content'), { recursive: true });
    await fs.writeFile(path.join(root, 'has-content/real.md'), 'hi', 'utf-8');
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER },
    );
    await fsLayer.mkdir('has-content', { recursive: true });
    expect(workflow.acquireLock).not.toHaveBeenCalled();
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    // The existing file is untouched.
    expect(await fs.readFile(path.join(root, 'has-content/real.md'), 'utf-8')).toBe('hi');
  });

  it('rmdir is refused with a clear error — one-change-per-file invariant', async () => {
    await fs.mkdir(path.join(root, 'doomed'), { recursive: true });
    const workflow = makeWorkflow();
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER },
    );
    await expect(fsLayer.rmdir('doomed')).rejects.toThrow(
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
          path: 'Locked.md',
          holderUserId: 'bob',
          holderName: 'Bob',
          acquiredAt: '',
          lastHeartbeatAt: '',
          expiresAt: '',
        },
      });
      const fsLayer = new LockingFilesystem(
        { basePath: root, contained: true },
        { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER },
      );

      await expect(fsLayer.writeFile('Locked.md', 'x')).rejects.toThrow(
        /Skipped editing "Locked\.md" — locked by Bob/,
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER },
    );
    // Path traversal — Mastra's `contained: true` rejects this with a
    // PermissionError. The lock must still go away so the next caller
    // can edit a different file, but releaseLock (which would commit +
    // push whatever partial state is on disk) must NOT fire — instead
    // we use the no-commit variant so partial writes don't silently
    // persist as committed changes.
    await expect(fsLayer.writeFile('../escape.md', 'x')).rejects.toThrow();
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
    await fs.mkdir(path.join(root, 'Tools'), { recursive: true });
    await fs.writeFile(path.join(root, 'Tools/old.tool'), '{}');

    const workflow = makeWorkflow();
    const emitted: unknown[] = [];
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        workflow,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER,
        fileChanges: { emit: (c: unknown) => emitted.push(c) } as never,
      },
    );

    const change = await fsLayer.writeFiles(
      [{ path: 'Tools/new.tool', content: '{"type":"http","url":"https://x/m"}' }],
      'batch',
      ['Tools/old.tool'],
    );

    // Both paths locked; both mutations landed; commit returned.
    expect(workflow.acquireLock).toHaveBeenCalledWith('ws-feat', 'feat', 'Tools/new.tool', USER);
    expect(workflow.acquireLock).toHaveBeenCalledWith('ws-feat', 'feat', 'Tools/old.tool', USER);
    expect(await fs.readFile(path.join(root, 'Tools/new.tool'), 'utf-8')).toContain('http');
    await expect(fs.access(path.join(root, 'Tools/old.tool'))).rejects.toThrow();
    expect(change).toEqual({});
    // ONE event carrying the whole batch (sorted), attributed to the user.
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      workspaceId: 'ws-feat',
      branch: 'feat',
      paths: ['Tools/new.tool', 'Tools/old.tool'],
      byUser: USER,
    });
  });

  it('a failing commit releases every lock WITHOUT committing and emits nothing', async () => {
    await fs.mkdir(path.join(root, 'Tools'), { recursive: true });
    await fs.writeFile(path.join(root, 'Tools/old.tool'), '{}');

    const workflow = makeWorkflow();
    (workflow.commitChanges as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('push exploded'));
    const emitted: unknown[] = [];
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        workflow,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER,
        fileChanges: { emit: (c: unknown) => emitted.push(c) } as never,
      },
    );

    await expect(
      fsLayer.writeFiles(
        [{ path: 'Tools/new.tool', content: '{"type":"http","url":"https://x/m"}' }],
        'batch',
        ['Tools/old.tool'],
      ),
    ).rejects.toThrow('push exploded');

    // Every acquired path goes through the NO-COMMIT release — which is what
    // discards the uncommitted bytes (write reverted, delete restored) in the
    // real WorkflowService via git.discardPath. The committing release must
    // never run, and no change event fires for a failed batch.
    expect(workflow.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', 'Tools/new.tool', USER);
    expect(workflow.releaseLockNoCommit).toHaveBeenCalledWith('ws-feat', 'feat', 'Tools/old.tool', USER);
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
      new PushNeedsAgentResolutionError('feat', 'A.md', 'non-fast-forward', 'rebase failed'),
    );
    const emitted: unknown[] = [];
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        workflow,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER,
        fileChanges: { emit: (c: unknown) => emitted.push(c) } as never,
      },
    );

    await expect(
      fsLayer.writeFiles([{ path: 'A.md', content: 'x' }], 'batch'),
    ).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);

    expect(workflow.releaseLock).toHaveBeenCalledWith('ws-feat', 'feat', 'A.md', USER);
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
        user: USER,
        fileChanges: { emit: (c: unknown) => emitted.push(c) } as never,
      },
    );
    await fsLayer.writeFiles([{ path: 'A.md', content: 'same' }], 'noop');
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    await fsLayer.writeFile('KnowledgeBase/new.md', '# New\n');
    expect(creatorAccess.planForCreate).toHaveBeenCalledWith(
      'ws-feat',
      USER,
      'KnowledgeBase/new.md',
      'file',
    );
    expect(await fs.readFile(path.join(root, 'KnowledgeBase/new.md'), 'utf-8')).toBe(
      '---\nread: Alice <alice@example.com>\n---\n# New\n',
    );
  });

  it('writeFile seeds a subtree access.md (own lock cycle) before the file itself', async () => {
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockImplementation(async (_w, _u, p: string) =>
      p === 'KnowledgeBase/Mine/doc.md'
        ? {
            kind: 'seed-access-md',
            wsRelPath: 'KnowledgeBase/Mine/access.md',
            apply: (current: string) =>
              current + '---\nread:\n  - Alice <alice@example.com>\n---\n',
          }
        : null,
    );
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    await fsLayer.writeFile('KnowledgeBase/Mine/doc.md', 'body');
    const locked = (workflow.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[2],
    );
    expect(locked).toEqual(['KnowledgeBase/Mine/access.md', 'KnowledgeBase/Mine/doc.md']);
    expect(
      await fs.readFile(path.join(root, 'KnowledgeBase/Mine/access.md'), 'utf-8'),
    ).toContain('Alice <alice@example.com>');
    // The file content is untouched — the grant lives in the seeded access.md.
    expect(await fs.readFile(path.join(root, 'KnowledgeBase/Mine/doc.md'), 'utf-8')).toBe('body');
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    await fsLayer.mkdir('KnowledgeBase/Projects');
    expect(
      await fs.readFile(path.join(root, 'KnowledgeBase/Projects/access.md'), 'utf-8'),
    ).toContain('Alice <alice@example.com>');
    await expect(
      fs.access(path.join(root, 'KnowledgeBase/Projects/.gitkeep')),
    ).rejects.toBeDefined();
  });

  it('writeFiles folds seeds into the same atomic batch, deduped across files', async () => {
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'KnowledgeBase/Mine/access.md',
      apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    await fsLayer.writeFiles(
      [
        { path: 'KnowledgeBase/Mine/a.md', content: 'A' },
        { path: 'KnowledgeBase/Mine/b.md', content: 'B' },
      ],
      'batch',
    );
    // One seed for the shared new folder, committed with the batch.
    expect(
      await fs.readFile(path.join(root, 'KnowledgeBase/Mine/access.md'), 'utf-8'),
    ).toContain('Alice <alice@example.com>');
    expect(workflow.commitChanges).toHaveBeenCalledTimes(1);
    const locked = (workflow.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[2],
    );
    expect(locked).toEqual([
      'KnowledgeBase/Mine/a.md',
      'KnowledgeBase/Mine/b.md',
      'KnowledgeBase/Mine/access.md',
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
    await fs.mkdir(path.join(root, 'KnowledgeBase/Mine'), { recursive: true });
    const seedContent = '---\nread:\n  - Alice <alice@example.com>\n---\n';
    await fs.writeFile(path.join(root, 'KnowledgeBase/Mine/access.md'), seedContent);
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'KnowledgeBase/Mine/access.md',
      apply: (current: string) => current, // grant already present → no-op
    });
    const emitted: { paths: string[] }[] = [];
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      {
        workflow,
        workspaceId: 'ws-feat',
        branch: 'feat',
        user: USER,
        creatorAccess,
        fileChanges: { emit: (c: { paths: string[] }) => emitted.push(c) } as never,
      },
    );
    await fsLayer.writeFiles([{ path: 'KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');

    // The seed's lock cycle still ran (acquired + released)...
    const locked = (workflow.acquireLock as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]);
    expect(locked).toContain('KnowledgeBase/Mine/access.md');
    // ...but the commit is scoped to the caller's path only.
    const commitPaths = (workflow.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['KnowledgeBase/Mine/doc.md']);
    expect(emitted[0].paths).toEqual(['KnowledgeBase/Mine/doc.md']);
    // The seeded file is untouched.
    expect(await fs.readFile(path.join(root, 'KnowledgeBase/Mine/access.md'), 'utf-8')).toBe(
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
    await fs.mkdir(path.join(root, 'KnowledgeBase/Mine'), { recursive: true });
    const priorSave = '---\nread:\n  - Alice <alice@example.com>\n---\nprior queued bytes\n';
    await fs.writeFile(path.join(root, 'KnowledgeBase/Mine/access.md'), priorSave);
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockResolvedValue({
      kind: 'seed-access-md',
      wsRelPath: 'KnowledgeBase/Mine/access.md',
      apply: (current: string) => current, // grant already present → no-op
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    await fsLayer.writeFiles([{ path: 'KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');

    // The batch's OWN committed path releases no-commit (clean — discard no-ops)...
    expect(workflow.releaseLockNoCommit).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'KnowledgeBase/Mine/doc.md', USER,
    );
    // ...but the merely-locked seed path releases UNTOUCHED — never the
    // enqueue, never the discard.
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'KnowledgeBase/Mine/access.md', USER,
    );
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalledWith(
      'ws-feat', 'feat', 'KnowledgeBase/Mine/access.md', USER,
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER },
    );
    await expect(
      fsLayer.writeFiles(
        [
          { path: 'A.md', content: 'a' },
          { path: 'B.md', content: 'b' },
        ],
        'batch',
      ),
    ).rejects.toThrow(/locked by Bob/);
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', 'A.md', USER);
    expect(workflow.releaseLock).not.toHaveBeenCalled();
    expect(workflow.releaseLockNoCommit).not.toHaveBeenCalled();
  }, 10_000);

  it('a seed write that dies MID-WRITE restores the pre-image and releases UNTOUCHED', async () => {
    // The partial-write hazard: super.writeFile throws after touching disk,
    // leaving bytes that are neither the old content nor the new. The seed
    // loop read the pre-image under this very lock, so it can put it back —
    // after which the path is byte-identical to before the batch and must
    // release untouched (a prior save's queued bytes, if any, survive).
    await fs.mkdir(path.join(root, 'KnowledgeBase/Mine'), { recursive: true });
    const priorBytes = 'prior queued bytes\n';
    const seedPath = 'KnowledgeBase/Mine/access.md';
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
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
      await fsLayer.writeFiles([{ path: 'KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');
    } finally {
      spy.mockRestore();
    }
    // Pre-image restored — the partial bytes did not outlive the batch.
    expect(await fs.readFile(path.join(root, seedPath), 'utf-8')).toBe(priorBytes);
    // The failed seed stays OUT of the commit scope and releases untouched.
    const commitPaths = (workflow.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['KnowledgeBase/Mine/doc.md']);
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
    await fs.mkdir(path.join(root, 'KnowledgeBase/Mine'), { recursive: true });
    const priorBytes = 'prior queued bytes\n';
    const seedPath = 'KnowledgeBase/Mine/access.md';
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    await expect(
      fsLayer.writeFiles([{ path: 'KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch'),
    ).rejects.toThrow('commit exploded');
    // The landed grant was rolled back to the pre-image, byte-identical…
    expect(await fs.readFile(path.join(root, seedPath), 'utf-8')).toBe(priorBytes);
    // …and the seed releases UNTOUCHED (the prior queued bytes are not this
    // batch's to discard), while the caller's own write releases via discard.
    expect(workflow.releaseLockUntouched).toHaveBeenCalledWith('ws-feat', 'feat', seedPath, USER);
    expect(workflow.releaseLockNoCommit).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'KnowledgeBase/Mine/doc.md', USER,
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
    await fs.mkdir(path.join(root, 'KnowledgeBase/Mine'), { recursive: true });
    const seedPath = 'KnowledgeBase/Mine/access.md';
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    const original = LocalFilesystem.prototype.writeFile;
    const spy = vi
      .spyOn(LocalFilesystem.prototype, 'writeFile')
      .mockImplementation(async function (this: unknown, p, c, o) {
        if (p === seedPath) throw new Error('disk exploded'); // seed write AND restore
        return original.call(this as LocalFilesystem, p, c, o);
      });
    try {
      await fsLayer.writeFiles([{ path: 'KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');
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
    expect(commitPaths).toEqual(['KnowledgeBase/Mine/doc.md']);
  });

  it('push-retry unwind: committed paths re-arm via releaseLock, a merely-locked seed stays untouched', async () => {
    // PushNeedsAgentResolutionError with a no-op seed in the batch: the
    // committed caller path must release commit-on-release (that enqueued row
    // IS the push-retry vehicle), while the seed that never wrote must NOT be
    // swept into the same enqueue — its path may carry a prior save's queued
    // row that a fresh enqueue would re-attribute and reset.
    await fs.mkdir(path.join(root, 'KnowledgeBase/Mine'), { recursive: true });
    const seedPath = 'KnowledgeBase/Mine/access.md';
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
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    await expect(
      fsLayer.writeFiles([{ path: 'KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch'),
    ).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);
    expect(workflow.releaseLock).toHaveBeenCalledWith(
      'ws-feat', 'feat', 'KnowledgeBase/Mine/doc.md', USER,
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
      wsRelPath: 'KnowledgeBase/Mine/access.md',
      apply: () => '---\nread:\n  - Alice <alice@example.com>\n---\n',
    });
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    await fsLayer.writeFiles([{ path: 'KnowledgeBase/Mine/doc.md', content: 'body' }], 'batch');
    const commitPaths = (workflow.commitChanges as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(commitPaths).toEqual(['KnowledgeBase/Mine/doc.md', 'KnowledgeBase/Mine/access.md']);
  });

  it('a planner failure never blocks the write', async () => {
    const workflow = makeWorkflow();
    const creatorAccess = makeCreatorAccess();
    creatorAccess.planForCreate.mockRejectedValue(new Error('planner down'));
    const fsLayer = new LockingFilesystem(
      { basePath: root, contained: true },
      { workflow, workspaceId: 'ws-feat', branch: 'feat', user: USER, creatorAccess },
    );
    await fsLayer.writeFile('KnowledgeBase/new.md', 'x');
    expect(await fs.readFile(path.join(root, 'KnowledgeBase/new.md'), 'utf-8')).toBe('x');
  });
});
