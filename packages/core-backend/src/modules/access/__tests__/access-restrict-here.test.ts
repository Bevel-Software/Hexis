import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { AccessMutationService } from '../access-mutation.service.js';
import { resolveAccessView } from '../access-view.js';
import type { Principal } from '../../access-model/access-splice.js';

/**
 * RESTRICTING BELOW A PARENT, END TO END THROUGH THE REAL RESOLVER.
 *
 * The dialog now states a whole verb SET on a row and the writes follow from
 * the difference. That only works if two things hold on the server, and only
 * the real files can prove either:
 *
 *   1. the sequence the dialog sends really does land the picked set — the
 *      verdicts the sheet shows after its reload are the ones the gate then
 *      enforces, not a hopeful rendering of what was requested;
 *   2. the view REPORTS the restriction — per verb, with its source, and with
 *      the restricted principal still in the payload at all. A principal denied
 *      every verb holds nothing, so no eligible list can carry them; before
 *      `deniedHere`, writing a restriction made the person vanish from the sheet
 *      that wrote it. That was the bug.
 *
 * `applySet` below mirrors `doApplyVerbSet` in the dialog deliberately: the
 * ORDER is load-bearing (a grant folds downward inside one scope, so denying
 * write under a live `owner:` here is refused as ineffective) and a test that
 * quietly used a different order would pass while the UI failed.
 */

const KB = 'knowledge-base';
const WS = 'ws-restrict';
const VERBS_BROADEST_FIRST = ['owner', 'write', 'download', 'read'] as const;
type Verb = (typeof VERBS_BROADEST_FIRST)[number];

const ROLES_YAML = `roles:
  Admin:
    - root@example.com
`;

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-restrict-'));
}

/** Stub WorkspaceService backed by a real temp repo: path/read/write only. */
function stubWorkspace(workspaceDir: string): WorkspaceService {
  const resolve = (wsRel: string) => path.join(workspaceDir, wsRel);
  return {
    getWorkspacePath: async () => workspaceDir,
    getOrCreateForBranch: async () => ({}) as unknown,
    readFile: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel), 'utf-8'),
    readFileBinary: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel)),
    writeFile: async (_id: string, wsRel: string, content: string) => {
      const abs = resolve(wsRel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
    },
  } as unknown as WorkspaceService;
}

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

