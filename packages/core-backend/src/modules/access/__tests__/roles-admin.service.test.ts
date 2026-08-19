import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { FileTreeEntry, WorkflowEventPayload } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { RolesAdminService } from '../roles-admin.service.js';
import { rewriteRoleTokensInText, findRoleRefsInText } from '../reference-scan.js';
import { PushNeedsAgentResolutionError } from '../../workflow/workflow.errors.js';
import type { AuthUser } from '@bevel-software/platform-shared';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';

const KB = 'knowledge-base';
const WS = workspaceIdForBranch(DEFAULT_BRANCH);

const ADMIN: AuthUser = { id: 'u-admin', email: 'razvan@bevel.software', name: 'Razvan' } as AuthUser;
const OTHER_ADMIN: AuthUser = { id: 'u-2', email: 'juan@bevel.software', name: 'Juan' } as AuthUser;

const ROLES = `roles:
  Admin:
    - razvan@bevel.software
    - juan@bevel.software
  Sales:
    - felix@example.com
`;

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-roles-'));
}

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

/** WorkspaceService stub backed by a real temp repo. */
function stubWorkspace(workspaceDir: string): WorkspaceService {
  const resolve = (wsRel: string) => path.join(workspaceDir, wsRel);
  // Mirror the real `listFiles`: a workspace-rooted tree (paths workspace-relative,
  // so KB files are `<KB>/...`), skipping `.git`. This is the candidate source the
  // rename's reference-rewrite walks. Tests that need an unreadable candidate
  // override this method to point at a missing path.
  const buildTree = async (absDir: string): Promise<FileTreeEntry> => {
    const rel = path.relative(workspaceDir, absDir).replace(/\\/g, '/');
    const children: FileTreeEntry[] = [];
    for (const e of await fs.readdir(absDir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const childAbs = path.join(absDir, e.name);
      if (e.isDirectory()) children.push(await buildTree(childAbs));
      else if (e.isFile()) {
        children.push({
          name: e.name,
          relativePath: path.relative(workspaceDir, childAbs).replace(/\\/g, '/'),
          type: 'file',
        });
      }
    }
    return { name: path.basename(absDir), relativePath: rel || '.', type: 'directory', children };
  };
  return {
    getWorkspacePath: async () => workspaceDir,
    getOrCreateForBranch: async () => ({}) as unknown,
    listFiles: async () => buildTree(workspaceDir),
    readFile: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel), 'utf-8'),
    writeFile: async (_id: string, wsRel: string, content: string) => {
      const abs = resolve(wsRel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf-8');
    },
  } as unknown as WorkspaceService;
}

/**
 * WorkflowService stub backed by the real temp repo. Models the two write paths
 * the service uses:
 *   - Single-file ops go through a real LockingFilesystem, which calls
 *     acquireLock → (LocalFilesystem writes to disk) → releaseLock. We track the
 *     lock holder so the service's getLock pre-check + the 409 contention test
 *     behave, and releaseLock just drops the row (the real disk write already
 *     happened via LocalFilesystem, so we don't re-write here).
 *   - Rename goes through LockingFilesystem.writeFiles → commitChanges, a real
 *     (non-deferred) atomic write straight to the repo. Records commits so tests
 *     can assert one-per-op.
 */
