import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  DestinationTakenError,
  type DestinationProbe,
  claimThenRename,
  inspectDestination,
  lstatOrNull,
  landFolder,
  renameNoReplace,
} from '../rename-no-replace.js';

/**
 * The move that cannot overwrite even when the look before it said the name
 * was free.
 *
 * Every caller looks at the destination first, because that look is what
 * produces the sentence a user reads. These tests deliberately SKIP the look
 * and call the move straight onto a taken name — which is what a lost race
 * amounts to — so what they prove is the guarantee underneath it: nothing at
 * the destination is ever replaced, and the refusal is the same one either
 * way.
 */

describe('renameNoReplace', () => {
  let dir: string;
  const at = (rel: string) => path.join(dir, rel);
  const read = (rel: string) => fs.readFile(at(rel), 'utf-8');

  /**
   * Whether the disk under the temp folder folds case — asked of the disk
   * rather than assumed from `process.platform`, because either answer is
   * possible on any of them (a case-sensitive APFS volume, a case-insensitive
   * mount on Linux).
   */
  async function foldsCase(): Promise<boolean> {
    const probe = path.join(dir, '.case-probe');
    await fs.writeFile(probe, '');
    try {
      return (await lstatOrNull(path.join(dir, '.CASE-PROBE'))) !== null;
    } finally {
      await fs.rm(probe, { force: true });
    }
  }

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-no-replace-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('refuses a file onto a file and leaves both where they were', async () => {
    await fs.writeFile(at('source.docx'), 'docx bytes');
    await fs.writeFile(at('taken.md'), '# Notes\n');

    await expect(renameNoReplace(at('source.docx'), at('taken.md'), 'Sales/taken.md')).rejects.toMatchObject({
      name: 'DestinationTakenError',
      status: 409,
      message: 'A file named taken.md already exists in Sales.',
    });

    expect(await read('taken.md')).toBe('# Notes\n');
    expect(await read('source.docx')).toBe('docx bytes');
  });

  it('refuses a file onto a folder, and a folder onto a file, naming what is in the way', async () => {
    await fs.writeFile(at('note.md'), 'note');
    await fs.mkdir(at('Q4'));
    await fs.writeFile(at('Q4/deal.md'), 'deal');

    await expect(renameNoReplace(at('note.md'), at('Q4'), 'Sales/Q4')).rejects.toMatchObject({
      message: 'A folder named Q4 already exists in Sales.',
    });
    await expect(renameNoReplace(at('Q4'), at('note.md'), 'Sales/note.md')).rejects.toMatchObject({
      message: 'A file named note.md already exists in Sales.',
    });

    expect(await read('Q4/deal.md')).toBe('deal');
    expect(await read('note.md')).toBe('note');
  });

  it('refuses a folder onto a folder rather than merging the two', async () => {
    await fs.mkdir(at('from'));
    await fs.writeFile(at('from/new.md'), 'new');
    await fs.mkdir(at('onto'));
    await fs.writeFile(at('onto/old.md'), 'old');

    await expect(renameNoReplace(at('from'), at('onto'), 'Archive/onto')).rejects.toBeInstanceOf(
      DestinationTakenError,
    );

    expect(await fs.readdir(at('onto'))).toEqual(['old.md']);
    expect(await fs.readdir(at('from'))).toEqual(['new.md']);
  });

  it('refuses a folder onto an EMPTY folder — the one case a plain rename would swallow', async () => {
    // `fs.rename` replaces an empty directory on POSIX without a word. The
    // name is somebody's, empty or not.
    await fs.mkdir(at('from'));
    await fs.writeFile(at('from/new.md'), 'new');
    await fs.mkdir(at('empty'));

    await expect(renameNoReplace(at('from'), at('empty'), 'Archive/empty')).rejects.toMatchObject({
      message: 'A folder named empty already exists in Archive.',
    });

    expect(await fs.readdir(at('empty'))).toEqual([]);
    expect(await fs.readdir(at('from'))).toEqual(['new.md']);
  });

  it('moves a file and a folder onto a free name, and leaves the source gone', async () => {
    await fs.writeFile(at('note.md'), 'note');
    await fs.mkdir(at('folder'));
    await fs.writeFile(at('folder/inside.md'), 'inside');

    await renameNoReplace(at('note.md'), at('renamed.md'), 'Sales/renamed.md');
    await renameNoReplace(at('folder'), at('moved'), 'Sales/moved');

    expect(await read('renamed.md')).toBe('note');
    expect(await read('moved/inside.md')).toBe('inside');
    await expect(fs.access(at('note.md'))).rejects.toBeDefined();
    await expect(fs.access(at('folder'))).rejects.toBeDefined();
  });

  it('adds nothing to the tree for a folder move it refuses', async () => {
    await fs.mkdir(at('from'));
    await fs.writeFile(at('from/new.md'), 'new');
    await fs.mkdir(at('onto'));
    await fs.writeFile(at('onto/old.md'), 'old');

    await expect(renameNoReplace(at('from'), at('onto'), 'onto')).rejects.toBeDefined();

    expect((await fs.readdir(dir)).sort()).toEqual(['from', 'onto']);
  });

  /**
   * `landFolder` is the half of a folder move that runs AFTER the look: it
   * claims the name with `mkdir` and then renames onto its own claim. Called
   * directly, it stands in for a race — the destination taken, or taken from
   * under the claim, in the moment the look cannot cover.
   */
  describe('landFolder — the claim, and what happens when it cannot be kept', () => {
    it.skipIf(process.platform === 'win32')('gives the claim back when the rename fails, leaving no folder behind', async () => {
      // `mkdir` succeeds (the name is free) and the rename then fails, here
      // because there is no source. The empty folder the claim made must not
      // survive that.
      await expect(landFolder(at('absent'), at('claimed'), 'claimed')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      expect(await fs.readdir(dir)).toEqual([]);
    });

    it('refuses when the claim cannot be made, and touches what is there', async () => {
      await fs.mkdir(at('from'));
      await fs.writeFile(at('from/new.md'), 'new');
      await fs.mkdir(at('onto'));
      await fs.writeFile(at('onto/old.md'), 'old');

      await expect(landFolder(at('from'), at('onto'), 'Archive/onto')).rejects.toMatchObject({
        name: 'DestinationTakenError',
        message: 'A folder named onto already exists in Archive.',
      });

      expect(await fs.readdir(at('onto'))).toEqual(['old.md']);
      expect(await fs.readdir(at('from'))).toEqual(['new.md']);
    });
  });

  /**
   * The file fallback, for filesystems with no hard links. It only runs when
   * `link` fails, which no test can provoke on the disks CI uses, so it is
   * driven directly — otherwise the one path that could silently reintroduce
   * an overwrite would never be exercised.
   */
  describe('claimThenRename — the fallback where hard links do not exist', () => {
    it('moves onto a free name', async () => {
      await fs.writeFile(at('note.md'), 'note');

      await claimThenRename(at('note.md'), at('moved.md'), 'moved.md');

      expect(await read('moved.md')).toBe('note');
      await expect(fs.access(at('note.md'))).rejects.toBeDefined();
    });

    it('refuses a taken name instead of replacing it', async () => {
      await fs.writeFile(at('note.md'), 'note');
      await fs.writeFile(at('taken.md'), 'taken');

      await expect(claimThenRename(at('note.md'), at('taken.md'), 'Sales/taken.md')).rejects.toMatchObject({
        name: 'DestinationTakenError',
        message: 'A file named taken.md already exists in Sales.',
      });

      expect(await read('taken.md')).toBe('taken');
      expect(await read('note.md')).toBe('note');
    });

    it('removes its own claim when the rename fails', async () => {
      await expect(claimThenRename(at('absent.md'), at('claimed.md'), 'claimed.md')).rejects.toMatchObject({
        code: 'ENOENT',
      });

      expect(await fs.readdir(dir)).toEqual([]);
    });
  });

  it('answers the source ENOENT when there is nothing to move, taken name or not', async () => {
    await fs.writeFile(at('taken.md'), 'taken');

    await expect(renameNoReplace(at('absent.md'), at('taken.md'), 'taken.md')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await read('taken.md')).toBe('taken');
  });

  /**
   * One inode under two names is NOT enough to call the destination "the
   * source itself" — two hard links are that, and each is a name a user sees
   * in the tree. What tells the two apart is the directory: a filesystem that
   * folds `notes.md` and `Notes.md` lists ONE entry for them, and one that
   * does not lists two. Both halves are asserted, on whichever disk is
   * underneath.
   */
  it('refuses a move onto a hard link of the source — one inode, but two entries', async () => {
    await fs.writeFile(at('notes.md'), '# Notes\n');
    await fs.link(at('notes.md'), at('twin.md'));

    expect(await inspectDestination(at('notes.md'), at('twin.md'))).toEqual({
      state: 'taken',
      kind: 'file',
    });
    await expect(renameNoReplace(at('notes.md'), at('twin.md'), 'Sales/twin.md')).rejects.toMatchObject({
      message: 'A file named twin.md already exists in Sales.',
    });

    expect(await read('twin.md')).toBe('# Notes\n');
    expect(await read('notes.md')).toBe('# Notes\n');
  });

  it('performs a case-only rename where the filesystem folds the two spellings', async () => {
    await fs.writeFile(at('notes.md'), '# Notes\n');
    if (!(await foldsCase())) {
      // A case-sensitive disk: `Notes.md` is simply a free name, and the
      // rename is the ordinary one. The folded case is the OTHER assertion
      // this pair makes, and it is the one that runs on macOS and Windows.
      expect(await inspectDestination(at('notes.md'), at('Notes.md'))).toEqual({ state: 'free' });
    } else {
      // Folded: `Notes.md` already opens the source's own file, and that must
      // read as the rename it is rather than as a clash with something else.
      expect(await inspectDestination(at('notes.md'), at('Notes.md'))).toEqual({ state: 'self' });
    }

    await renameNoReplace(at('notes.md'), at('Notes.md'), 'Notes.md');
    expect(await read('Notes.md')).toBe('# Notes\n');
  });

  it('reads a re-cased PARENT as the same folder, not as a move between two', async () => {
    // The volume that folds `notes.md` into `Notes.md` folds `Sales` into
    // `sales` too, so `Sales/notes.md` → `sales/Notes.md` is one folder and
    // one entry — the rename it looks like. Comparing the parent strings would
    // call it a move between folders and refuse it.
    await fs.mkdir(at('Sales'));
    await fs.writeFile(at('Sales/notes.md'), '# Notes\n');
    const folded = await foldsCase();

    expect(await inspectDestination(at('Sales/notes.md'), at('sales/Notes.md'))).toEqual(
      // Folded: the destination opens the source's own file, through a parent
      // that is the same folder. Otherwise `sales/` is simply not there.
      { state: folded ? 'self' : 'free' },
    );

    // The parent's case alone, with the file's name untouched: one folder and
    // one name, so there are no two spellings for the folder listing to count
    // — and counting them anyway would find the single name twice and call
    // the entry a clash with itself.
    expect(await inspectDestination(at('Sales/notes.md'), at('sales/notes.md'))).toEqual(
      { state: folded ? 'self' : 'free' },
    );
    if (folded) {
      await renameNoReplace(at('Sales/notes.md'), at('sales/notes.md'), 'sales/notes.md');
      expect(await read('sales/notes.md')).toBe('# Notes\n');
    }

    // And a genuine move between two DIFFERENT folders of one file is still a
    // clash, whatever the two names look like.
    await fs.mkdir(at('Archive'));
    await fs.link(at('Sales/notes.md'), at('Archive/notes.md'));
    expect(await inspectDestination(at('Sales/notes.md'), at('Archive/notes.md'))).toEqual({
      state: 'taken',
      kind: 'file',
    });
  });

  it('treats a move onto itself as the no-op it is', async () => {
    await fs.writeFile(at('note.md'), 'note');

    expect(await inspectDestination(at('note.md'), at('note.md'))).toEqual({ state: 'self' });
    await renameNoReplace(at('note.md'), at('note.md'), 'note.md');

    expect(await read('note.md')).toBe('note');
  });

  it('reads an absent destination as free and a missing source as nothing to refuse', async () => {
    await fs.writeFile(at('note.md'), 'note');

    expect(await inspectDestination(at('note.md'), at('free.md'))).toEqual({ state: 'free' });
    // Nothing at the source: "there is nothing to move" is the truer answer,
    // so the destination is left to the move's own ENOENT.
    expect(await inspectDestination(at('absent.md'), at('note.md'))).toEqual({ state: 'free' });
  });
});

/**
 * The reading a CASE-INSENSITIVE volume produces, run on a disk that is not
 * one.
 *
 * Everything the acceptance criterion "a case-only rename is not a clash with
 * the entry itself" is about lives on the `self` side of `inspectDestination`,
 * and `self` needs a volume where `notes.md` and `Notes.md` are one entry.
 * Linux has none; the container cannot make one (`mount` is not permitted,
 * `mkfs.vfat` is absent). The real-disk tests above therefore gate every one
 * of those assertions behind a `foldsCase()` that is false here and in CI, so
 * the branches went unexecuted while four review rounds reshaped them.
 *
 * `volume()` below stands in for the disk: a folder holds ONE entry per folded
 * name (which is the whole of what case-insensitivity is), lookups fold, and
 * listings report the spelling actually stored. The same helper with
 * `folds: false` reproduces this machine's own answers — the pair is what
 * makes it a stand-in rather than a fixture that only ever says `self`.
 *
 * Only the READING is faked. The move itself is driven against the real
 * filesystem above, where its no-clobber calls are the thing being tested.
 */
describe('inspectDestination — the case-insensitive reading, on a disk that does not fold', () => {
  interface Entry {
    /** Which file this is. Two paths sharing an inode are one file. */
    ino: number;
    dir?: boolean;
  }

  /**
   * A probe over a declared tree. `folds` picks the volume being modelled:
   * folding (macOS's default APFS, Windows) or not (this disk). Paths are
   * absolute and `/`-separated, as `inspectDestination` receives them.
   */
  function volume(
    tree: Record<string, Entry>,
    opts: { folds?: boolean; unreadable?: string[] } = {},
  ): DestinationProbe {
    const folds = opts.folds ?? true;
    const key = (p: string) => (folds ? p.toLowerCase() : p);
    // Folded keys collapse two spellings into one entry — a case-insensitive
    // folder cannot hold both, and this map cannot represent both either.
    const entries = new Map(
      Object.entries(tree).map(([storedPath, entry]) => [key(storedPath), { storedPath, ...entry }]),
    );
    const absent = (call: string, p: string) =>
      Object.assign(new Error(`ENOENT: ${call} '${p}'`), { code: 'ENOENT' });
    return {
      async lstat(p) {
        const found = entries.get(key(p));
        if (found === undefined) return null;
        return { dev: 1, ino: found.ino, isDirectory: () => found.dir === true };
      },
      async readdir(folder) {
        if (opts.unreadable?.some((u) => key(u) === key(folder))) {
          throw Object.assign(new Error(`EACCES: readdir '${folder}'`), { code: 'EACCES' });
        }
        if (entries.get(key(folder))?.dir !== true) throw absent('readdir', folder);
        const prefix = `${key(folder)}/`;
        return [...entries.values()]
          .filter((e) => key(e.storedPath).startsWith(prefix))
          .filter((e) => !key(e.storedPath).slice(prefix.length).includes('/'))
          .map((e) => e.storedPath.slice(e.storedPath.lastIndexOf('/') + 1));
      },
    };
  }

  /** One file in one folder — the shape every case below starts from. */
  const SALES = { '/ws': { ino: 1, dir: true }, '/ws/Sales': { ino: 5, dir: true } };
  const ONE_NOTE = { ...SALES, '/ws/Sales/notes.md': { ino: 10 } };

  it('reads a re-cased FILE name as the source itself: one folded name, one listed entry', async () => {
    const folding = volume(ONE_NOTE);

    // The destination opens the source's own file, and the folder lists a
    // single entry for the two spellings: the rename that was asked for.
    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/Sales/Notes.md', folding))
      .toEqual({ state: 'self' });

    // The same tree on THIS disk: `Notes.md` is simply a free name.
    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/Sales/Notes.md', volume(ONE_NOTE, { folds: false })))
      .toEqual({ state: 'free' });
  });

  it('reads a re-cased PARENT with the same filename as one folder and one name', async () => {
    // Nothing for the listing to count: asking it whether two identical
    // basenames are both present answers yes, and would read the single entry
    // as a clash with itself. The parents are one folder by identity.
    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/sales/notes.md', volume(ONE_NOTE)))
      .toEqual({ state: 'self' });
  });

  it('reads a re-cased parent AND a re-cased filename as the one rename it is', async () => {
    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/sales/Notes.md', volume(ONE_NOTE)))
      .toEqual({ state: 'self' });
  });

  it('reads a re-cased FOLDER as the folder itself', async () => {
    expect(await inspectDestination('/ws/Sales', '/ws/sales', volume(ONE_NOTE)))
      .toEqual({ state: 'self' });
  });

  it('still refuses a second NAME for one file, folding volume or not', async () => {
    // Two hard links: one inode, two names a user sees separately, and the
    // folder lists both. Moving onto one takes that name away, so it is a
    // clash — identity alone must not be read as a case-only rename.
    const twins = volume({ ...ONE_NOTE, '/ws/Sales/twin.md': { ino: 10 } });

    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/Sales/twin.md', twins))
      .toEqual({ state: 'taken', kind: 'file' });
  });

  it('still refuses one file reached through two DIFFERENT folders', async () => {
    const linked = volume({
      ...ONE_NOTE,
      '/ws/Archive': { ino: 6, dir: true },
      '/ws/Archive/notes.md': { ino: 10 },
    });

    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/Archive/notes.md', linked))
      .toEqual({ state: 'taken', kind: 'file' });
  });

  it('refuses when the folder cannot be listed: nothing unprovable is called a case-only rename', async () => {
    const unlistable = volume(ONE_NOTE, { unreadable: ['/ws/Sales'] });

    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/Sales/Notes.md', unlistable))
      .toEqual({ state: 'taken', kind: 'file' });
  });

  it('names a FOLDER in the way as a folder, on a folding volume too', async () => {
    const withArchive = volume({ ...ONE_NOTE, '/ws/Sales/Archive': { ino: 7, dir: true } });

    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/Sales/archive', withArchive))
      .toEqual({ state: 'taken', kind: 'folder' });
  });

  it('agrees with the real disk on every answer that does not need folding', async () => {
    // The stand-in is only worth trusting if it reproduces what this machine
    // says where the two can both be asked.
    const plain = volume(ONE_NOTE, { folds: false });

    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/Sales/free.md', plain))
      .toEqual({ state: 'free' });
    expect(await inspectDestination('/ws/Sales/absent.md', '/ws/Sales/notes.md', plain))
      .toEqual({ state: 'free' });
    expect(await inspectDestination('/ws/Sales/notes.md', '/ws/Sales/notes.md', plain))
      .toEqual({ state: 'self' });
  });
});