describe('restricting below a parent keeps the principal reported', () => {
  let root: string;
  let repo: string;
  let access: AccessControlService;
  let mutation: AccessMutationService;

  /** The folder under test, and the parent whose grants it inherits. */
  const FOLDER = 'Sales/Deals';
  const PARENT_MD = 'Sales/access.md';

  const ALICE: Principal = { kind: 'user', email: 'alice@example.com', displayName: 'Alice' };
  /** A group grant is a BARE token — group-first precedence resolves it. */
  const GTM: Principal = { kind: 'role', role: 'GTM Team' };

  beforeEach(async () => {
    root = await mkTmpRoot();
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await fs.mkdir(repo, { recursive: true });
    await write(repo, 'roles.yaml', ROLES_YAML);
    await write(repo, 'groups.yaml', 'groups:\n  GTM Team:\n    - pat@example.com\n');
    await write(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n# Root\n');
    const ws = stubWorkspace(workspaceDir);
    access = new AccessControlService(ws, KB, new NodeFs());
    mutation = new AccessMutationService(ws, access, KB);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Which verbs the principal effectively holds at `FOLDER`, straight from the resolver. */
  async function effective(principal: Principal): Promise<Record<Verb, boolean>> {
    access.invalidate(WS);
    const email = principal.kind === 'user' ? principal.email : 'pat@example.com';
    return {
      owner: await access.canOwner(WS, email, FOLDER),
      write: await access.canWrite(WS, email, FOLDER),
      download: await access.canDownload(WS, email, FOLDER),
      read: await access.canRead(WS, email, FOLDER),
    };
  }

  /**
   * The dialog's own algorithm, against the real mutation service — lower from
   * the broadest verb down, lift the denials the new set no longer needs, then
   * grant the minimum that produces the rest.
   *
   * `null` is Deny: one verb-less `deny-here`, which strips every local grant
   * and denies all four verbs, read included.
   */
  async function applySet(
    principal: Principal,
    picked: Partial<Record<Verb, boolean>> | null,
  ): Promise<void> {
    const opts = principal.kind === 'role' ? ({ tokenMatch: 'exact' } as const) : undefined;
    if (picked === null) {
      await mutation.denyHere(WS, 'folder', FOLDER, principal, undefined, opts);
      access.invalidate(WS);
      return;
    }
    for (const verb of VERBS_BROADEST_FIRST) {
      if (picked[verb]) continue;
      if (!(await effective(principal))[verb]) continue;
      const src = await access.grantSources(WS, 'folder', FOLDER, toGrantPrincipal(principal), opts);
      const list = src[verb] ?? [];
      const localOnly = list.length > 0 && list.every((s) => s.kind === 'direct');
      if (localOnly) await mutation.revoke(WS, 'folder', FOLDER, principal, 'me@x', verb, opts);
      else await mutation.denyHere(WS, 'folder', FOLDER, principal, verb, opts);
      access.invalidate(WS);
      if (localOnly && (await effective(principal))[verb]) {
        await mutation.denyHere(WS, 'folder', FOLDER, principal, verb, opts);
        access.invalidate(WS);
      }
    }
    for (const verb of VERBS_BROADEST_FIRST) {
      if (!picked[verb]) continue;
      const denials = await access.denialSources(
        WS,
        'folder',
        FOLDER,
        toGrantPrincipal(principal),
        opts,
      );
      if (!(denials[verb] ?? []).some((s) => s.kind === 'direct')) continue;
      await mutation.revoke(WS, 'folder', FOLDER, principal, 'me@x', verb, opts);
      access.invalidate(WS);
    }
    for (const verb of minimalGrants(picked)) {
      if ((await effective(principal))[verb]) continue;
      await mutation.grant(WS, 'folder', FOLDER, verb, principal);
      access.invalidate(WS);
    }
  }

  function minimalGrants(set: Partial<Record<Verb, boolean>>): Verb[] {
    const out: Verb[] = [];
    if (set.owner) out.push('owner');
    else if (set.write) out.push('write');
    else if (set.read && !set.download) out.push('read');
    if (set.download && !set.owner) out.push('download');
    return out;
  }

  function toGrantPrincipal(p: Principal) {
    return p.kind === 'user'
      ? ({ kind: 'user', email: p.email } as const)
      : ({ kind: 'role', role: p.role } as const);
  }

  const SET = {
    owner: { owner: true, write: true, read: true, download: true },
    edit: { write: true, read: true },
    read: { read: true },
    download: { read: true, download: true },
  } satisfies Record<string, Partial<Record<Verb, boolean>>>;

  /** The access view the dialog reads, for this folder. */
  async function view() {
    access.invalidate(WS);
    return resolveAccessView(access, WS, FOLDER, 'root@example.com', 'folder');
  }

  // ── a direct principal ───────────────────────────────────────────────────

  describe('a person who inherits edit from the parent folder', () => {
    beforeEach(async () => {
      await write(repo, PARENT_MD, '---\nwrite:\n  - Alice <alice@example.com>\n---\n# Sales\n');
      await write(repo, `${FOLDER}/access.md`, '---\nwrite:\n  - Admin\n---\n# Deals\n');
      access.invalidate(WS);
      expect(await effective(ALICE)).toEqual({
        owner: false,
        write: true,
        download: false,
        read: true,
      });
    });

    it('lowering the set by ONE verb writes a verb-scoped deny and leaves the implied read', async () => {
      await applySet(ALICE, SET.read);

      // The point of a verb-scoped denial: `deny write` does not take read with
      // it, so the read the parent's edit grant implies survives.
      expect(await effective(ALICE)).toEqual({
        owner: false,
        write: false,
        download: false,
        read: true,
      });
      const md = await fs.readFile(path.join(repo, FOLDER, 'access.md'), 'utf-8');
      expect(md).toContain('deny Alice <alice@example.com>');
      // Only write is denied — nothing was written under `read:`.
      expect(md).not.toMatch(/read:[\s\S]*deny Alice/);
    });

    it('the view reports that denial per verb, with its source', async () => {
      await applySet(ALICE, SET.read);
      const v = await view();

      expect(v.denials['u:alice@example.com']).toEqual({ write: [{ kind: 'direct' }] });
      // Read is still hers, and still says where from — the two maps together
      // are what let the row read "Can read from Sales / Can edit restricted here".
      expect(v.sources['u:alice@example.com'].read).toEqual([
        { kind: 'ancestor', path: PARENT_MD },
      ]);
      expect(v.sources['u:alice@example.com'].write).toBeUndefined();
      // And she is named as restricted HERE, which is what keeps her row on this
      // folder instead of collapsing into the parent's section.
      expect(v.deniedHere.users).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    });

    it('raising the set back removes the denial and restores the parent grant', async () => {
      await applySet(ALICE, SET.read);
      await applySet(ALICE, SET.edit);

      expect(await effective(ALICE)).toEqual({
        owner: false,
        write: true,
        download: false,
        read: true,
      });
      const md = await fs.readFile(path.join(repo, FOLDER, 'access.md'), 'utf-8');
      expect(md).not.toContain('deny Alice');
      // Restored from the PARENT — nothing redundant was written here.
      const v = await view();
      expect(v.sources['u:alice@example.com'].write).toEqual([
        { kind: 'ancestor', path: PARENT_MD },
      ]);
      expect(v.denials['u:alice@example.com']).toBeUndefined();
      expect(v.deniedHere.users).toEqual([]);
    });

    it('raising ABOVE the parent grants here only the part the parent does not give', async () => {
      await applySet(ALICE, SET.read);
      await applySet(ALICE, SET.owner);

      expect(await effective(ALICE)).toEqual({
        owner: true,
        write: true,
        download: true,
        read: true,
      });
      const v = await view();
      // One line, the highest tier: owner carries the other three.
      expect(v.sources['u:alice@example.com'].owner).toEqual([{ kind: 'direct' }]);
      expect(v.denials['u:alice@example.com']).toBeUndefined();
    });

    it('Deny takes every verb, read included, and the person is STILL in the payload', async () => {
      await applySet(ALICE, null);

      expect(await effective(ALICE)).toEqual({
        owner: false,
        write: false,
        download: false,
        read: false,
      });
      const v = await view();
      // She holds nothing, so every eligible list has dropped her — exactly the
      // state in which the sheet used to lose the row entirely.
      expect(v.readers.users).toEqual([]);
      expect(v.eligible.users).toEqual([]);
      expect(v.deniedHere.users).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
      expect(v.denials['u:alice@example.com']).toEqual({
        read: [{ kind: 'direct' }],
        write: [{ kind: 'direct' }],
        download: [{ kind: 'direct' }],
        owner: [{ kind: 'direct' }],
      });
    });

    it('picking a set after Deny lifts the block and applies the set', async () => {
      await applySet(ALICE, null);
      await applySet(ALICE, SET.read);

      expect(await effective(ALICE)).toEqual({
        owner: false,
        write: false,
        download: false,
        read: true,
      });
      const v = await view();
      // Read comes back from the PARENT, not from a new grant here: lifting the
      // `deny read` uncovers the read the parent's edit grant always implied.
      // The other three denials stay — "Can read" is what was asked for.
      expect(v.sources['u:alice@example.com'].read).toEqual([
        { kind: 'ancestor', path: PARENT_MD },
      ]);
      expect(v.denials['u:alice@example.com']?.read).toBeUndefined();
      expect(v.denials['u:alice@example.com']?.write).toEqual([{ kind: 'direct' }]);
      expect(v.denials['u:alice@example.com']?.owner).toEqual([{ kind: 'direct' }]);
      // The row survives the whole round trip, still reported as restricted here.
      expect(v.deniedHere.users).toEqual([{ name: 'Alice', email: 'alice@example.com' }]);
    });
  });

  // ── a group principal ────────────────────────────────────────────────────

  describe('a GROUP that inherits download from the parent folder', () => {
    beforeEach(async () => {
      await write(repo, PARENT_MD, '---\ndownload:\n  - GTM Team\n---\n# Sales\n');
      await write(repo, `${FOLDER}/access.md`, '---\nwrite:\n  - Admin\n---\n# Deals\n');
      access.invalidate(WS);
      // Download folds down into read: a member may open what they may copy.
      expect(await effective(GTM)).toEqual({
        owner: false,
        write: false,
        download: true,
        read: true,
      });
    });

    it('picking Can read denies download for the group, by its bare token', async () => {
      await applySet(GTM, SET.read);

      expect(await effective(GTM)).toEqual({
        owner: false,
        write: false,
        download: false,
        read: true,
      });
      const md = await fs.readFile(path.join(repo, FOLDER, 'access.md'), 'utf-8');
      // A GROUP is a bare token; a `role/GTM Team` line would be a different
      // principal and would not restrict the group at all.
      expect(md).toContain('deny GTM Team');
      expect(md).not.toContain('deny role/GTM Team');
    });

    it('the view keys the group denial under `g:` and lists it as restricted here', async () => {
      await applySet(GTM, SET.read);
      const v = await view();

      expect(v.denials['g:gtm team']).toEqual({ download: [{ kind: 'direct' }] });
      expect(v.deniedHere.principals).toEqual([{ name: 'GTM Team', kind: 'group' }]);
      // Not under the ROLE namespace: a group and a same-named role are
      // different principals, and a row keyed `r:` would restrict the wrong one.
      expect(v.denials['r:gtm team']).toBeUndefined();
    });

    it('raising back to Can download lifts the group denial', async () => {
      await applySet(GTM, SET.read);
      await applySet(GTM, SET.download);

      expect(await effective(GTM)).toEqual({
        owner: false,
        write: false,
        download: true,
        read: true,
      });
      const v = await view();
      expect(v.denials['g:gtm team']).toBeUndefined();
      expect(v.sources['g:gtm team'].download).toEqual([{ kind: 'ancestor', path: PARENT_MD }]);
    });
  });

  // ── the local-grant case, where no denial is the right instrument ────────

  it('lowering a set granted ENTIRELY here revokes it, leaving no dead deny line', async () => {
    await write(repo, PARENT_MD, '---\nwrite:\n  - Admin\n---\n# Sales\n');
    await write(
      repo,
      `${FOLDER}/access.md`,
      '---\nowner:\n  - Alice <alice@example.com>\n---\n# Deals\n',
    );
    access.invalidate(WS);
    expect((await effective(ALICE)).owner).toBe(true);

    await applySet(ALICE, SET.read);

    expect(await effective(ALICE)).toEqual({
      owner: false,
      write: false,
      download: false,
      read: true,
    });
    const md = await fs.readFile(path.join(repo, FOLDER, 'access.md'), 'utf-8');
    // Nothing above named her, so removing the grant was enough — a `deny` here
    // would be an entry that explains nothing and has to be reasoned about later.
    expect(md).not.toContain('deny');
    expect(md).toContain('read:');
    const v = await view();
    expect(v.denials['u:alice@example.com']).toBeUndefined();
    expect(v.sources['u:alice@example.com'].read).toEqual([{ kind: 'direct' }]);
  });
});
