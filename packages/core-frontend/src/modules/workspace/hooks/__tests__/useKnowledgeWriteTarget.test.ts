import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import {
  ACCESS_BATCH_LIMIT,
  READ_CHECK_PARALLEL,
  findKnowledgeReadTarget,
  findKnowledgeWriteTarget,
  knowledgeFoldersInOrder,
} from '../useKnowledgeWriteTarget';

/**
 * Where New page writes: the top of Knowledge, else the folder on screen,
 * else the first folder the person may write in file tree order — asked of
 * the batch access endpoint, which takes at most 500 paths a call.
 */

const { batch, single } = vi.hoisted(() => ({
  batch: vi.fn<(workspaceId: string, paths: string[]) => Promise<{ results: Record<string, boolean> }>>(),
  single: vi.fn<(workspaceId: string, path: string, kind?: 'folder' | 'file') => Promise<{ canRead: boolean }>>(),
}));
vi.mock('../../../access/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../access/api')>()),
  fetchFileAccessBatch: batch,
  fetchFileAccess: single,
}));

const ROOT = 'kb/KnowledgeBase';
let writable = new Set<string>();
let readable = new Set<string>();

beforeEach(() => {
  writable = new Set();
  readable = new Set();
  single.mockReset().mockImplementation(async (_ws, path) => ({ canRead: readable.has(path) }));
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

/**
 * A draft branch: no write grant is needed, only read where the page lands,
 * and the tree shows folders the person may not read when something inside
 * them is shared — so each candidate is asked, in the same order.
 */
describe('findKnowledgeReadTarget', () => {
  const folders = [`${ROOT}/Product`, `${ROOT}/Sales`, `${ROOT}/Sales/Team`, `${ROOT}/Support`];
  const read = (openFolder: string | null, list: string[] = folders) =>
    findKnowledgeReadTarget('ws-1', 'kb', ROOT, openFolder, list);

  it('takes the top of Knowledge when it may be read', async () => {
    readable = new Set(['KnowledgeBase', 'KnowledgeBase/Support']);
    expect(await read(`${ROOT}/Support`)).toBe(ROOT);
    expect(single).toHaveBeenCalledWith('ws-1', 'KnowledgeBase', 'folder');
    expect(batch).not.toHaveBeenCalled();
  });

  it('passes over a top shown only for what is inside it, to the folder on screen, else the first in tree order', async () => {
    readable = new Set(['KnowledgeBase/Sales/Team', 'KnowledgeBase/Support']);
    expect(await read(`${ROOT}/Support`)).toBe(`${ROOT}/Support`);
    expect(await read(`${ROOT}/Product`)).toBe(`${ROOT}/Sales/Team`);
  });

  it('answers null when nothing may be read', async () => {
    expect(await read(null)).toBeNull();
  });

  it('asks a few at a time, stopping at the first group that answers', async () => {
    const many = Array.from({ length: READ_CHECK_PARALLEL * 3 }, (_, i) => `${ROOT}/F${i}`);
    readable = new Set([`KnowledgeBase/F${READ_CHECK_PARALLEL}`]);
    expect(await read(null, many)).toBe(`${ROOT}/F${READ_CHECK_PARALLEL}`);
    // The top and F0…F6, then F7…F14: two groups, never the third.
    expect(single).toHaveBeenCalledTimes(READ_CHECK_PARALLEL * 2);
  });

  it('throws when a request fails, for the hook to read as nowhere', async () => {
    single.mockRejectedValue(new Error('HTTP 500'));
    await expect(read(null)).rejects.toThrow('HTTP 500');
  });
});
