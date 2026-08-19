import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { IAccessControl, GrantSources } from '../access-control.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { Database } from '../../database/connection.js';
import { createAccessRoutes } from '../access.routes.js';

/**
 * HTTP-level contract tests for the revoke route's CLASSIFICATION + MODE logic —
 * the branching the mutation-layer tests can't reach: the `409 { kind:'inherited' }`
 * body, the 200-vs-409-vs-no-op fork, the ancestor-keyed 403 gate, and the
 * stale-ancestor TOCTOU abort. The resolver/mutation are stubbed so each test
 * pins exactly one route decision; the in-memory file store lets the real
 * `AccessMutationService` splice run end-to-end under the route's lock wrapper.
 */

const USER = { id: 'u-1', email: 'alice@bevel.software', name: 'Alice' };
const WS = 'alice/feature'; // a non-protected feature branch
const KB = 'knowledge-base';

interface Stubs {
  files: Map<string, string>;
  canWrite: ReturnType<typeof vi.fn>;
  grantSources: ReturnType<typeof vi.fn>;
  acquireLock: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
  releaseLockNoCommit: ReturnType<typeof vi.fn>;
}

interface Harness {
  server: Server;
  baseUrl: string;
  stubs: Stubs;
}

async function makeHarness(opts: {
  files?: Record<string, string>;
  /** canWrite(path) verdict — defaults to true (writable). */
  canWrite?: (repoRelPath: string) => boolean;
  /** grantSources verdict, by repo-relative target. */
  grantSources?: (repoRelTarget: string) => GrantSources;
  /**
   * Per-email effective-access override for `denyHere`'s post-write assert
   * (canRead/canWrite/canDownload/canOwner). Map an email → false to model a
   * deny that actually removed that principal's access; emails absent from the
   * map fall back to the defaults (read true, others false; canWrite via the
   * `canWrite` opt).
   */
  effectiveEmails?: Record<string, boolean>;
  /** Override the (otherwise-empty) eligibleWriters list so a principal shows as a row in resolvedView. */
  eligibleWriters?: { roles: string[]; users: { name: string; email: string }[] };
}): Promise<Harness> {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));

  // canWrite is consumed by BOTH the route's pre-lock gate (actor email) and
  // denyHere's post-write effectiveness assert (the denied principal's email).
  // `effectiveEmails` lets a test say "after the deny, THIS email no longer has
  // access" without disturbing the actor's gate verdict.
  const canWrite = vi.fn(async (_w: string, email: string, p: string) => {
    if (opts.effectiveEmails && email in opts.effectiveEmails) return opts.effectiveEmails[email];
    return opts.canWrite ? opts.canWrite(p) : true;
  });
  const grantSources = vi.fn(async (_w: string, _k: string, target: string) =>
    opts.grantSources ? opts.grantSources(target) : ({} as GrantSources),
  );
  const effEmail = (email: string, fallback: boolean) =>
    opts.effectiveEmails && email in opts.effectiveEmails ? opts.effectiveEmails[email] : fallback;

  const accessControl = {
    canWrite,
    grantSources,
    invalidate: vi.fn(),
    // The mutation service consults the merged principal index to decide
    // exact-vs-name token matching on revoke (group shadowing). No groups in
    // these fixtures → unshadowed (name-level) matching, the legacy behavior.
    kbPrincipals: vi.fn(async () => ({ roles: [], groups: [], people: [] })),
    // resolvedView() fans out to these after a successful mutation; harmless stubs.
    // canRead/canDownload/canOwner are ALSO consumed by denyHere's assert.
    canRead: vi.fn(async (_w: string, email: string) => effEmail(email, true)),
    canDownload: vi.fn(async (_w: string, email: string) => effEmail(email, false)),
    canOwner: vi.fn(async (_w: string, email: string) => effEmail(email, false)),
    eligibleWriters: vi.fn(async () => opts.eligibleWriters ?? { roles: [], users: [] }),
    eligibleReaders: vi.fn(async () => ({ restricted: true, roles: [], users: [] })),
    eligibleOwners: vi.fn(async () => ({ roles: [], users: [] })),
    eligibleDownloaders: vi.fn(async () => ({ roles: [], users: [] })),
  } as unknown as IAccessControl;

  const workspaceService = {
    getOrCreateForBranch: vi.fn(async () => ({ id: WS, name: WS, kbDirName: KB })),
    readFile: vi.fn(async (_id: string, wsRel: string) => {
      const v = files.get(wsRel);
      if (v === undefined) {
        const err = new Error(`ENOENT ${wsRel}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    }),
    writeFile: vi.fn(async (_id: string, wsRel: string, content: string) => {
      files.set(wsRel, content);
    }),
  } as unknown as WorkspaceService;

  const authService = { getUserById: vi.fn(async () => USER) } as unknown as AuthService;

  const acquireLock = vi.fn(async () => ({ acquired: true, lock: {} }));
  const releaseLock = vi.fn(async () => undefined);
  const releaseLockNoCommit = vi.fn(async () => undefined);
  const workflowService = {
    getLock: vi.fn(async () => null),
    acquireLock,
    releaseLock,
    releaseLockNoCommit,
  } as unknown as WorkflowService;

  const eventBus = { emit: vi.fn() } as unknown as WorkflowEventBus;
  const db = {} as unknown as Database;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use('/api', createAccessRoutes(accessControl, workspaceService, authService, workflowService, eventBus, db, KB));

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    stubs: { files, canWrite, grantSources, acquireLock, releaseLock, releaseLockNoCommit },
  };
}

function close(s: Server): Promise<void> {
  return new Promise((resolve, reject) => s.close((e) => (e ? reject(e) : resolve())));
}

const ALICE = { kind: 'user' as const, email: 'alice@bevel.software', displayName: 'Alice' };

describe('POST /access/revoke — route classification + modes', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    if (h) await close(h.server);
    h = null;
  });

  const revoke = (body: unknown) =>
    fetch(`${h!.baseUrl}/api/workspace/${encodeURIComponent(WS)}/access/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  describe('default mode — classify the revoke', () => {
    it('DIRECT grant → 200 with the fresh view (target edited)', async () => {
      h = await makeHarness({
        files: { [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Alice <alice@bevel.software>\n---\n' },
        grantSources: () => ({}), // after the splice removes her, no source remains
      });
      const res = await revoke({ path: `${KB}/Sales`, kind: 'folder', principal: ALICE });
      expect(res.status).toBe(200);
      // The entry was spliced out of the folder access.md.
      expect(h.stubs.files.get(`${KB}/Sales/access.md`)).not.toContain('alice@bevel.software');
      // The lock was acquired and released (committed), not released-no-commit.
      expect(h.stubs.releaseLock).toHaveBeenCalledOnce();
      expect(h.stubs.releaseLockNoCommit).not.toHaveBeenCalled();
    });

    it('DIRECT + still inherited → 200 strips the direct entry; the fresh view lists the principal with only the ancestor source', async () => {
      // The file names Alice directly (splice changes it → changed:true), but she
      // is ALSO inherited from Sales. After the direct entry is gone she still
      // resolves, so the fresh view's per-row sources show only the ancestor —
      // which is how the dialog chains into "Remove from parent?" (no special
      // response field; the richer per-verb sources subsume the old stillInherited).
      h = await makeHarness({
        files: {
          [`${KB}/Sales/Deal.md`]:
            '---\nnodeType: process\nwrite:\n  - Alice <alice@bevel.software>\n---\n# Deal\n',
        },
        // She remains an effective writer (via the ancestor) so she's still a row...
        eligibleWriters: { roles: [], users: [{ name: 'Alice', email: 'alice@bevel.software' }] },
        // ...and her per-row source is the remaining ancestor.
        grantSources: () => ({ write: [{ kind: 'ancestor', path: 'Sales/access.md' }] }),
      });
      const res = await revoke({ path: `${KB}/Sales/Deal.md`, kind: 'file', principal: ALICE });
      expect(res.status).toBe(200);
      const body = await res.json();
      // The direct entry was spliced out of the node frontmatter...
      expect(h.stubs.files.get(`${KB}/Sales/Deal.md`)).not.toContain('alice@bevel.software');
      // ...and the fresh view exposes her remaining ancestor source (drives the chain).
      expect(body.sources['u:alice@bevel.software'].write).toEqual([
        { kind: 'ancestor', path: 'Sales/access.md' },
      ]);
    });

    it('DIRECT + NOT otherwise inherited → 200; the principal no longer appears with any source', async () => {
      h = await makeHarness({
        files: { [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Alice <alice@bevel.software>\n---\n' },
        grantSources: () => ({}), // nothing left after the direct entry is removed
      });
      const res = await revoke({ path: `${KB}/Sales`, kind: 'folder', principal: ALICE });
      expect(res.status).toBe(200);
      // She's gone from the eligible lists (stubbed empty) so there's no row/source.
      expect((await res.json()).sources['u:alice@bevel.software']).toBeUndefined();
    });

    it('INHERITED from a file ancestor → 409 { kind: "inherited", sources } and the target is untouched', async () => {
      // The file target names no one; Alice resolves via Sales/access.md.
      h = await makeHarness({
        files: { [`${KB}/Sales/Deal.md`]: '---\nnodeType: process\n---\n# Deal\n' },
        grantSources: () => ({ write: [{ kind: 'ancestor', path: 'Sales/access.md' }] }),
      });
      const res = await revoke({ path: `${KB}/Sales/Deal.md`, kind: 'file', principal: ALICE });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.kind).toBe('inherited');
      expect(body.sources.write).toEqual([{ kind: 'ancestor', path: 'Sales/access.md' }]);
      // The target node frontmatter is unchanged (no deny written).
      expect(h.stubs.files.get(`${KB}/Sales/Deal.md`)).toBe('---\nnodeType: process\n---\n# Deal\n');
    });

    it('VERB-SPECIFIC revoke of an INHERITED verb → 409 inherited (unchecking "Can edit" on a direct-download row)', async () => {
      // The exact share-dialog case: the principal is direct on `download` (on the
      // file) but inherits `write` from the parent. Unchecking "Can edit" sends a
      // single-verb revoke of `write` — which finds nothing on the file to splice
      // (changed:false) but still resolves via the ancestor → 409 inherited. The
      // dialog converts this 409 into the "Remove from parent?" flow.
      h = await makeHarness({
        files: {
          [`${KB}/Sales/Deal.md`]:
            '---\nnodeType: process\ndownload:\n  - Alice <alice@bevel.software>\n---\n# Deal\n',
        },
        grantSources: () => ({ write: [{ kind: 'ancestor', path: 'Sales/access.md' }] }),
      });
      const res = await revoke({
        path: `${KB}/Sales/Deal.md`,
        kind: 'file',
        principal: ALICE,
        verb: 'write', // ← the single inherited verb being unchecked
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.kind).toBe('inherited');
      expect(body.sources.write).toEqual([{ kind: 'ancestor', path: 'Sales/access.md' }]);
      // The direct download entry is untouched — only `write` was targeted.
      expect(h.stubs.files.get(`${KB}/Sales/Deal.md`)).toContain('download:');
      expect(h.stubs.files.get(`${KB}/Sales/Deal.md`)).toContain('alice@bevel.software');
    });

    it('NO removable source (resolves only via a group/everyone/rescue) → 200 no-op, NOT a 409', async () => {
      // grantSources is empty (a group/everyone/rescue grant is not a per-user
      // file source), and the target splice no-ops. The route must 200, never 409.
      h = await makeHarness({
        files: { [`${KB}/Sales/Deal.md`]: '---\nnodeType: process\n---\n# Deal\n' },
        grantSources: () => ({}),
      });
      const res = await revoke({ path: `${KB}/Sales/Deal.md`, kind: 'file', principal: ALICE });
      expect(res.status).toBe(200);
      expect(h.stubs.files.get(`${KB}/Sales/Deal.md`)).toBe('---\nnodeType: process\n---\n# Deal\n');
    });

    it('NO effective access anywhere → 200 no-op', async () => {
      h = await makeHarness({
        files: { [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Admin\n---\n' },
        grantSources: () => ({}),
      });
      const res = await revoke({ path: `${KB}/Sales`, kind: 'folder', principal: ALICE });
      expect(res.status).toBe(200);
      expect(h.stubs.files.get(`${KB}/Sales/access.md`)).toContain('Admin'); // untouched
    });

    it('refuses 403 when the caller cannot write the target access config', async () => {
      h = await makeHarness({
        files: { [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Alice <alice@bevel.software>\n---\n' },
        canWrite: () => false,
      });
      const res = await revoke({ path: `${KB}/Sales`, kind: 'folder', principal: ALICE });
      expect(res.status).toBe(403);
      // No lock acquired — the gate is BEFORE the lock.
      expect(h.stubs.acquireLock).not.toHaveBeenCalled();
    });
  });

  describe('mode: remove-from-parent', () => {
    it('gates 403 on the ANCESTOR, not the target (write-target-but-not-ancestor is refused)', async () => {
      // Caller can write the target folder but NOT the ancestor access.md.
      h = await makeHarness({
        files: { [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Alice <alice@bevel.software>\n---\n' },
        canWrite: (p) => p !== 'Sales/access.md', // ancestor gate fails
      });
      const res = await revoke({
        path: `${KB}/Sales/Deal.md`,
        kind: 'file',
        principal: ALICE,
        mode: 'remove-from-parent',
        ancestor: 'Sales',
      });
      expect(res.status).toBe(403);
      // The ancestor access.md was never edited.
      expect(h.stubs.files.get(`${KB}/Sales/access.md`)).toContain('alice@bevel.software');
      expect(h.stubs.acquireLock).not.toHaveBeenCalled();
    });

    it('TOCTOU: aborts 409 stale-ancestor when the principal is no longer inherited from the named ancestor', async () => {
      // The chain changed since the 409 — grantSources no longer reports this
      // ancestor. The route must abort under the lock with kind:'stale-ancestor'
      // and leave the ancestor untouched.
      h = await makeHarness({
        files: { [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Admin\n---\n' },
        grantSources: () => ({}), // not inherited from Sales anymore
      });
      const res = await revoke({
        path: `${KB}/Sales/Deal.md`,
        kind: 'file',
        principal: ALICE,
        mode: 'remove-from-parent',
        ancestor: 'Sales',
      });
      expect(res.status).toBe(409);
      expect((await res.json()).kind).toBe('stale-ancestor');
      // Lock acquired (the re-check is under the lock) then released WITHOUT commit.
      expect(h.stubs.acquireLock).toHaveBeenCalledOnce();
      expect(h.stubs.releaseLockNoCommit).toHaveBeenCalledOnce();
      expect(h.stubs.releaseLock).not.toHaveBeenCalled();
      expect(h.stubs.files.get(`${KB}/Sales/access.md`)).toContain('Admin'); // untouched
    });

    it('still-inherited → revokes on the ancestor access.md and 200s', async () => {
      h = await makeHarness({
        files: { [`${KB}/Sales/access.md`]: '---\nwrite:\n  - Alice <alice@bevel.software>\n---\n' },
        grantSources: () => ({ write: [{ kind: 'ancestor', path: 'Sales/access.md' }] }),
      });
      const res = await revoke({
        path: `${KB}/Sales/Deal.md`,
        kind: 'file',
        principal: ALICE,
        mode: 'remove-from-parent',
        ancestor: 'Sales',
      });
      expect(res.status).toBe(200);
      // Alice was spliced out of the ANCESTOR access.md.
      expect(h.stubs.files.get(`${KB}/Sales/access.md`)).not.toContain('alice@bevel.software');
      expect(h.stubs.releaseLock).toHaveBeenCalledOnce();
    });

    it('requires an ancestor in the body', async () => {
      h = await makeHarness({ files: {} });
      const res = await revoke({
        path: `${KB}/Sales/Deal.md`,
        kind: 'file',
        principal: ALICE,
        mode: 'remove-from-parent',
      });
      expect(res.status).toBe(400);
    });
  });

  describe('mode: deny-here', () => {
    const BOB = { kind: 'user' as const, email: 'bob@bevel.software', displayName: 'Bob' };

    it('writes a deny at the target and 200s when the deny removes effective access', async () => {
      // Alice (the actor) can write the target; Bob inherits write from a folder.
      // Deny Bob on the file. denyHere's post-write assert sees Bob no longer has
      // effective access (effectiveEmails), so it commits — 200.
      h = await makeHarness({
        files: { [`${KB}/Sales/Deal.md`]: '---\nnodeType: process\n---\n# Deal\n' },
        effectiveEmails: { 'bob@bevel.software': false },
      });
      const res = await revoke({
        path: `${KB}/Sales/Deal.md`,
        kind: 'file',
        principal: BOB,
        mode: 'deny-here',
      });
      expect(res.status).toBe(200);
      // A deny entry was written into the node's own frontmatter.
      expect(h.stubs.files.get(`${KB}/Sales/Deal.md`)).toContain('deny Bob <bob@bevel.software>');
      expect(h.stubs.releaseLock).toHaveBeenCalledOnce();
    });

    it('rolls back + 409 deny-ineffective when the deny does NOT remove access (e.g. admin-rescue)', async () => {
      // Bob still has effective access after the deny (effectiveEmails true) —
      // denyHere must roll the file back and surface kind:'deny-ineffective'.
      const original = '---\nnodeType: process\n---\n# Deal\n';
      h = await makeHarness({
        files: { [`${KB}/Sales/Deal.md`]: original },
        effectiveEmails: { 'bob@bevel.software': true },
      });
      const res = await revoke({
        path: `${KB}/Sales/Deal.md`,
        kind: 'file',
        principal: BOB,
        mode: 'deny-here',
      });
      expect(res.status).toBe(409);
      expect((await res.json()).kind).toBe('deny-ineffective');
      // Rolled back to the original bytes (no lingering deny entry).
      expect(h.stubs.files.get(`${KB}/Sales/Deal.md`)).toBe(original);
    });
  });
});
