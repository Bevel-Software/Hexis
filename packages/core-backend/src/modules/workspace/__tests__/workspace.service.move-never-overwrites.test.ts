import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { WorkspaceService } from '../workspace.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

/**
 * A rename never overwrites.
 *
 * `fs.rename` REPLACES an existing file on every platform, and `moveEntry`
 * used to call it unconditionally: a tester renamed a `.docx` onto the name of
 * an existing `.md` and the markdown file silently became Word bytes, breaking
 * the page. The destination is checked first now, on the one path every
 * surface goes through — the sidebar rename box, a drag onto a folder, the
 * agent's move — so the refusal is the same sentence wherever it is met.
 */

const KB = 'knowledge-base';
const BRANCH = 'main';

describe('WorkspaceService.moveEntry — a name that is taken is refused, never overwritten', () => {
  let root: string;
  let workspaceDir: string;
  let workspaceId: string;
  let svc: WorkspaceService;

  const abs = (rel: string) => path.join(workspaceDir, rel);

  /** Whether `rel` is there, as spelled, without following a link. */
  const entryVisible = async (rel: string) =>
    await fs.lstat(abs(rel)).then(() => true, () => false);

  /**
   * Whether the disk under the workspace folds case — asked of the disk, not
   * guessed from `process.platform`: a case-sensitive APFS volume and a
   * case-insensitive mount on Linux are both ordinary things to run on.
   */
  const foldsCase = async () => {
    const probe = abs(`${KB}/.case-probe`);
    await fs.writeFile(probe, '');
    try {
      return await entryVisible(`${KB}/.CASE-PROBE`);
    } finally {
      await fs.rm(probe, { force: true });
    }
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-move-'));
    workspaceId = workspaceIdForBranch(BRANCH);
    workspaceDir = path.join(root, workspaceId);
    // The inner `.git` is what lets `resolveWorkspaceDir` accept the workspace
    // without trying to clone.
    await fs.mkdir(path.join(workspaceDir, KB, '.git'), { recursive: true });
    svc = new WorkspaceService(
      root,
      'https://github.com/Bevel-Software/knowledge-base.git',
      testKbContext({ kbDirName: KB }),
      new NodeFs(),
    );
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses a file onto a file, and the file already there keeps its content', async () => {
    // The reported bug, exactly: a Word document renamed onto a note.
    await svc.writeFile(workspaceId, `${KB}/Sales/Notes.md`, '# Notes\n');
    await fs.writeFile(abs(`${KB}/Sales/Report.docx`), Buffer.from('PK\u0003\u0004docx'));

    await expect(
      svc.moveEntry(workspaceId, `${KB}/Sales/Report.docx`, `${KB}/Sales/Notes.md`),
    ).rejects.toMatchObject({
      name: 'EntryExistsError',
      status: 409,
      message: 'A file named Notes.md already exists in Sales.',
    });

    expect(await fs.readFile(abs(`${KB}/Sales/Notes.md`), 'utf-8')).toBe('# Notes\n');
    expect(await fs.readFile(abs(`${KB}/Sales/Report.docx`), 'utf-8')).toContain('docx');
  });

  it('refuses a file onto a FOLDER of that name, and says folder', async () => {
    await svc.writeFile(workspaceId, `${KB}/Sales/Q4/deal.md`, 'deal');
    await svc.writeFile(workspaceId, `${KB}/Sales/note.md`, 'note');

    await expect(
      svc.moveEntry(workspaceId, `${KB}/Sales/note.md`, `${KB}/Sales/Q4`),
    ).rejects.toMatchObject({
      name: 'EntryExistsError',
      status: 409,
      message: 'A folder named Q4 already exists in Sales.',
    });

    expect(await fs.readFile(abs(`${KB}/Sales/Q4/deal.md`), 'utf-8')).toBe('deal');
    expect(await fs.readFile(abs(`${KB}/Sales/note.md`), 'utf-8')).toBe('note');
  });

  it('refuses a folder onto a file of that name, and says file', async () => {
    await svc.writeFile(workspaceId, `${KB}/Sales/Q4/deal.md`, 'deal');
    await svc.writeFile(workspaceId, `${KB}/Archive/Q4`, 'a file called Q4');

    await expect(
      svc.moveEntry(workspaceId, `${KB}/Sales/Q4`, `${KB}/Archive/Q4`),
    ).rejects.toMatchObject({
      name: 'EntryExistsError',
      status: 409,
      message: 'A file named Q4 already exists in Archive.',
    });

    expect(await fs.readFile(abs(`${KB}/Archive/Q4`), 'utf-8')).toBe('a file called Q4');
    expect(await fs.readFile(abs(`${KB}/Sales/Q4/deal.md`), 'utf-8')).toBe('deal');
  });

  it('refuses a folder onto a folder — a move never merges two folders', async () => {
    await svc.writeFile(workspaceId, `${KB}/Sales/Q4/deal.md`, 'deal');
    await svc.writeFile(workspaceId, `${KB}/Archive/Q4/old.md`, 'old');

    await expect(
      svc.moveEntry(workspaceId, `${KB}/Sales/Q4`, `${KB}/Archive/Q4`),
    ).rejects.toMatchObject({ message: 'A folder named Q4 already exists in Archive.' });

    expect(await fs.readFile(abs(`${KB}/Archive/Q4/old.md`), 'utf-8')).toBe('old');
    expect(await fs.readFile(abs(`${KB}/Sales/Q4/deal.md`), 'utf-8')).toBe('deal');
  });

  it('leaves no folder behind for a move it refuses', async () => {
    // The check runs BEFORE the destination's parents are made, so a refusal
    // does not leave an empty `New/` in everyone's tree.
    await svc.writeFile(workspaceId, `${KB}/Sales/note.md`, 'note');
    await svc.writeFile(workspaceId, `${KB}/Sales/New/taken.md`, 'taken');

    await expect(
      svc.moveEntry(workspaceId, `${KB}/Sales/note.md`, `${KB}/Sales/New/taken.md`),
    ).rejects.toMatchObject({ status: 409 });

    expect(await fs.readdir(abs(`${KB}/Sales/New`))).toEqual(['taken.md']);
  });

  it('allows a case-only rename, on a disk that folds the two spellings and on one that does not', async () => {
    // The acceptance criterion is about a case-insensitive filesystem, where
    // `Notes.md` already opens `notes.md`'s own file and the rename must not
    // read that as a clash. On a case-sensitive one the destination is simply
    // a free name. Both disks must let the rename through, and the disk is
    // asked rather than guessed from `process.platform`.
    await svc.writeFile(workspaceId, `${KB}/Sales/notes.md`, '# Notes\n');
    // The two pre-states, each asserted where it applies: on a folding disk
    // the destination already resolves to the source; elsewhere it is free.
    expect(await entryVisible(`${KB}/Sales/Notes.md`)).toBe(await foldsCase());

    await expect(
      svc.moveEntry(workspaceId, `${KB}/Sales/notes.md`, `${KB}/Sales/Notes.md`),
    ).resolves.toBeUndefined();

    expect(await fs.readFile(abs(`${KB}/Sales/Notes.md`), 'utf-8')).toBe('# Notes\n');
  });

  it('refuses a move onto a hard link of the source under another name', async () => {
    // One inode is not enough to read the destination as "the source itself".
    // `twin.md` is a name of its own in the tree — on every filesystem that
    // has hard links, case-folding or not — and a move onto it would take that
    // name away. A clash, exactly like any other.
    await svc.writeFile(workspaceId, `${KB}/Sales/notes.md`, '# Notes\n');
    await fs.link(abs(`${KB}/Sales/notes.md`), abs(`${KB}/Sales/twin.md`));

    await expect(
      svc.moveEntry(workspaceId, `${KB}/Sales/notes.md`, `${KB}/Sales/twin.md`),
    ).rejects.toMatchObject({
      name: 'EntryExistsError',
      status: 409,
      message: 'A file named twin.md already exists in Sales.',
    });

    expect(await fs.readFile(abs(`${KB}/Sales/twin.md`), 'utf-8')).toBe('# Notes\n');
    expect(await fs.readFile(abs(`${KB}/Sales/notes.md`), 'utf-8')).toBe('# Notes\n');
  });

  it('renames onto a free name exactly as before', async () => {
    await svc.writeFile(workspaceId, `${KB}/Sales/note.md`, 'note');

    await svc.moveEntry(workspaceId, `${KB}/Sales/note.md`, `${KB}/Sales/renamed.md`);

    expect(await fs.readFile(abs(`${KB}/Sales/renamed.md`), 'utf-8')).toBe('note');
    await expect(fs.access(abs(`${KB}/Sales/note.md`))).rejects.toBeDefined();
  });

  it('moves into another folder, creating the folders on the way, exactly as before', async () => {
    await svc.writeFile(workspaceId, `${KB}/Sales/note.md`, 'note');

    await svc.moveEntry(workspaceId, `${KB}/Sales/note.md`, `${KB}/Archive/2026/note.md`);

    expect(await fs.readFile(abs(`${KB}/Archive/2026/note.md`), 'utf-8')).toBe('note');
  });

  it('still answers ENOENT when there is nothing to move', async () => {
    // "There is nothing at the source" is the truer answer than "the
    // destination is taken", and it is the one this path always gave.
    await svc.writeFile(workspaceId, `${KB}/Sales/taken.md`, 'taken');

    await expect(
      svc.moveEntry(workspaceId, `${KB}/Sales/absent.md`, `${KB}/Sales/taken.md`),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    expect(await fs.readFile(abs(`${KB}/Sales/taken.md`), 'utf-8')).toBe('taken');
  });

  it('names the folder the destination is in, whichever folder that is', async () => {
    await svc.writeFile(workspaceId, `${KB}/taken.md`, 'taken');
    await svc.writeFile(workspaceId, `${KB}/note.md`, 'note');

    await expect(
      svc.moveEntry(workspaceId, `${KB}/note.md`, `${KB}/taken.md`),
    ).rejects.toMatchObject({ message: `A file named taken.md already exists in ${KB}.` });
  });
});