function stubWorkflow() {
  const commits: { summary: string }[] = [];
  const resets: string[] = [];
  /** Per-path lock rows with STRICT acquire — mirrors FileLockService: a
   *  live lock is contended EVEN FOR THE SAME USER (only expired rows are
   *  reclaimed), so a service nesting a second acquire under its own hold
   *  fails here exactly like production. */
  const locks = new Map<string, AuthUser>();
  const lockRow = (h: AuthUser) => ({ holderUserId: h.id, holderName: h.name });
  const svc = {
    getLock: async (_w: string, _b: string, p: string) => {
      const h = locks.get(p);
      return h ? lockRow(h) : null;
    },
    acquireLock: async (_w: string, _b: string, p: string, user: AuthUser) => {
      const h = locks.get(p);
      if (h) return { acquired: false, lock: lockRow(h) };
      locks.set(p, user);
      return { acquired: true, lock: lockRow(user) };
    },
    // LockingFilesystem's success path: the LocalFilesystem write already hit
    // disk, so releasing just drops the lock (the "commit" is a no-op in-memory).
    releaseLock: async (_w: string, _b: string, p: string) => {
      locks.delete(p);
    },
    releaseLockNoCommit: async (_w: string, _b: string, p: string) => {
      locks.delete(p);
    },
    // The rename's atomic batch flows through LockingFilesystem.writeFiles, which
    // writes every file to disk (real LocalFilesystem) then calls commitChanges
    // once to commit the dirty tree. The stub just records that a commit happened
    // (the bytes are already on disk via the write); tests verify content there.
    commitChanges: async (_ws: string, _user: AuthUser, summary: string) => {
      commits.push({ summary });
      return {} as unknown;
    },
    // Recovery resyncs with origin before writing. The stub has no real remote,
    // so this is a no-op — the recover tests assert on the on-disk result of the
    // subsequent write, which is unaffected.
    resetToRemote: async (_ws: string, branch: string) => {
      resets.push(branch);
    },
  } as unknown as WorkflowService;
  return { svc, commits, resets };
}

/** Event bus stub that records every emitted payload for assertions. */
function stubEventBus() {
  const events: WorkflowEventPayload[] = [];
  const bus = {
    emit: (payload: WorkflowEventPayload) => {
      events.push(payload);
      return {} as unknown;
    },
  } as unknown as WorkflowEventBus;
  return { bus, events };
}

