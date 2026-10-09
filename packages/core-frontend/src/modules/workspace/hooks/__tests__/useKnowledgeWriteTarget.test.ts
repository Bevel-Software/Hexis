import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import {
  ACCESS_BATCH_LIMIT,
  findKnowledgeWriteTarget,
  knowledgeFoldersInOrder,
} from '../useKnowledgeWriteTarget';

/**
 * Where New page writes: the top of Knowledge, else the folder on screen,
 * else the first folder the person may write in file tree order — asked of
 * the batch access endpoint, which takes at most 500 paths a call.
 */

const { batch } = vi.hoisted(() => ({
  batch: vi.fn<(workspaceId: string, paths: string[]) => Promise<{ results: Record<string, boolean> }>>(),
}));
vi.mock('../../../access/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../access/api')>()),
  fetchFileAccessBatch: batch,
}));

const ROOT = 'kb/KnowledgeBase';
let writable = new Set<string>();

beforeEach(() => {
  writable = new Set();
  batch.mockReset().mockImplementation(async (_ws, paths) => ({
    results: Object.fromEntries(paths.map((p) => [p, writable.has(p)])),
  }));
});

const find = (openFolder: string | null, folders: string[]) =>
  findKnowledgeWriteTarget('ws-1', 'kb', ROOT, openFolder, folders);

describe('knowledgeFoldersInOrder', () => {
  it('lists every folder depth first in the tree’s order, skipping files and dot-folders', () => {
    const dir = (relativePath: string, children: FileTreeEntry[] = []): FileTreeEntry => ({
      name: relativePath.split('/').pop()!,
      relativePath,
      type: 'directory',
      children,
    });
    const file = (relativePath: string): FileTreeEntry => ({
      name: relativePath.split('/').pop()!,
      relativePath,
      type: 'file',
    });
    const root = dir(ROOT, [
      file(`${ROOT}/Guide.md`),
      dir(`${ROOT}/.hidden`),
      dir(`${ROOT}/Sales`, [dir(`${ROOT}/Sales/Team`), file(`${ROOT}/Sales/a.md`)]),
      dir(`${ROOT}/Support`),
    ]);
    expect(knowledgeFoldersInOrder(root)).toEqual([`${ROOT}/Sales`, `${ROOT}/Sales/Team`, `${ROOT}/Support`]);
    expect(knowledgeFoldersInOrder(null)).toEqual([]);
  });
});

describe('findKnowledgeWriteTarget', () => {
  const folders = [`${ROOT}/Product`, `${ROOT}/Sales`, `${ROOT}/Support`];

  it('takes the top of Knowledge when it may be written, whatever is on screen', async () => {
    writable = new Set(['KnowledgeBase', 'KnowledgeBase/Support']);
    expect(await find(`${ROOT}/Support`, folders)).toBe(ROOT);
  });

  it('else the folder on screen, asked repo-relative and once', async () => {
    writable = new Set(['KnowledgeBase/Sales', 'KnowledgeBase/Support']);
    expect(await find(`${ROOT}/Support`, folders)).toBe(`${ROOT}/Support`);
    expect(batch).toHaveBeenCalledWith('ws-1', [
      'KnowledgeBase',
      'KnowledgeBase/Support',
      'KnowledgeBase/Product',
      'KnowledgeBase/Sales',
    ]);
  });

  it('else the first folder in tree order', async () => {
    writable = new Set(['KnowledgeBase/Sales', 'KnowledgeBase/Support']);
    expect(await find(`${ROOT}/Product`, folders)).toBe(`${ROOT}/Sales`);
  });

  it('answers null when there is nowhere', async () => {
    expect(await find(null, folders)).toBeNull();
  });

  it('asks in pages the endpoint accepts, stopping at the first that answers', async () => {
    const many = Array.from({ length: ACCESS_BATCH_LIMIT * 2 + 10 }, (_, i) => `${ROOT}/F${i}`);
    writable = new Set([`KnowledgeBase/F${ACCESS_BATCH_LIMIT + 3}`, `KnowledgeBase/F${ACCESS_BATCH_LIMIT * 2 + 5}`]);
    expect(await find(null, many)).toBe(`${ROOT}/F${ACCESS_BATCH_LIMIT + 3}`);
    expect(batch).toHaveBeenCalledTimes(2);
    for (const call of batch.mock.calls) expect(call[1].length).toBeLessThanOrEqual(ACCESS_BATCH_LIMIT);
  });

  it('throws when the request fails, for the hook to read as nowhere', async () => {
    batch.mockRejectedValue(new Error('HTTP 500'));
    await expect(find(null, folders)).rejects.toThrow('HTTP 500');
  });
});
