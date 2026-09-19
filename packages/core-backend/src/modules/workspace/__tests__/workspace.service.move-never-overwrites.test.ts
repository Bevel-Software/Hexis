import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      KB,
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

  it('allows a case-only rename: the entry found at the destination is the source itself', async () => {
    // A case-insensitive filesystem opens `Notes.md` and `notes.md` as ONE
    // file. On the case-sensitive disk this suite runs on, a hard link is the
    // same thing to the check that matters: two names, one inode. The rename
    // must not read that as a clash with something else.
    await svc.writeFile(workspaceId, `${KB}/Sales/notes.md`, '# Notes\n');
    await fs.link(abs(`${KB}/Sales/notes.md`), abs(`${KB}/Sales/Notes.md`));

    await expect(
      svc.moveEntry(workspaceId, `${KB}/Sales/notes.md`, `${KB}/Sales/Notes.md`),
    ).resolves.toBeUndefined();

    expect(await fs.readFile(abs(`${KB}/Sales/Notes.md`), 'utf-8')).toBe('# Notes\n');
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