describe('RolesAdminService', () => {
  let root: string;
  let repo: string;
  let access: AccessControlService;
  let ws: WorkspaceService;
  let workflow: ReturnType<typeof stubWorkflow>;
  let bus: ReturnType<typeof stubEventBus>;
  let svc: RolesAdminService;

  async function readRoles(): Promise<string> {
    return fs.readFile(path.join(repo, 'roles.yaml'), 'utf-8');
  }

  beforeEach(async () => {
    root = await mkTmpRoot();
    const workspaceDir = path.join(root, WS);
    repo = path.join(workspaceDir, KB);
    await write(repo, 'roles.yaml', ROLES);
    ws = stubWorkspace(workspaceDir);
    access = new AccessControlService(ws, KB);
    workflow = stubWorkflow();
    bus = stubEventBus();
    svc = new RolesAdminService(ws, workflow.svc, access, KB, () => DEFAULT_BRANCH, bus.bus, [
      'recovery-admin@example.com',
    ]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('getRoster lists roles, marks Admin, dedupes members', async () => {
    const roster = await svc.getRoster();
    expect(roster.map((r) => r.canonical)).toEqual(['admin', 'sales']);
    expect(roster.find((r) => r.canonical === 'admin')!.isAdmin).toBe(true);
    expect(roster.find((r) => r.canonical === 'sales')!.members).toEqual(['felix@example.com']);
  });

  it('resolves the default branch per call, not at construction', async () => {
    // The deployment shape this guards: a service built during boot, before
    // `configureBranchModel()` has applied the branch model, saw an empty
    // `DEFAULT_BRANCH` and froze it — every roles route then failed branch
    // validation with `Invalid branch name "": empty name` until a restart.
    let branch = '';
    const late = new RolesAdminService(ws, workflow.svc, access, KB, () => branch, bus.bus);
    branch = DEFAULT_BRANCH;
    const roster = await late.getRoster();
    expect(roster.map((r) => r.canonical)).toEqual(['admin', 'sales']);
  });

  it('getHealth reports ok for a valid file and corrupted for a broken one', async () => {
    expect(await svc.getHealth()).toEqual({ ok: true, errors: [] });

    // The exact failure mode from the bug report: a duplicate role key.
    await write(repo, 'roles.yaml', 'roles:\n  Admin:\n    - a@x.eu\n  Admin:\n    - b@x.eu\n');
    access.invalidate(WS);
    const health = await svc.getHealth();
    expect(health.ok).toBe(false);
    expect(health.errors.join(' ')).toMatch(/duplicate/i);
  });

  it('recover refuses (409) when roles.yaml is already valid', async () => {
    await expect(svc.recover(ADMIN)).rejects.toMatchObject({ status: 409, name: 'RolesAdminError' });
    // Nothing backed up.
    await expect(fs.readFile(path.join(repo, 'old-roles.yaml'), 'utf-8')).rejects.toThrow();
  });

  it('recover backs up the corrupted file and restores the working default', async () => {
    const corrupt = 'roles:\n  Admin:\n    - a@x.eu\n  Admin:\n    - b@x.eu\n';
    await write(repo, 'roles.yaml', corrupt);
    access.invalidate(WS);

    const roster = await svc.recover(ADMIN);

    // Recovery syncs the clone to origin's default branch BEFORE writing, so the
    // restoring commit fast-forwards on push instead of diverging.
    expect(workflow.resets).toEqual([DEFAULT_BRANCH]);
    // Corrupted bytes parked verbatim in old-roles.yaml.
    expect(await fs.readFile(path.join(repo, 'old-roles.yaml'), 'utf-8')).toBe(corrupt);
    // roles.yaml restored to a parseable default with an Admin role.
    const restored = await readRoles();
    expect(access.validateRolesYaml(restored).ok).toBe(true);
    expect(roster.find((r) => r.canonical === 'admin')?.isAdmin).toBe(true);
    // The roster is THIS deployment's configured admin — never a list baked
    // into the build (hard-coded emails would land one company's admins in
    // every customer's recovered file).
    expect(roster.find((r) => r.canonical === 'admin')!.members).toEqual([
      'recovery-admin@example.com',
    ]);
    expect(restored).not.toContain('bevel.software');
    // And the file is now healthy.
    expect(await svc.getHealth()).toEqual({ ok: true, errors: [] });
  });

  it('recover refuses when no admin is configured — an adminless roster is the disease, not the cure', async () => {
    const corrupt = 'roles:\n  Admin:\n    - a@x.eu\n  Admin:\n    - b@x.eu\n';
    await write(repo, 'roles.yaml', corrupt);
    access.invalidate(WS);
    const adminless = new RolesAdminService(ws, workflow.svc, access, KB, () => DEFAULT_BRANCH, bus.bus);
    await expect(adminless.recover(ADMIN)).rejects.toMatchObject({
      status: 500,
      payload: { kind: 'no-recovery-admins' },
    });
    // Nothing parked, nothing overwritten.
    await expect(fs.readFile(path.join(repo, 'old-roles.yaml'), 'utf-8')).rejects.toThrow();
    expect(await fs.readFile(path.join(repo, 'roles.yaml'), 'utf-8')).toBe(corrupt);
  });

  it("getRoster's referencedBy is sound — finds node-frontmatter refs, not just folder access.md", async () => {
    // A folder access.md grant (the only thing the old advisory scan saw)...
    await write(repo, 'team/access.md', '---\nread:\n  - Sales\n---\n');
    // ...AND a grant that lives ONLY in a node's own frontmatter (the gap).
    await write(repo, 'team/deal.md', '---\nowner: Sales\n---\n# Deal\n');

    const sales = (await svc.getRoster()).find((r) => r.canonical === 'sales')!;
    const paths = sales.referencedBy.map((r) => r.path).sort();
    expect(paths).toEqual(['team/access.md', 'team/deal.md']);
    // The frontmatter ref carries its verb, so the warning can name it.
    expect(sales.referencedBy).toContainEqual({ path: 'team/deal.md', verb: 'owner' });
    // An unreferenced role still shows nothing.
    expect((await svc.getRoster()).find((r) => r.canonical === 'admin')!.referencedBy).toEqual([]);
  });

  it('addMember persists + is idempotent', async () => {
    await svc.addMember(ADMIN, 'sales', 'New@example.com');
    expect(await readRoles()).toContain('new@example.com');
    const before = workflow.commits.length;
    await svc.addMember(ADMIN, 'sales', 'new@example.com'); // duplicate → no commit
    expect(workflow.commits.length).toBe(before);
  });

  it('removeMember refuses to empty the Admin role', async () => {
    await svc.removeMember(ADMIN, 'admin', 'juan@bevel.software', false);
    await expect(svc.removeMember(ADMIN, 'admin', 'razvan@bevel.software', false)).rejects.toMatchObject({
      status: 422,
    });
  });

  it('removeMember: own last Admin membership needs confirm (409), then succeeds', async () => {
    // Leave only razvan in Admin.
    await svc.removeMember(ADMIN, 'admin', 'juan@bevel.software', false);
    await expect(svc.removeMember(ADMIN, 'admin', 'razvan@bevel.software', false)).rejects.toMatchObject({
      status: 422, // last-member guard fires first
    });
    // A different admin removing themselves when others remain → needs confirm.
    await svc.addMember(ADMIN, 'admin', 'juan@bevel.software'); // re-add → 2 admins
    await expect(svc.removeMember(OTHER_ADMIN, 'admin', 'juan@bevel.software', false)).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'self-admin-removal' },
    });
    await svc.removeMember(OTHER_ADMIN, 'admin', 'juan@bevel.software', true); // confirmed
    expect(await readRoles()).not.toContain('juan@bevel.software');
  });

  it('role CRUD is GONE from the service — roles are app-defined capabilities', () => {
    // The editors were removed outright, not just un-routed: legacy roles stay
    // membership-editable, but nothing can mint/rename/delete a role anymore.
    const anySvc = svc as unknown as Record<string, unknown>;
    expect(anySvc.createRole).toBeUndefined();
    expect(anySvc.renameRole).toBeUndefined();
    expect(anySvc.deleteRole).toBeUndefined();
  });

  it("addMember refuses a 'group:'-prefixed member with an actionable message", async () => {
    await expect(svc.addMember(ADMIN, 'sales', 'group:lee@x.io')).rejects.toMatchObject({
      status: 422,
    });
    await expect(svc.addMember(ADMIN, 'sales', 'group:gtm team')).rejects.toThrow(/group assignment/);
    expect(await readRoles()).not.toContain('group:');
  });

  it('LOCKOUT-IMPOSSIBILITY: the validator rejects garbage in isolation', async () => {
    expect(access.validateRolesYaml('roles:\n  : []\n').ok).toBe(false);
    // Group-only Admin is garbage too — the kept invariant.
    expect(access.validateRolesYaml('roles:\n  Admin:\n    - group:ops\n').ok).toBe(false);
    // Happy path still keeps admins resolving (sanity baseline for the gate).
    await svc.addMember(ADMIN, 'sales', 'marketing@example.com');
    expect(await access.canWrite(WS, 'razvan@bevel.software', 'roles.yaml')).toBe(true);
  });

  it('LOCKOUT-IMPOSSIBILITY: a mutation whose candidate fails validation writes nothing', async () => {
    // Drive the 422-before-write guarantee through a REAL mutation, not a direct
    // validator call: force validateRolesYaml to fail for the candidate the
    // service is about to commit, then assert the op is refused with ZERO writes
    // — no commit, roles.yaml byte-for-byte unchanged, admin status intact. This
    // catches a regression that would write/commit before validating.
    const before = await readRoles();
    const commitsBefore = workflow.commits.length;
    const realValidate = access.validateRolesYaml.bind(access);
    access.validateRolesYaml = () => ({ ok: false, errors: ['forced parse failure'] });
    try {
      await expect(svc.addMember(ADMIN, 'sales', 'x@example.com')).rejects.toMatchObject({ status: 422 });
    } finally {
      access.validateRolesYaml = realValidate;
    }
    expect(workflow.commits.length).toBe(commitsBefore); // nothing committed
    expect(await readRoles()).toBe(before); // file untouched
    expect(await access.canWrite(WS, 'razvan@bevel.software', 'roles.yaml')).toBe(true);
  });

  it('a post-commit push failure does NOT revert the landed edit (saved; retried later)', async () => {
    // workflowService.commitChanges throwing PushNeedsAgentResolutionError
    // means the COMMIT landed and only the push needs help. The old twins
    // restored pre-edit bytes here — publishing a compensating revert of a
    // landed commit. The shared helper must keep the new bytes and surface
    // the typed 409 as-is.
    const failing = workflow.svc as unknown as {
      commitChanges: (...args: unknown[]) => Promise<unknown>;
    };
    const realCommit = failing.commitChanges.bind(workflow.svc);
    failing.commitChanges = async (...args: unknown[]) => {
      await realCommit(...args); // the commit records — it "landed"
      throw new PushNeedsAgentResolutionError(DEFAULT_BRANCH, 'roles.yaml', 'rejected', 'conflict');
    };
    await expect(svc.addMember(ADMIN, 'sales', 'pushed@example.com')).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'push-needs-resolution' },
    });
    // The edit SURVIVES on disk — no compensating restore of pre-edit bytes.
    expect(await readRoles()).toContain('pushed@example.com');
    // And the lock was released normally (a follow-up edit works).
    failing.commitChanges = realCommit;
    await svc.addMember(ADMIN, 'sales', 'after@example.com');
    expect(await readRoles()).toContain('after@example.com');
  });

  it('concurrent edit is serialized — a mutation 409s while another admin holds the lock', async () => {
    // Another admin is mid-edit (holds the roles.yaml lock). The getLock
    // pre-check sees a different holder and refuses with a friendly 409.
    await workflow.svc.acquireLock(WS, DEFAULT_BRANCH, `${KB}/roles.yaml`, OTHER_ADMIN);
    await expect(svc.addMember(ADMIN, 'sales', 'x@example.com')).rejects.toMatchObject({ status: 409 });
  });

  it('a single-file mutation emits file-changed for roles.yaml so clients re-check access', async () => {
    await svc.addMember(ADMIN, 'sales', 'new@example.com');
    const fileChanged = bus.events.filter((e) => e.kind === 'file-changed');
    // Workspace-relative path (kbDirName-prefixed) — the form the frontend
    // keys tabs on, not the bare repo-relative `roles.yaml`.
    expect(fileChanged.map((e) => (e as { path: string }).path)).toEqual([`${KB}/roles.yaml`]);
    expect(bus.events.some((e) => e.kind === 'fs-tree-changed')).toBe(true);
  });

  it('a no-op mutation emits nothing', async () => {
    await svc.addMember(ADMIN, 'sales', 'felix@example.com'); // already a member → no commit
    expect(bus.events).toHaveLength(0);
  });

});

