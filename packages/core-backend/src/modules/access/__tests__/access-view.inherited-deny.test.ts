import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { emailsInView, labelAccountHolders, resolveAccessView } from '../access-view.js';

/**
 * A FILE'S VIEW REPORTS THE DENY IT INHERITS FROM A FOLDER, END TO END.
 *
 * QA found it on `QAAccess/Deal.md`: the folder lets the QAEditors role edit
 * and denies one of its members, qa-denied, by name. The folder's own dialog
 * lists that deny. The file's listed the role as "Can edit" and said nothing
 * about qa-denied, who cannot edit (the gate refuses), because the person held
 * nothing any eligible list names and the only denied principals the view
 * added were the file's OWN. These tests hold the view to the gate, through the
 * real resolver and real files.
 */

const KB = 'knowledge-base';
const WS = 'ws-inherited-deny';
const DENIED = 'qa-denied@example.com';
const PARENT_MD = 'QAAccess/access.md';

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

function stubWorkspace(workspaceDir: string): WorkspaceService {
  return { getWorkspacePath: async () => workspaceDir } as unknown as WorkspaceService;
}

describe('a deny written in a folder above reaches the view of what it holds', () => {
  let root: string;
  let repo: string;
  let access: AccessControlService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-inherited-deny-'));
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await write(
      repo,
      'roles.yaml',
      `roles:\n  Admin:\n    - root@example.com\n  QAEditors:\n    - ed@example.com\n    - ${DENIED}\n`,
    );
    await write(repo, 'groups.yaml', 'groups:\n  GTM Team:\n    - pat@example.com\n');
    await write(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n# Root\n');
    await write(
      repo,
      PARENT_MD,
      `---\nwrite:\n  - QAEditors\n  - deny ${DENIED}\nread:\n  - deny GTM Team\n---\n# QAAccess\n`,
    );
    access = new AccessControlService(stubWorkspace(workspaceDir), KB, new NodeFs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function view(target: string, kind: 'file' | 'folder') {
    access.invalidate(WS);
    return resolveAccessView(access, WS, target, 'root@example.com', kind);
  }

  it('on a file with its own frontmatter: the person, and the folder the deny is written in', async () => {
    await write(repo, 'QAAccess/Deal.md', '---\nread:\n  - ed@example.com\n---\n# Deal\n');
    const v = await view('QAAccess/Deal.md', 'file');

    expect(v.deniedAbove.users).toEqual([{ name: expect.any(String), email: DENIED }]);
    expect(v.denials[`u:${DENIED}`]?.write).toEqual([{ kind: 'ancestor', path: PARENT_MD }]);
    // Not a deny of the file's own: nothing to lift here.
    expect(v.deniedHere.users).toEqual([]);
    // And it is what the gate enforces.
    expect(await access.canWrite(WS, DENIED, 'QAAccess/Deal.md')).toBe(false);
    expect(await access.canWrite(WS, 'ed@example.com', 'QAAccess/Deal.md')).toBe(true);
  });

  it('on a plain file in a subfolder: the same row, naming the folder two levels up', async () => {
    await write(repo, 'QAAccess/Sub/Note.md', '# Note\n');
    const v = await view('QAAccess/Sub/Note.md', 'file');

    expect(v.deniedAbove.users.map((u) => u.email)).toEqual([DENIED]);
    expect(v.denials[`u:${DENIED}`]?.write).toEqual([{ kind: 'ancestor', path: PARENT_MD }]);
    expect(await access.canWrite(WS, DENIED, 'QAAccess/Sub/Note.md')).toBe(false);
  });

  it('a collective a folder above denies is reported the same way, keyed as the group it is', async () => {
    await write(repo, 'QAAccess/Sub/Note.md', '# Note\n');
    const v = await view('QAAccess/Sub/Note.md', 'file');

    expect(v.deniedAbove.principals).toEqual([{ name: 'GTM Team', kind: 'group' }]);
    expect(v.denials['g:gtm team']?.read).toEqual([{ kind: 'ancestor', path: PARENT_MD }]);
    expect(await access.canRead(WS, 'pat@example.com', 'QAAccess/Sub/Note.md')).toBe(false);
  });

  it('a subfolder too: the deny comes from above it', async () => {
    await write(repo, 'QAAccess/Sub/Note.md', '# Note\n');
    const v = await view('QAAccess/Sub', 'folder');

    expect(v.deniedAbove.users.map((u) => u.email)).toEqual([DENIED]);
    expect(v.denials[`u:${DENIED}`]?.write).toEqual([{ kind: 'ancestor', path: PARENT_MD }]);
  });

  it("the folder's own deny stays its own: deniedHere on the folder, not deniedAbove", async () => {
    const v = await view('QAAccess', 'folder');

    expect(v.deniedHere.users.map((u) => u.email)).toEqual([DENIED]);
    expect(v.deniedAbove.users).toEqual([]);
    expect(v.deniedAbove.principals).toEqual([]);
  });

  it('a deny a closer grant beats is not reported: no row, no sources', async () => {
    await write(repo, 'QAAccess/Sub/access.md', `---\nwrite:\n  - ${DENIED}\nread:\n  - GTM Team\n---\n`);
    await write(repo, 'QAAccess/Sub/Note.md', '# Note\n');
    const v = await view('QAAccess/Sub/Note.md', 'file');

    expect(await access.canWrite(WS, DENIED, 'QAAccess/Sub/Note.md')).toBe(true);
    expect(v.deniedAbove).toEqual({ principals: [], users: [] });
    expect(v.denials[`u:${DENIED}`]).toBeUndefined();
    expect(v.denials['g:gtm team']).toBeUndefined();
  });

  it('a deny that only beats the parent for the verbs it names leaves no stray row', async () => {
    // The folder denies GTM Team read; a closer grant gives it back. A row with
    // no denial and no grant listed would claim a restriction nobody enforces.
    await write(repo, 'QAAccess/Sub/access.md', '---\nread:\n  - GTM Team\n---\n');
    await write(repo, 'QAAccess/Sub/Note.md', '# Note\n');
    const v = await view('QAAccess/Sub/Note.md', 'file');

    expect(v.deniedAbove.principals).toEqual([]);
    // The group still has its row as a reader, through the eligible list.
    expect(v.readers.principals).toContainEqual({ name: 'GTM Team', kind: 'group' });
  });

  it('a deny in the root folder reaches a file at the root', async () => {
    await write(repo, 'access.md', `---\nwrite:\n  - Admin\n  - QAEditors\n  - deny ${DENIED}\n---\n# Root\n`);
    await write(repo, 'Top.md', '# Top\n');
    const v = await view('Top.md', 'file');

    expect(v.deniedAbove.users.map((u) => u.email)).toEqual([DENIED]);
    expect(v.denials[`u:${DENIED}`]?.write).toEqual([{ kind: 'ancestor', path: 'access.md' }]);
  });

  it('the person a folder above denies is labelled like any other person the view names', async () => {
    await write(repo, 'QAAccess/Sub/Note.md', '# Note\n');
    const v = await view('QAAccess/Sub/Note.md', 'file');

    expect(emailsInView(v)).toContain(DENIED);
    const labelled = labelAccountHolders(v, new Set([DENIED]));
    expect(labelled.deniedAbove.users).toEqual([{ name: expect.any(String), email: DENIED, hasAccount: true }]);
  });
});
