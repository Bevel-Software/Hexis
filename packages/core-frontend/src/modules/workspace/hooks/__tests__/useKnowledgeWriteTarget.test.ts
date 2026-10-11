import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { FileTreeEntry } from '@bevel-software/platform-shared';

/**
 * Where New page writes, through the hook alone: the top of Knowledge, else
 * the folder on screen, else the first folder the person may write in file
 * tree order — asked of the batch access endpoint (at most 500 paths a call):
 * who may write on a protected branch, who may read on a draft.
 */

type Verb = 'write' | 'owner' | 'read';
const { batch, workspace, merged } = vi.hoisted(() => ({
  batch: vi.fn<(workspaceId: string, paths: string[], verb?: Verb) => Promise<{ results: Record<string, boolean> }>>(),
  workspace: {
    current: {
      workspaceId: 'ws-1',
      workspaceBranch: 'target-company-state' as string | null,
      kbDirName: 'kb',
      openFilePath: null as string | null,
    },
  },
  merged: { tree: null as FileTreeEntry | null },
}));
vi.mock('../../../access/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../access/api')>()),
  fetchFileAccessBatch: batch,
}));
vi.mock('../../state/workspace.context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state/workspace.context')>()),
  useWorkspace: () => workspace.current,
}));
vi.mock('../useMergedWorkspaceTree', () => ({
  useMergedWorkspaceTree: () => ({ tree: merged.tree, suggestionOnlyPaths: new Map(), withheld: 0 }),
}));

import { useKnowledgeWriteTarget } from '../useKnowledgeWriteTarget';

const ROOT = 'kb/KnowledgeBase';
const DRAFT = 'alice/draft';
let writable = new Set<string>();
let readable = new Set<string>();

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
const tree = (...children: FileTreeEntry[]) => dir('kb', [dir(ROOT, children)]);

/** Product, Sales (with Team), Support — plus a page, and a dot-folder that is no place for one. */
const FOLDERS = tree(
  file(`${ROOT}/Guide.md`),
  dir(`${ROOT}/.hidden`),
  dir(`${ROOT}/Product`),
  dir(`${ROOT}/Sales`, [dir(`${ROOT}/Sales/Team`), file(`${ROOT}/Sales/a.md`)]),
  dir(`${ROOT}/Support`),
);

function show(over: Partial<typeof workspace.current> = {}, shownTree: FileTreeEntry | null = FOLDERS) {
  workspace.current = { ...workspace.current, ...over };
  merged.tree = shownTree;
}

async function settledTarget(over: Partial<typeof workspace.current> = {}, shownTree?: FileTreeEntry | null) {
  show(over, shownTree);
  const hook = renderHook(() => useKnowledgeWriteTarget(ROOT));
  await waitFor(() => expect(hook.result.current.settled).toBe(true));
  return hook;
}

beforeEach(() => {
  writable = new Set();
  readable = new Set();
  workspace.current = { workspaceId: 'ws-1', workspaceBranch: 'target-company-state', kbDirName: 'kb', openFilePath: null };
  merged.tree = FOLDERS;
  batch.mockReset().mockImplementation(async (_ws, paths, verb = 'write') => ({
    results: Object.fromEntries(paths.map((p) => [p, (verb === 'read' ? readable : writable).has(p)])),
  }));
});

/** The verb every batch call so far asked — one question per branch kind. */
const verbsAsked = () => new Set(batch.mock.calls.map((c) => c[2] ?? 'write'));

afterEach(() => {
  vi.useRealTimers();
});

