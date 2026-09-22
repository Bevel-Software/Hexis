import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import {
  KNOWN_VERBS,
  VERB_REQUIRES,
  requiredVerbsFor,
  sourceVerbsFor,
} from '../../access-model/access-grammar.js';

/**
 * A DENIAL TAKES DOWN EVERYTHING THAT PRESUPPOSES THE DENIED VERB.
 *
 * On core-staging, `KnowledgeBase/Finance/access.md` denied the Admin role
 * read, write and download — and the Manage access sheet still showed Admin as
 * Owner, because the root grants `owner: Admin` and resolving `owner` read
 * only `owner:` lines. Owner presupposes write, which presupposes read; a
 * denial of either at a closer scope has to strip owner there, or the sheet
 * says "Owner" about someone who may not open the folder, and `canOwner`
 * still lets them manage its access.
 *
 * The rule is not written into the resolver. The grammar declares what each
 * verb presupposes (`VERB_REQUIRES`) and the resolver reads the two lists
 * derived from it: grants confer downwards, denials strip upwards. These tests
 * pin the derivation, the enforcement, and the one thing that did NOT change:
 * a superset denial (`deny write`) still says nothing about `read`.
 */

const KB_DIR = 'knowledge-base';

function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
    ensureRemotesFetched: async () => undefined,
  } as unknown as WorkspaceService;
}

const ROLES_YAML = `roles:
  Admin:
    - admin@x.io
  Finance:
    - fin@x.io
`;

describe('the grammar derives both folds from one dependency graph', () => {
  it('declares what each verb presupposes, and only that', () => {
    expect(VERB_REQUIRES).toEqual({
      read: [],
      write: ['read'],
      download: ['read'],
      owner: ['write', 'download'],
    });
  });

  it('grants confer downwards: the verbs whose grant confers each verb', () => {
    expect(sourceVerbsFor('read')).toEqual(['read', 'write', 'download', 'owner']);
    expect(sourceVerbsFor('write')).toEqual(['write', 'owner']);
    expect(sourceVerbsFor('download')).toEqual(['download', 'owner']);
    expect(sourceVerbsFor('owner')).toEqual(['owner']);
  });

  it('denials strip upwards: the verbs whose denial strips each verb', () => {
    expect(requiredVerbsFor('read')).toEqual(['read']);
    expect(requiredVerbsFor('write')).toEqual(['write', 'read']);
    expect(requiredVerbsFor('download')).toEqual(['download', 'read']);
    expect(requiredVerbsFor('owner')).toEqual(['owner', 'read', 'write', 'download']);
  });

  it('the two lists are each other\'s transpose, for every verb', () => {
    // A grant of v confers w exactly when a denial of w strips v: both are
    // "v presupposes w", read from the one table, so the lists cannot disagree.
    for (const v of KNOWN_VERBS) {
      for (const w of KNOWN_VERBS) {
        expect(sourceVerbsFor(w).includes(v)).toBe(requiredVerbsFor(v).includes(w));
      }
    }
  });
});

