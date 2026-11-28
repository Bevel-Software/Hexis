import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/index.js';
import type { AccessControlService } from '../access-control.service.js';
import { resolveAccessView } from '../access-view.js';
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
    const v = await resolveAccessView(access, WS, FOLDER, 'root@example.com', 'folder');

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
    const v = await resolveAccessView(access, WS, FOLDER, 'root@example.com', 'folder');

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
    const v = await resolveAccessView(access, WS, FOLDER, 'root@example.com', 'folder');

    expect(v.holds[`u:${DENIED}`]).toEqual({ read: false, write: false, download: false, owner: false });
  });
});