describe('useKnowledgeWriteTarget on a protected branch', () => {
  it('takes the top of Knowledge when it may be written, whatever is on screen', async () => {
    writable = new Set(['KnowledgeBase', 'KnowledgeBase/Support']);
    const { result } = await settledTarget({ openFilePath: `${ROOT}/Support/FAQ.md` });
    expect(result.current.folder).toBe(ROOT);
  });

  it('else the folder on screen, asking every folder repo-relative and once, depth first, without dot-folders', async () => {
    writable = new Set(['KnowledgeBase/Sales', 'KnowledgeBase/Support']);
    const { result } = await settledTarget({ openFilePath: `${ROOT}/Support/FAQ.md` });
    expect(result.current.folder).toBe(`${ROOT}/Support`);
    expect(batch).toHaveBeenCalledWith(
      'ws-1',
      ['KnowledgeBase', 'KnowledgeBase/Support', 'KnowledgeBase/Product', 'KnowledgeBase/Sales', 'KnowledgeBase/Sales/Team'],
      'write',
    );
    expect(verbsAsked()).toEqual(new Set(['write']));
  });

  it('else the first folder in tree order', async () => {
    writable = new Set(['KnowledgeBase/Sales', 'KnowledgeBase/Support']);
    const { result } = await settledTarget({ openFilePath: `${ROOT}/Product/Roadmap.md` });
    expect(result.current.folder).toBe(`${ROOT}/Sales`);
  });

  it('settles on nothing when there is nowhere to write', async () => {
    const { result } = await settledTarget();
    expect(result.current.folder).toBeNull();
  });

  it('asks in pages the endpoint accepts, stopping at the first that answers', async () => {
    const many = Array.from({ length: 1010 }, (_, i) => dir(`${ROOT}/F${i}`));
    writable = new Set(['KnowledgeBase/F503', 'KnowledgeBase/F1005']);
    const { result } = await settledTarget({}, tree(...many));
    expect(result.current.folder).toBe(`${ROOT}/F503`);
    expect(batch).toHaveBeenCalledTimes(2);
    for (const call of batch.mock.calls) expect(call[1].length).toBeLessThanOrEqual(500);
  });

  it('settles on nothing when the request fails', async () => {
    batch.mockRejectedValue(new Error('HTTP 500'));
    const { result } = await settledTarget();
    expect(result.current.folder).toBeNull();
  });

  it('asks at once the first time, and debounces a tree change after that', async () => {
    vi.useFakeTimers();
    show();
    const { result, rerender } = renderHook(() => useKnowledgeWriteTarget(ROOT));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.settled).toBe(true);
    expect(result.current.folder).toBeNull();
    expect(batch).toHaveBeenCalledTimes(1);

    // An admin shares Support; the tree changes with it.
    writable = new Set(['KnowledgeBase/Support']);
    show({}, tree(dir(`${ROOT}/Product`), dir(`${ROOT}/Support`)));
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(batch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(batch).toHaveBeenCalledTimes(2);
    expect(result.current.folder).toBe(`${ROOT}/Support`);
  });
});

/**
 * A draft branch: no write grant is needed, only read where the page lands,
 * and the tree shows folders the person may not read when something inside
 * them is shared — so every candidate is asked, in the same order and the
 * same pages, about reading.
 */
describe('useKnowledgeWriteTarget on a draft branch', () => {
  it('takes the top of Knowledge when it may be read, asking no write check', async () => {
    readable = new Set(['KnowledgeBase', 'KnowledgeBase/Support']);
    const { result } = await settledTarget({ workspaceBranch: DRAFT, openFilePath: `${ROOT}/Support/FAQ.md` });
    expect(result.current.folder).toBe(ROOT);
    expect(batch).toHaveBeenCalledWith(
      'ws-1',
      ['KnowledgeBase', 'KnowledgeBase/Support', 'KnowledgeBase/Product', 'KnowledgeBase/Sales', 'KnowledgeBase/Sales/Team'],
      'read',
    );
    expect(verbsAsked()).toEqual(new Set(['read']));
  });

  it('passes over a top shown only for what is inside it, to the folder on screen, else the first in tree order', async () => {
    readable = new Set(['KnowledgeBase/Sales/Team', 'KnowledgeBase/Support']);
    const onScreen = await settledTarget({ workspaceBranch: DRAFT, openFilePath: `${ROOT}/Support/FAQ.md` });
    expect(onScreen.result.current.folder).toBe(`${ROOT}/Support`);
    onScreen.unmount();
    const elsewhere = await settledTarget({ workspaceBranch: DRAFT, openFilePath: `${ROOT}/Product/Roadmap.md` });
    expect(elsewhere.result.current.folder).toBe(`${ROOT}/Sales/Team`);
  });

  it('settles on nothing when nothing may be read', async () => {
    const { result } = await settledTarget({ workspaceBranch: DRAFT });
    expect(result.current.folder).toBeNull();
  });

  it('asks in the pages the endpoint accepts, stopping at the first that answers', async () => {
    const many = Array.from({ length: 1010 }, (_, i) => dir(`${ROOT}/F${i}`));
    readable = new Set(['KnowledgeBase/F503', 'KnowledgeBase/F1005']);
    const { result } = await settledTarget({ workspaceBranch: DRAFT }, tree(...many));
    expect(result.current.folder).toBe(`${ROOT}/F503`);
    // The top and F0…F498, then F499…F998: two pages, never the third.
    expect(batch).toHaveBeenCalledTimes(2);
    for (const call of batch.mock.calls) expect(call[1].length).toBeLessThanOrEqual(500);
    expect(verbsAsked()).toEqual(new Set(['read']));
  });

  it('asks nothing when the tree shows no Knowledge folder', async () => {
    const { result } = await settledTarget({ workspaceBranch: DRAFT }, dir('kb', [dir('kb/Skills')]));
    expect(result.current.folder).toBeNull();
    expect(batch).not.toHaveBeenCalled();
  });

  it('settles on nothing when the request fails', async () => {
    batch.mockRejectedValue(new Error('HTTP 500'));
    const { result } = await settledTarget({ workspaceBranch: DRAFT });
    expect(result.current.folder).toBeNull();
  });
});