describe('rewriteRoleTokensInText (reference-aware, frontmatter-only)', () => {
  it('rewrites only genuine role tokens in frontmatter, preserving deny + leaving non-matches alone', () => {
    const text = [
      '---',
      'write:',
      '  - Sales',
      '  - deny Sales',
      '  - Sales Person <sales@x.eu>', // user entry, NOT a role
      '  - Salesforce', // different role (substring)
      '---',
      '# Sales is mentioned in prose',
    ].join('\n');
    const out = rewriteRoleTokensInText(text, 'sales', 'Sales Team');
    expect(out).toContain('  - Sales Team');
    expect(out).toContain('  - deny Sales Team');
    expect(out).toContain('  - Sales Person <sales@x.eu>'); // untouched
    expect(out).toContain('  - Salesforce'); // untouched
    expect(out).toContain('# Sales is mentioned in prose'); // untouched
  });

  it('rewrites the scalar node-frontmatter form (`owner: Sales`)', () => {
    const text = '---\nowner: Sales\nwrite: deny Sales\ntitle: Sales\n---\n';
    const out = rewriteRoleTokensInText(text, 'sales', 'Sales Team');
    expect(out).toContain('owner: Sales Team');
    expect(out).toContain('write: deny Sales Team');
    expect(out).toContain('title: Sales'); // non-verb key untouched
  });

  it('NEVER rewrites the markdown body — only the frontmatter block (CodeRabbit)', () => {
    const text = [
      '---',
      'owner: Sales',
      '---',
      '# Notes',
      '- Sales', // a body bullet that LOOKS like a role list-item
      'owner: Sales is our top account', // body prose, not a config line
    ].join('\n');
    const out = rewriteRoleTokensInText(text, 'sales', 'Sales Team');
    const bodyLines = out.split('\n').slice(3); // everything after the closing ---
    expect(out).toContain('owner: Sales Team'); // frontmatter rewritten
    expect(bodyLines.join('\n')).toContain('- Sales'); // body bullet untouched
    expect(bodyLines.join('\n')).toContain('owner: Sales is our top account'); // body prose untouched
  });

  it('a .md file with no frontmatter fence is left entirely untouched', () => {
    const text = '# Doc\n- Sales\nowner: Sales\n';
    expect(rewriteRoleTokensInText(text, 'sales', 'Sales Team')).toBe(text);
  });

  it('a fence-less pure-config file (isMarkdown=false) rewrites the whole file', () => {
    const text = 'write:\n  - Sales\n';
    expect(rewriteRoleTokensInText(text, 'sales', 'Sales Team', false)).toContain('  - Sales Team');
  });

  it('returns the input unchanged when there is no matching role token', () => {
    const text = '---\nwrite:\n  - Engineering\n---\n';
    expect(rewriteRoleTokensInText(text, 'sales', 'Sales Team')).toBe(text);
  });
});

