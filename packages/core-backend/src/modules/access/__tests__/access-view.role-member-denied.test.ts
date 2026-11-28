import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/index.js';
import type { AccessControlService } from '../access-control.service.js';
import { resolveAccessView } from '../access-view.js';
import { accessRulesPathOf, bytesAreText } from '../access-mutation.service.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { realAccessControl } from '../../../__tests__/real-access.js';

/**
 * A ROLE MEMBER DENIED ONE VERB STILL HOLDS THE REST, AND THE VIEW SAYS SO.
 *
 * QA's case, through the real resolver: `QAAccess/access.md` writes
 * `write: [QAEditors, deny QA Denied <qa-denied@example.com>]`, and qa-denied
 * is a QAEditors member. Every gate lets them read; none lets them write. The
 * view named them in `deniedHere` but in no eligible list (those name a person
 * only for a grant to their own address), so the dialog's row held nothing and
 * read "No access". `holds` carries the resolver's own verdicts for them.
 */

const KB = 'knowledge-base';
const WS = 'ws-role-deny';
const FOLDER = 'QAAccess';
const NOTE = 'QAAccess/Sub/Note.md';
const RULES = `${FOLDER}/access.md`;
const DENIED = 'qa-denied@example.com';
const CONTROL = 'qa-control@example.com';

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

function stubWorkspace(workspaceDir: string): WorkspaceService {
  const resolve = (wsRel: string) => path.join(workspaceDir, wsRel);
  return {
    getWorkspacePath: async () => workspaceDir,
    getOrCreateForBranch: async () => ({}) as unknown,
    readFile: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel), 'utf-8'),
    readFileBinary: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel)),
  } as unknown as WorkspaceService;
}

describe('the access view of a role member denied write', () => {
  let root: string;
  let access: AccessControlService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-role-deny-'));
    const workspaceDir = path.join(root, WS);
    const repo = path.join(workspaceDir, KB);
    await write(
      repo,
      'roles.yaml',
      `roles:\n  Admin:\n    - root@example.com\n  QAEditors:\n    - ${DENIED}\n    - ${CONTROL}\n`,
    );
    await write(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n# Root\n');
    await write(
      repo,
      `${FOLDER}/access.md`,
      `---\nwrite:\n  - QAEditors\n  - deny QA Denied <${DENIED}>\n---\n# QA\n`,
    );
    await write(repo, NOTE, '# Note\n');
    access = realAccessControl(stubWorkspace(workspaceDir), KB, realDisk());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports what the denied member still holds, matching every gate', async () => {
    const v = await resolveAccessView(access, WS, FOLDER, 'root@example.com', 'folder', RULES);

    // The person is named only by the denial, never by a list of holders.
    expect(v.deniedHere.users.map((u) => u.email)).toEqual([DENIED]);
    expect(v.readers.users).toEqual([]);
    expect(v.denials[`u:${DENIED}`]).toEqual({ write: [{ kind: 'direct' }] });

    // What they hold is the resolver's verdict: read through QAEditors, write denied.
    expect(v.holds[`u:${DENIED}`]).toEqual({ read: true, write: false, download: false, owner: false });
    expect(v.holds[`u:${DENIED}`]).toEqual({
      read: await access.canRead(WS, DENIED, FOLDER),
      write: await access.canWrite(WS, DENIED, FOLDER),
      download: await access.canDownload(WS, DENIED, FOLDER),
      owner: await access.canOwner(WS, DENIED, FOLDER),
    });
    // And the file below is readable to them, not writable — what QA saw as 200.
    expect(await access.canRead(WS, DENIED, NOTE)).toBe(true);
    expect(await access.canWrite(WS, DENIED, NOTE)).toBe(false);
  });

  it('gives no person entry to a member nobody denied: the role row is theirs', async () => {
    const v = await resolveAccessView(access, WS, FOLDER, 'root@example.com', 'folder', RULES);

    expect(v.holds[`u:${CONTROL}`]).toBeUndefined();
    expect(await access.canWrite(WS, CONTROL, FOLDER)).toBe(true);
    expect(v.eligible.roles).toContain('QAEditors');
  });

  it('holds nothing for a person denied every verb here', async () => {
    const repo = path.join(root, WS, KB);
    await write(
      repo,
      `${FOLDER}/access.md`,
      `---\nread:\n  - deny QA Denied <${DENIED}>\nwrite:\n  - QAEditors\n  - deny QA Denied <${DENIED}>\n---\n# QA\n`,
    );
    access.invalidate(WS);
    const v = await resolveAccessView(access, WS, FOLDER, 'root@example.com', 'folder', RULES);

    expect(v.holds[`u:${DENIED}`]).toEqual({ read: false, write: false, download: false, owner: false });
  });
});

