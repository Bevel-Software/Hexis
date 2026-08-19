import { describe, it, expect, vi } from 'vitest';
import { toKbRelative, resolveReadableMap, type ReadBatchFn } from '../kb-read-filter.js';

const KB = 'staging-repo';

describe('toKbRelative', () => {
  it('strips the kbDir prefix to a repo-relative path', () => {
    expect(toKbRelative('staging-repo/Product/Knowledge/x.md', KB)).toBe('Product/Knowledge/x.md');
  });

  it('tolerates a leading ./ or /', () => {
    expect(toKbRelative('./staging-repo/Product/x.md', KB)).toBe('Product/x.md');
    expect(toKbRelative('/staging-repo/Product/x.md', KB)).toBe('Product/x.md');
  });

  it('tolerates a trailing slash (directory path)', () => {
    expect(toKbRelative('staging-repo/Product/Knowledge/', KB)).toBe('Product/Knowledge');
  });

  it('returns null for a path outside the KB dir (reserved/non-KB → ungated)', () => {
    expect(toKbRelative('some-other-file.txt', KB)).toBeNull();
    expect(toKbRelative('Uploads/x.png', KB)).toBeNull();
  });

  it('returns null for the KB dir itself (no node)', () => {
    expect(toKbRelative('staging-repo', KB)).toBeNull();
    expect(toKbRelative('staging-repo/', KB)).toBeNull();
  });

  it('does not match a sibling dir that merely starts with the kbDir name', () => {
    expect(toKbRelative('staging-repo-backup/x.md', KB)).toBeNull();
  });
});

describe('resolveReadableMap', () => {
  it('always allows non-KB paths and never asks the batch fn about them', async () => {
    const batch = vi.fn<ReadBatchFn>(async () => new Map());
    const out = await resolveReadableMap(batch, 'ws', 'u@x', KB, ['reserved.txt', 'Uploads/a.png']);
    expect(out.get('reserved.txt')).toBe(true);
    expect(out.get('Uploads/a.png')).toBe(true);
    expect(batch).not.toHaveBeenCalled();
  });

  it('maps wsPaths through one batched call and keys the result by wsPath', async () => {
    const batch = vi.fn<ReadBatchFn>(async (_w, _e, rels) => new Map(rels.map((r) => [r, r.startsWith('Product')])));
    const out = await resolveReadableMap(batch, 'ws', 'u@x', KB, [
      'staging-repo/Product/a.md',
      'staging-repo/Platform/b.md',
    ]);
    expect(out.get('staging-repo/Product/a.md')).toBe(true);
    expect(out.get('staging-repo/Platform/b.md')).toBe(false);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![2]).toEqual(['Product/a.md', 'Platform/b.md']);
  });

  it('dedupes repeated KB-relative paths into one batch entry', async () => {
    const batch = vi.fn<ReadBatchFn>(async (_w, _e, rels) => new Map(rels.map((r) => [r, true])));
    await resolveReadableMap(batch, 'ws', 'u@x', KB, [
      'staging-repo/Product/a.md',
      'staging-repo/Product/a.md',
    ]);
    expect(batch.mock.calls[0]![2]).toEqual(['Product/a.md']);
  });

  it('fails closed: a KB path missing from the verdict resolves to not-readable', async () => {
    const batch = vi.fn<ReadBatchFn>(async () => new Map()); // verdict omits the path
    const out = await resolveReadableMap(batch, 'ws', 'u@x', KB, ['staging-repo/Product/a.md']);
    expect(out.get('staging-repo/Product/a.md')).toBe(false);
  });
});
