import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeFs } from '../node-fs.js';
import { BevelIgnoreStack } from '../bevel-ignore.js';
import type { IgnoreRules, TreeWalkOptions, WalkListener } from '../../../shared/fs.contract.js';

const disk = new NodeFs();

/**
 * The one walk: what it skips, in what order it visits, what it calls a hole
 * — and that every listener on it is told exactly the same things.
 */
describe('NodeFs.walkKb', () => {
  let root: string;
  const write = async (rel: string, text = '') => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };
  /** A listener that records every event it is told, in order. */
  const recorder = () => {
    const events: string[] = [];
    const listener: WalkListener = {
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
    const { holes } = await disk.walkKb(root, [listener]);
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
    await disk.walkKb(root, [a.listener, b.listener]);
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
      const { holes } = await disk.walkKb(root, [listener]);
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
    expect(await disk.walkKb(path.join(root, 'nope'), [empty.listener])).toEqual({ holes: [] });
    expect(empty.events).toEqual([]);

    await write('Plugins/gone/plugin.json');
    const real = fs.readdir;
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, opts: unknown) =>
      String(dir).endsWith('gone')
        ? Promise.reject(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }))
        : (real as (d: string, o: unknown) => Promise<unknown>).call(fs, dir, opts)) as never);
    try {
      const { events, listener } = recorder();
      const { holes } = await disk.walkKb(root, [listener]);
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
describe('NodeFs.walk', () => {
  let root: string;
  const write = async (rel: string, text = '') => {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };
  const files = async (opts: TreeWalkOptions, extra: WalkListener = {}) => {
    const out: string[] = [];
    await disk.walk(root, opts, [{ ...extra, onFile: (dir, name) => void out.push(dir ? `${dir}/${name}` : name) }]);
    return out;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'tree-walk-'));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it("skips nothing by default; `skip` is the reader's own list", async () => {
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

  it('`ignore` layers the rules like git: a deeper `!` restores what a shallower file hid', async () => {
    await write('.bevelignore', '*.log\n');
    await write('a.log');
    await write('keep/.bevelignore', '!important.log\n');
    await write('keep/important.log');
    await write('keep/other.log');
    expect(await files({ ignore: true })).toEqual(['.bevelignore', 'keep/.bevelignore', 'keep/important.log']);
  });

  it('a `.bevelignore` that is there but cannot be read makes its folder a hole — never a folder walked without its rules', async () => {
    await write('locked/.bevelignore', 'secret.md\n');
    await write('locked/secret.md');
    await write('open/a.md');
    const real = fs.readFile;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(((file: string, ...rest: unknown[]) =>
      String(file).endsWith(path.join('locked', '.bevelignore'))
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (real as (f: string, ...r: unknown[]) => Promise<unknown>).call(fs, file, ...rest)) as never);
    try {
      const holes: string[] = [];
      expect(await files({ ignore: true }, { onHole: (rel) => void holes.push(rel) })).toEqual(['open/a.md']);
      expect(holes).toEqual(['locked']);
      await expect(disk.walk(root, { ignore: true, unreadable: 'throw' }, [])).rejects.toThrow('EACCES');
      // A walk that does not honour the file never reads it: no hole.
      expect(await files({})).toEqual(['locked/.bevelignore', 'locked/secret.md', 'open/a.md']);
    } finally {
      spy.mockRestore();
    }
  });

  it('`ignore` given a stack starts from the rules in force above the root', async () => {
    await write('.bevelignore', '*.png\n');
    await write('skill/a.md');
    await write('skill/b.png');
    const skill = path.join(root, 'skill');
    const list = async (ignore: boolean | IgnoreRules) => {
      const out: string[] = [];
      await disk.walk(skill, { ignore }, [{ onFile: (d, n) => void out.push(d ? `${d}/${n}` : n) }]);
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
    await disk.walk(root, { until: () => found }, [
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

  it("`unreadable: throw` makes a hole the walk's error instead of a report", async () => {
    await write('locked/a.md');
    const real = fs.readdir;
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, opts: unknown) =>
      String(dir).endsWith('locked')
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (real as (d: string, o: unknown) => Promise<unknown>).call(fs, dir, opts)) as never);
    try {
      await expect(disk.walk(root, { unreadable: 'throw' }, [])).rejects.toThrow('EACCES');
      expect((await disk.walk(root, {}, [])).holes).toEqual(['locked']);
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
    // …and a rule that names it hides it from onOther as it would a file.
    await write('.bevelignore', 'link\n');
    const hidden: string[] = [];
    await files({ ignore: true }, { onOther: (_dir, e) => void hidden.push(e.name) });
    expect(hidden).toEqual([]);
  });
});

describe('NodeFs.walkFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-walk-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns [] for a missing root', async () => {
    expect(await disk.walkFiles(path.join(root, 'nope'), () => true)).toEqual([]);
  });

  it('walks nested directories, filters by basename, and sorts the result', async () => {
    await fs.mkdir(path.join(root, 'b/deep'), { recursive: true });
    await fs.mkdir(path.join(root, 'a'), { recursive: true });
    await fs.writeFile(path.join(root, 'b/deep/z.tool'), '');
    await fs.writeFile(path.join(root, 'a/y.tool'), '');
    await fs.writeFile(path.join(root, 'a/skip.md'), '');
    await fs.writeFile(path.join(root, 'x.tool'), '');

    const found = await disk.walkFiles(root, (n) => n.endsWith('.tool'));
    // Relative `/`-separated paths, sorted, only matching basenames.
    expect(found).toEqual(['a/y.tool', 'b/deep/z.tool', 'x.tool']);
  });

  it('skips dot-prefixed entries — files AND whole directories (.git)', async () => {
    await fs.mkdir(path.join(root, '.git/objects'), { recursive: true });
    await fs.writeFile(path.join(root, '.git/objects/a.tool'), '');
    await fs.writeFile(path.join(root, '.hidden.tool'), '');
    await fs.writeFile(path.join(root, 'visible.tool'), '');

    expect(await disk.walkFiles(root, (n) => n.endsWith('.tool'))).toEqual(['visible.tool']);
  });

  it('skips a directory it cannot list by default, and throws for a strict caller', async () => {
    await fs.mkdir(path.join(root, 'locked'), { recursive: true });
    await fs.writeFile(path.join(root, 'locked/a.tool'), '');
    await fs.writeFile(path.join(root, 'b.tool'), '');
    const real = fs.readdir;
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, opts: unknown) => {
      if (String(dir).endsWith('locked')) {
        return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
      }
      return (real as (d: string, o: unknown) => Promise<unknown>).call(fs, dir, opts);
    }) as never);
    try {
      // A catalog shows what it can…
      expect(await disk.walkFiles(root, (n) => n.endsWith('.tool'))).toEqual(['b.tool']);
      // …a caller that must see everything gets the error, not a list with a hole.
      await expect(disk.walkFiles(root, (n) => n.endsWith('.tool'), { strict: true })).rejects.toThrow('EACCES');
    } finally {
      spy.mockRestore();
    }
  });
});

