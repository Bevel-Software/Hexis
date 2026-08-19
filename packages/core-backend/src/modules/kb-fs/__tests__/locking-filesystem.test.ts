import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser, IWorkflowService } from '@bevel-software/platform-shared';
import { LockingFilesystem } from '../locking-filesystem.js';

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
