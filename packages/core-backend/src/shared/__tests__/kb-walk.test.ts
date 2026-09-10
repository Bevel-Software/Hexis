import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { walkKb, type KbWalkListener } from '../kb-walk.js';

/**
 * The one walk: what it skips, in what order it visits, what it calls a hole
 * — and that every listener on it is told exactly the same things.
 */
describe('walkKb', () => {
  let root: string;
  const write = async (rel: string, text = '') => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };
  /** A listener that records every event it is told, in order. */
  const recorder = () => {
    const events: string[] = [];
    const listener: KbWalkListener = {
      onDir: (rel, entries) => void events.push(`dir ${rel || '.'} [${entries.map((e) => e.name).join(' ')}]`),
      onFile: (dir, name) => void events.push(`file ${dir ? `${dir}/${name}` : name}`),
      onHole: (rel) => void events.push(`hole ${rel || '.'}`),
    };
    return { events, listener };
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kb-walk-'));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('visits every folder once, in component order, skipping dot-entries and node_modules', async () => {
    await write('Plugins/a-b/plugin.json');
    await write('Plugins/a/b/plugin.json');
    await write('KnowledgeBase/x.md');
    await write('.git/HEAD');
    await write('node_modules/dep/index.js');
    await write('Plugins/.parked/plugin.json');
    const { events, listener } = recorder();
    const { holes } = await walkKb(root, [listener]);
    expect(holes).toEqual([]);
    expect(events).toEqual([
      'dir . [KnowledgeBase Plugins]',
      'dir KnowledgeBase [x.md]',
      'file KnowledgeBase/x.md',
      'dir Plugins [a a-b]', // "a" before "a-b": the walk order every consumer agrees on
      'dir Plugins/a [b]',
      'dir Plugins/a/b [plugin.json]',
      'file Plugins/a/b/plugin.json',
      'dir Plugins/a-b [plugin.json]',
      'file Plugins/a-b/plugin.json',
    ]);
  });

  it('tells every listener the same things', async () => {
    await write('Plugins/GTM/plugin.json');
    await write('Skills/Eng/deploy/SKILL.md');
    const a = recorder();
    const b = recorder();
    await walkKb(root, [a.listener, b.listener]);
    expect(a.events.length).toBeGreaterThan(0);
    expect(b.events).toEqual(a.events);
  });

  it('a folder that exists but cannot be listed is a hole — reported to every listener and in the result', async () => {
    await write('Plugins/locked/plugin.json');
    await write('Plugins/open/plugin.json');
    const real = fs.readdir;
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, opts: unknown) =>
      String(dir).endsWith('locked')
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (real as (d: string, o: unknown) => Promise<unknown>).call(fs, dir, opts)) as never);
    try {
      const { events, listener } = recorder();
      const { holes } = await walkKb(root, [listener]);
      expect(holes).toEqual(['Plugins/locked']);
      expect(events).toContain('hole Plugins/locked');
      // The rest of the tree is still walked.
      expect(events).toContain('file Plugins/open/plugin.json');
    } finally {
      spy.mockRestore();
    }
  });

  it('a missing root is an empty walk; a folder that vanished between listing and visiting is not a hole', async () => {
    const empty = recorder();
    expect(await walkKb(path.join(root, 'nope'), [empty.listener])).toEqual({ holes: [] });
    expect(empty.events).toEqual([]);

    await write('Plugins/gone/plugin.json');
    const real = fs.readdir;
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, opts: unknown) =>
      String(dir).endsWith('gone')
        ? Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
        : (real as (d: string, o: unknown) => Promise<unknown>).call(fs, dir, opts)) as never);
    try {
      const { events, listener } = recorder();
      const { holes } = await walkKb(root, [listener]);
      expect(holes).toEqual([]);
      expect(events.some((e) => e.startsWith('hole'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