/** ONE definition of absence, and every probe applies it. */
describe('NodeFs probes', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-probe-'));
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('isAbsence: ENOENT and ENOTDIR are absence; anything else is a failure to read what is there', () => {
    expect(disk.isAbsence({ code: 'ENOENT' })).toBe(true);
    expect(disk.isAbsence({ code: 'ENOTDIR' })).toBe(true);
    expect(disk.isAbsence({ code: 'EACCES' })).toBe(false);
    expect(disk.isAbsence({ code: 'EISDIR' })).toBe(false);
    expect(disk.isAbsence(new Error('plain'))).toBe(false);
    expect(disk.isAbsence(null)).toBe(false);
  });

  it('exists / lstatOrNull see the entry itself; statOrNull follows a link; isDirectory is the entry itself', async () => {
    await fs.mkdir(path.join(root, 'dir'));
    await fs.writeFile(path.join(root, 'file.md'), 'x');
    await fs.symlink(path.join(root, 'file.md'), path.join(root, 'link.md'), 'file');
    await fs.symlink(path.join(root, 'nowhere'), path.join(root, 'dangling'), 'file');

    expect(await disk.exists(path.join(root, 'file.md'))).toBe(true);
    expect(await disk.exists(path.join(root, 'dangling'))).toBe(true); // something IS there: the link
    expect(await disk.exists(path.join(root, 'missing'))).toBe(false);
    expect(await disk.exists(path.join(root, 'file.md', 'below'))).toBe(false); // ENOTDIR is absence too

    expect((await disk.lstatOrNull(path.join(root, 'link.md')))?.isSymbolicLink()).toBe(true);
    expect((await disk.statOrNull(path.join(root, 'link.md')))?.isFile()).toBe(true);
    expect(await disk.statOrNull(path.join(root, 'dangling'))).toBeNull();
    expect(await disk.lstatOrNull(path.join(root, 'missing'))).toBeNull();

    expect(await disk.isDirectory(path.join(root, 'dir'))).toBe(true);
    expect(await disk.isDirectory(path.join(root, 'file.md'))).toBe(false);
    expect(await disk.isDirectory(path.join(root, 'missing'))).toBe(false);
  });

  it('readJsonObject: an object, else null — absent, malformed, or not an object; a read failure is the error', async () => {
    await fs.writeFile(path.join(root, 'obj.json'), '{"a":1}');
    await fs.writeFile(path.join(root, 'arr.json'), '[1]');
    await fs.writeFile(path.join(root, 'bad.json'), '{');
    expect(await disk.readJsonObject(path.join(root, 'obj.json'))).toEqual({ a: 1 });
    expect(await disk.readJsonObject(path.join(root, 'arr.json'))).toBeNull();
    expect(await disk.readJsonObject(path.join(root, 'bad.json'))).toBeNull();
    expect(await disk.readJsonObject(path.join(root, 'missing.json'))).toBeNull();
    await fs.mkdir(path.join(root, 'folder.json'));
    await expect(disk.readJsonObject(path.join(root, 'folder.json'))).rejects.toThrow(/EISDIR/);
  });
});