describe("the access view withholds other people's verdicts from a caller who cannot change this access", () => {
  const OTHER = 'qa-denied-2@example.com';
  const OUTSIDER = 'outsider@example.com';
  let root: string;
  let access: AccessControlService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-role-deny-gate-'));
    const workspaceDir = path.join(root, WS);
    const repo = path.join(workspaceDir, KB);
    await write(
      repo,
      'roles.yaml',
      `roles:\n  Admin:\n    - root@example.com\n  QAEditors:\n    - ${DENIED}\n    - ${OTHER}\n`,
    );
    await write(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n# Root\n');
    await write(
      repo,
      `${FOLDER}/access.md`,
      `---\nwrite:\n  - QAEditors\n  - deny QA Denied <${DENIED}>\n  - deny QA Denied 2 <${OTHER}>\n---\n# QA\n`,
    );
    access = realAccessControl(stubWorkspace(workspaceDir), KB, realDisk());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a manager gets every denied person', async () => {
    const v = await resolveAccessView(access, WS, FOLDER, 'root@example.com', 'folder', RULES);
    expect(Object.keys(v.holds).sort()).toEqual([`u:${OTHER}`, `u:${DENIED}`].sort());
  });

  it('a denied person who cannot write the rules gets their own verdicts and nobody else', async () => {
    expect(await access.canWrite(WS, DENIED, `${FOLDER}/access.md`)).toBe(false);
    const v = await resolveAccessView(access, WS, FOLDER, DENIED, 'folder', RULES);

    expect(v.holds).toEqual({
      [`u:${DENIED}`]: { read: v.canRead, write: v.canWrite, download: v.canDownload, owner: v.canOwner },
    });
    expect(v.holds[`u:${DENIED}`].read).toBe(true);
  });

  it('a caller who cannot even read the folder gets no verdicts at all', async () => {
    expect(await access.canRead(WS, OUTSIDER, FOLDER)).toBe(false);
    const v = await resolveAccessView(access, WS, FOLDER, OUTSIDER, 'folder', RULES);
    expect(v.holds).toEqual({});
  });

  it('without a rules path, even a manager gets nobody else', async () => {
    const v = await resolveAccessView(access, WS, FOLDER, 'root@example.com', 'folder');
    expect(v.holds).toEqual({});
  });
});

describe('the rules file that gates the view is judged on bytes as well as the name', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-rules-path-'));
    await write(dir, 'QAAccess/Note.md', '# Note\n');
    await fs.writeFile(path.join(dir, 'QAAccess/Binary.md'), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0x00, 0xff]));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  const holdsText = (f: string) => bytesAreText(() => fs.readFile(path.join(dir, f)));

  it("a folder's is its access.md; a text note's is the note itself", async () => {
    expect(await accessRulesPathOf('folder', FOLDER, holdsText)).toBe(RULES);
    expect(await accessRulesPathOf('file', 'QAAccess/Note.md', holdsText)).toBe('QAAccess/Note.md');
  });

  it("a .md holding bytes that are not text is governed by its folder's access.md, as the mutations say", async () => {
    expect(await accessRulesPathOf('file', 'QAAccess/Binary.md', holdsText)).toBe(RULES);
  });

  it('a file that cannot carry rules by its name is governed by its folder without being read', async () => {
    let reads = 0;
    const counting = async () => {
      reads++;
      return true;
    };
    expect(await accessRulesPathOf('file', 'QAAccess/Deck.pdf', counting)).toBe(RULES);
    expect(reads).toBe(0);
  });

  it('a missing note is its own rules file; any other read failure gives it to the folder', async () => {
    expect(await accessRulesPathOf('file', 'QAAccess/New.md', holdsText)).toBe('QAAccess/New.md');
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    expect(
      await accessRulesPathOf('file', 'QAAccess/Note.md', () => bytesAreText(() => Promise.reject(eacces))),
    ).toBe(RULES);
  });
});
