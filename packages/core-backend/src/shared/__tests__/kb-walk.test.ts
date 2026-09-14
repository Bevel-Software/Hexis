import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { walkKb, walkTree, type KbWalkListener, type TreeWalkOptions } from '../kb-walk.js';
import { BevelIgnoreStack } from '../bevel-ignore.js';

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

/**
 * The same loop under other rules: what a reader that is not the catalog
 * says in its options — and nothing it has to re-implement.
 */
describe('walkTree', () => {
  let root: string;
  const write = async (rel: string, text = '') => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };
  const files = async (opts: TreeWalkOptions, extra: KbWalkListener = {}) => {
    const out: string[] = [];
    await walkTree(root, opts, [{ ...extra, onFile: (dir, name) => void out.push(dir ? `${dir}/${name}` : name) }]);
    return out;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tree-walk-'));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('skips nothing by default; `skip` is the reader\'s own list', async () => {
    await write('.git/HEAD');
    await write('.bevelignore');
    await write('a/.hidden.md');
    await write('a/b.md');
    expect(await files({})).toEqual(['.bevelignore', '.git/HEAD', 'a/.hidden.md', 'a/b.md']);
    expect(await files({ skip: (e) => e.name === '.git' })).toEqual(['.bevelignore', 'a/.hidden.md', 'a/b.md']);
  });

  it('`ignore` honours the .bevelignore files on the way down, layered like git; a listener still sees what was there', async () => {
    await write('.bevelignore', 'drop/\n');
    await write('drop/y.md');
    await write('keep/.bevelignore', 'secret.md\n');
    await write('keep/secret.md');
    await write('keep/x.md');
    await write('keep/drop/z.md'); // the root rule is unanchored: it names this one too
    expect(await files({})).toEqual(['.bevelignore', 'drop/y.md', 'keep/.bevelignore', 'keep/drop/z.md', 'keep/secret.md', 'keep/x.md']);
    const listed: string[] = [];
    const found = await files(
      { ignore: true },
      { onDir: (rel, entries, dir) => void listed.push(`${rel || '.'}: ${dir.listed.length} listed, ${entries.length} kept`) },
    );
    expect(found).toEqual(['.bevelignore', 'keep/.bevelignore', 'keep/x.md']);
    expect(listed).toEqual(['.: 3 listed, 2 kept', 'keep: 4 listed, 2 kept']);
  });

  it('`ignore` given a stack starts from the rules in force above the root', async () => {
    await write('.bevelignore', '*.png\n');
    await write('skill/a.md');
    await write('skill/b.png');
    const skill = path.join(root, 'skill');
    const list = async (ignore: boolean | BevelIgnoreStack) => {
      const out: string[] = [];
      await walkTree(skill, { ignore }, [{ onFile: (d, n) => void out.push(d ? `${d}/${n}` : n) }]);
      return out;
    };
    // A walk rooted at `skill/` cannot see the rule above it…
    expect(await list(true)).toEqual(['a.md', 'b.png']);
    // …unless handed the rules in force there.
    expect(await list(await BevelIgnoreStack.empty().extendedWith(root))).toEqual(['a.md']);
  });

  it('a `leaf` is reported, then left alone', async () => {
    await write('Skills/deploy/SKILL.md');
    await write('Skills/deploy/assets/a.md');
    await write('Skills/group/inner/SKILL.md');
    const dirs: string[] = [];
    const found = await files(
      { leaf: (_dir, entries) => entries.some((e) => e.name === 'SKILL.md') },
      { onDir: (rel) => void dirs.push(rel || '.') },
    );
    expect(dirs).toEqual(['.', 'Skills', 'Skills/deploy', 'Skills/group', 'Skills/group/inner']);
    expect(found).toEqual([]); // nothing beneath a leaf is a file event, its own files included
  });

  it('`until` ends the walk at the first find', async () => {
    await write('a/plugin.json');
    await write('a/deep/x.md');
    await write('b/y.md');
    let found = false;
    const dirs: string[] = [];
    await walkTree(root, { until: () => found }, [
      {
        onDir(rel, entries) {
          dirs.push(rel || '.');
          if (entries.some((e) => e.name === 'plugin.json')) found = true;
        },
      },
    ]);
    expect(found).toBe(true);
    expect(dirs).toEqual(['.', 'a']); // neither `a/deep` nor `b` was listed
  });

  it('`unreadable: throw` makes a hole the walk\'s error instead of a report', async () => {
    await write('locked/a.md');
    const real = fs.readdir;
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, opts: unknown) =>
      String(dir).endsWith('locked')
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (real as (d: string, o: unknown) => Promise<unknown>).call(fs, dir, opts)) as never);
    try {
      await expect(walkTree(root, { unreadable: 'throw' }, [])).rejects.toThrow('EACCES');
      expect((await walkTree(root, {}, [])).holes).toEqual(['locked']);
    } finally {
      spy.mockRestore();
    }
  });

  it('an entry that is neither file nor folder is never entered, never a file — it is told to onOther', async () => {
    await write('real/a.md');
    await fs.symlink(path.join(root, 'real'), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const others: string[] = [];
    const found = await files({}, { onOther: (dir, e) => void others.push(`${dir ? `${dir}/` : ''}${e.name}:${e.isSymbolicLink()}`) });
    expect(found).toEqual(['real/a.md']);
    expect(others).toEqual(['link:true']);
  });
});
