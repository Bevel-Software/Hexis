import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  DestinationTakenError,
  inspectDestination,
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

  it('leaves no folder behind when it refuses a folder move', async () => {
    // The name is claimed with `mkdir` before the rename; a rename that then
    // fails must give that claim back rather than leave an empty folder in
    // everyone's tree.
    await fs.mkdir(at('from'));
    await fs.writeFile(at('from/new.md'), 'new');
    await fs.mkdir(at('onto'));
    await fs.writeFile(at('onto/old.md'), 'old');

    await expect(renameNoReplace(at('from'), at('onto'), 'onto')).rejects.toBeDefined();

    expect((await fs.readdir(dir)).sort()).toEqual(['from', 'onto']);
  });

  it('answers the source ENOENT when there is nothing to move, taken name or not', async () => {
    await fs.writeFile(at('taken.md'), 'taken');

    await expect(renameNoReplace(at('absent.md'), at('taken.md'), 'taken.md')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await read('taken.md')).toBe('taken');
  });

  it.skipIf(process.platform !== 'linux')('performs a case-only rename, and only that, when one inode has two names', async () => {
    // A hard link is, to `lstat`, what a case-insensitive filesystem shows for
    // `notes.md` and `Notes.md`: one inode, two names. Folded-together names
    // are the rename that was asked for; unrelated ones are a clash.
    await fs.writeFile(at('notes.md'), '# Notes\n');
    await fs.link(at('notes.md'), at('Notes.md'));
    await fs.link(at('notes.md'), at('twin.md'));

    expect(await inspectDestination(at('notes.md'), at('Notes.md'))).toEqual({ state: 'self' });
    expect(await inspectDestination(at('notes.md'), at('twin.md'))).toEqual({
      state: 'taken',
      kind: 'file',
    });

    await renameNoReplace(at('notes.md'), at('Notes.md'), 'Notes.md');
    expect(await read('Notes.md')).toBe('# Notes\n');
  });

  it('reads an absent destination as free and a missing source as nothing to refuse', async () => {
    await fs.writeFile(at('note.md'), 'note');

    expect(await inspectDestination(at('note.md'), at('free.md'))).toEqual({ state: 'free' });
    // Nothing at the source: "there is nothing to move" is the truer answer,
    // so the destination is left to the move's own ENOENT.
    expect(await inspectDestination(at('absent.md'), at('note.md'))).toEqual({ state: 'free' });
  });
});