describe('rewriteRoleTokensInText — body-governed access.md (isAccessMd)', () => {
  it('rewrites BODY rules and frontmatter self-rules of a body-governed access.md', () => {
    const text = [
      '---',
      'write:',
      '  - Sales', // self-rule: who may edit access.md itself
      '---',
      'read:',
      '  - Sales', // the FOLDER rule the resolver enforces
      '  - deny Sales',
      'write:',
      '  - Admin',
    ].join('\n');
    const out = rewriteRoleTokensInText(text, 'sales', 'Sales Team', true, true);
    const lines = out.split('\n');
    expect(lines[2]).toBe('  - Sales Team'); // frontmatter self-rule
    expect(lines[5]).toBe('  - Sales Team'); // body rule
    expect(lines[6]).toBe('  - deny Sales Team'); // deny preserved in body
    expect(out).toContain('  - Admin'); // other roles untouched
  });

  it('a LEGACY access.md (prose body) keeps its body untouched even with isAccessMd', () => {
    const text = [
      '---',
      'read:',
      '  - Sales',
      '---',
      '# About this folder',
      '- Sales', // prose bullet, not a rule — the body does not parse as rules
    ].join('\n');
    const out = rewriteRoleTokensInText(text, 'sales', 'Sales Team', true, true);
    const lines = out.split('\n');
    expect(lines[2]).toBe('  - Sales Team'); // legacy frontmatter rules rewritten
    expect(lines[5]).toBe('- Sales'); // prose untouched
  });

  it('a fence-less access.md is untouched — the resolver hard-errors it, so it is no rule source', () => {
    const text = 'read:\n  - Sales\n';
    expect(rewriteRoleTokensInText(text, 'sales', 'Sales Team', true, true)).toBe(text);
  });

  it('findRoleRefsInText sees body rules of a body-governed access.md', () => {
    const text = ['---', 'write:', '  - Admin', '---', 'read:', '  - Sales'].join('\n');
    const refs = findRoleRefsInText(text, true, true);
    expect(refs).toContainEqual({ role: 'sales', verb: 'read' });
    expect(refs).toContainEqual({ role: 'admin', verb: 'write' });
    // Without the access.md flag the body stays invisible (node files, prose).
    expect(findRoleRefsInText(text, true, false)).not.toContainEqual({ role: 'sales', verb: 'read' });
  });
});

describe('findRoleRefsInText (sound reference scan — shared with the rewrite)', () => {
  it('reports every genuine role ref with its enclosing verb, ignoring users/prose', () => {
    const text = [
      '---',
      'read:',
      '  - Sales',
      '  - deny Engineering',
      '  - Sue <sue@x.eu>', // user, not a role
      'owner: Sales', // scalar form under its own verb
      'title: Sales', // non-verb key — not an access ref
      '---',
      '- Sales', // body — outside the config region
    ].join('\n');
    const refs = findRoleRefsInText(text);
    expect(refs).toEqual([
      { role: 'sales', verb: 'read' },
      { role: 'engineering', verb: 'read' },
      { role: 'sales', verb: 'owner' },
    ]);
  });

  it('a .md with no frontmatter fence has no references', () => {
    expect(findRoleRefsInText('# Doc\nread:\n  - Sales\n')).toEqual([]);
  });
});
