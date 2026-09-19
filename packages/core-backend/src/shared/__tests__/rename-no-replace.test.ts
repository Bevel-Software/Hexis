import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  DestinationTakenError,
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