describe('a closer denial strips the verbs that presuppose it', () => {
  let root: string;
  const workspaceId = 'ws-deny-dependents';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-deny-dependents-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function makeService(files: Record<string, string>) {
    const workspaceDir = path.join(root, workspaceId);
    const repo = path.join(workspaceDir, KB_DIR);
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
    return new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), KB_DIR, new NodeFs());
  }

  const BASE = { 'roles.yaml': ROLES_YAML };
  const FINANCE = 'KnowledgeBase/Finance';
  const DOC = `${FINANCE}/Budget.md`;

  it('the Finance case: read, write and download denied here leave no owner standing', async () => {
    const svc = await makeService({
      ...BASE,
      'access.md': '---\n---\nowner:\n  - Admin\nread:\n  - everyone\n',
      [`${FINANCE}/access.md`]:
        '---\n---\nread:\n  - Finance\n  - deny role/Admin\nwrite:\n  - Finance\n  - deny Admin\ndownload:\n  - deny Admin\n',
    });
    expect(await svc.canOwner(workspaceId, 'admin@x.io', DOC)).toBe(false);
    expect(await svc.canWrite(workspaceId, 'admin@x.io', DOC)).toBe(false);
    expect(await svc.canDownload(workspaceId, 'admin@x.io', DOC)).toBe(false);
    expect(await svc.canRead(workspaceId, 'admin@x.io', DOC)).toBe(false);
    // And the sheet's owner list — what read "Owner" on staging — agrees.
    const owners = await svc.eligibleOwners(workspaceId, FINANCE);
    expect(owners.roles).not.toContain('Admin');
    // Above Finance the root grant is untouched.
    expect(await svc.canOwner(workspaceId, 'admin@x.io', 'KnowledgeBase/Sales/Deal.md')).toBe(true);
    expect((await svc.eligibleOwners(workspaceId, 'KnowledgeBase/Sales')).roles).toContain('Admin');
  });

  it('`deny write` alone strips owner, and leaves the read and download the owner grant conferred', async () => {
    const svc = await makeService({
      ...BASE,
      'access.md': '---\n---\nowner:\n  - Ana <ana@x.io>\n',
      [`${FINANCE}/access.md`]: '---\n---\nwrite:\n  - deny Ana <ana@x.io>\n',
    });
    expect(await svc.canOwner(workspaceId, 'ana@x.io', DOC)).toBe(false);
    expect(await svc.canWrite(workspaceId, 'ana@x.io', DOC)).toBe(false);
    // A superset denial still says nothing about the verbs below it.
    expect(await svc.canRead(workspaceId, 'ana@x.io', DOC)).toBe(true);
    expect(await svc.canDownload(workspaceId, 'ana@x.io', DOC)).toBe(true);
  });

  it('`deny read` alone strips write, download and owner: nobody edits or saves what they may not open', async () => {
    const svc = await makeService({
      ...BASE,
      'access.md': '---\n---\nowner:\n  - Ana <ana@x.io>\n',
      [`${FINANCE}/access.md`]: '---\n---\nread:\n  - deny Ana <ana@x.io>\n',
    });
    expect(await svc.canRead(workspaceId, 'ana@x.io', DOC)).toBe(false);
    expect(await svc.canWrite(workspaceId, 'ana@x.io', DOC)).toBe(false);
    expect(await svc.canDownload(workspaceId, 'ana@x.io', DOC)).toBe(false);
    expect(await svc.canOwner(workspaceId, 'ana@x.io', DOC)).toBe(false);
  });

  it('`deny download` alone strips owner and nothing else', async () => {
    const svc = await makeService({
      ...BASE,
      'access.md': '---\n---\nowner:\n  - Ana <ana@x.io>\n',
      [`${FINANCE}/access.md`]: '---\n---\ndownload:\n  - deny Ana <ana@x.io>\n',
    });
    expect(await svc.canOwner(workspaceId, 'ana@x.io', DOC)).toBe(false);
    expect(await svc.canDownload(workspaceId, 'ana@x.io', DOC)).toBe(false);
    expect(await svc.canWrite(workspaceId, 'ana@x.io', DOC)).toBe(true);
    expect(await svc.canRead(workspaceId, 'ana@x.io', DOC)).toBe(true);
  });

  it('a grant in the SAME scope still beats a prerequisite denial beside it', async () => {
    const svc = await makeService({
      ...BASE,
      'access.md': '---\n---\nowner:\n  - Ana <ana@x.io>\nwrite:\n  - deny Ana <ana@x.io>\n',
    });
    // Within one file a grant wins, as it always has (`owner:` beats `deny write`).
    expect(await svc.canOwner(workspaceId, 'ana@x.io', DOC)).toBe(true);
    expect(await svc.canWrite(workspaceId, 'ana@x.io', DOC)).toBe(true);
  });

  it('the implied denial is an effective verdict, not a line: sources report the prerequisite, and the owner grant is cut off', async () => {
    const svc = await makeService({
      ...BASE,
      'access.md': '---\n---\nowner:\n  - Ana <ana@x.io>\n',
      [`${FINANCE}/access.md`]: '---\n---\nwrite:\n  - deny Ana <ana@x.io>\n',
    });
    const ana = { kind: 'user' as const, email: 'ana@x.io' };
    // What can be lifted here is the `deny write` line — the sheet must not
    // offer a `deny owner` that no file holds.
    const denials = await svc.denialSources(workspaceId, 'folder', FINANCE, ana);
    expect(denials.write).toEqual([{ kind: 'direct' }]);
    expect(denials.owner).toBeUndefined();
    // And the root's owner grant no longer reaches Finance: it is shadowed by
    // the closer denial, so it is not a source of anything held here.
    const grants = await svc.grantSources(workspaceId, 'folder', FINANCE, ana);
    expect(grants.owner).toBeUndefined();
    expect(grants.write).toBeUndefined();
    expect(grants.read).toEqual([{ kind: 'ancestor', path: 'access.md' }]);
  });

  it('a role denied read at a closer scope takes the Admin write floor down with it there', async () => {
    const svc = await makeService({
      ...BASE,
      'access.md': '---\n---\nowner:\n  - Admin\n',
      [`${FINANCE}/access.md`]: '---\n---\nread:\n  - Finance\n  - deny role/Admin\n',
    });
    // The floor holds at the ROOT scope; a nearer scope that denies Admin
    // decides first, as it already did for a `deny write` — and now for the
    // `deny read` that write presupposes.
    expect(await svc.canWrite(workspaceId, 'admin@x.io', DOC)).toBe(false);
    expect(await svc.canWrite(workspaceId, 'admin@x.io', 'KnowledgeBase/Sales/Deal.md')).toBe(true);
    // The rescue on access files themselves is untouched: an admin can still
    // repair the very file that excludes them.
    expect(await svc.canWrite(workspaceId, 'admin@x.io', `${FINANCE}/access.md`)).toBe(true);
  });
});
