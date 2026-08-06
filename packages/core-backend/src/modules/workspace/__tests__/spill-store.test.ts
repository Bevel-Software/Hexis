import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpillStore } from '../spill-store.js';

describe('SpillStore', () => {
  let root: string;
  let store: SpillStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'spill-test-'));
    store = new SpillStore(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips content under a recognisable spill ref', async () => {
    const { ref, bytes } = await store.write('hello world');
    expect(store.isSpillRef(ref)).toBe(true);
    expect(ref.startsWith('__tool_chain_spill__/')).toBe(true);
    expect(bytes).toBe('hello world'.length);
    expect(await store.read(ref)).toBe('hello world');
  });

  it('slices by offset/limit (byte range, read off disk)', async () => {
    const { ref } = await store.write('0123456789');
    expect(await store.read(ref, 3)).toBe('3456789');
    expect(await store.read(ref, 2, 4)).toBe('2345');
    expect(await store.read(ref, 0, 0)).toBe('');
  });

  it('does not treat a normal workspace path as a spill ref', () => {
    expect(store.isSpillRef('docs/readme.md')).toBe(false);
    expect(store.isSpillRef('knowledge-base/AGENTS.md')).toBe(false);
  });

  it('rejects a ref whose id tries to escape the store', async () => {
    await expect(store.read('__tool_chain_spill__/../secret')).rejects.toThrow(/invalid spill ref/i);
    await expect(store.read('__tool_chain_spill__/a/b.json')).rejects.toThrow(/invalid spill ref/i);
  });
});
