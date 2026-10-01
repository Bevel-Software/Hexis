import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { IWorkflowService } from '@bevel-software/platform-shared';
import { NodeFs } from '../../kb-fs/node-fs.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { WorkflowEventBus } from '../../workflow/event-bus.js';
import type { AuthService } from '../../auth/auth.service.js';
import type { IAdminAccessService } from '../../admin/admin.interface.js';
import type { ICreatorAccess } from '../../access-model/creator.js';
import { createWorkspaceRoutes } from '../workspace.routes.js';
import { WorkspaceService } from '../workspace.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

/**
 * Nothing the platform accepts resolves outside the repository.
 *
 * The HTTP routes took paths relative to the WORKSPACE, so a caller who sent
 * `KnowledgeBase/Report.md` instead of `knowledge-base/KnowledgeBase/Report.md`
 * had its folder created or its file uploaded BESIDE the checkout — a location
 * git never sees, so the content was never committed, never pushed and never
 * shared. The access check on those routes had judged the path as if it were
 * inside the repository and approved it. This file is the routes' half of the
 * fix: every route normalises first, judges the normalised path, and writes it.
 *
 * Real disk, real WorkspaceService; only the lock service and the access rules
 * are stubbed, so nothing but the path rules can refuse.
 */

const KB = 'knowledge-base';
const USER = { id: 'user-1', email: 'alice@example.com', name: 'Alice' };

interface Harness {
  server: Server;
  baseUrl: string;
  root: string;
  workspaceId: string;
  workspaceDir: string;
  repoDir: string;
  /** Every repo-relative path the access rules were asked about. */
  asked: string[];
  /** Every path a lock was taken on — the path the write committed under. */
  locked: string[];
}

async function makeHarness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paths-inside-repo-'));
  const workspaceId = workspaceIdForBranch('feature-paths');
  const workspaceDir = path.join(root, workspaceId);
  // The inner `.git` lets the service accept the workspace without cloning.
  await fs.mkdir(path.join(workspaceDir, KB, '.git'), { recursive: true });
  const workspaceService = new WorkspaceService(root, 'https://example.invalid/kb.git', testKbContext({ kbDirName: KB }), new NodeFs());
  await workspaceService.getWorkspacePath(workspaceId);

  const asked: string[] = [];
  const accessControl = {
    canRead: async (_w: string, _e: string, p: string) => {
      asked.push(p);
      return true;
    },
    canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
    canDownload: async (_w: string, _e: string, p: string) => {
      asked.push(p);
      return true;
    },
  } as unknown as IAccessControl;

  const locked: string[] = [];
  const workflowService = {
    getLock: vi.fn(async () => null),
    acquireLock: vi.fn(async (_w: string, _b: string, p: string) => {
      locked.push(p);
      return { acquired: true, lock: {} as never };
    }),
    releaseLock: vi.fn(async () => undefined as never),
    releaseLockNoCommit: vi.fn(async () => undefined as never),
    releaseLockUntouched: vi.fn(async () => undefined as never),
  } as unknown as IWorkflowService;

  const stubCreatorAccess: ICreatorAccess = {
    planForCreate: async () => null,
    noteAccessFileWritten: () => {},
  } as unknown as ICreatorAccess;

  const app = express();
  app.use(express.json());
  app.use('/api', (req, _res, next) => {
    (req as unknown as { userId: string }).userId = USER.id;
    next();
  });
  app.use(
    '/api',
    createWorkspaceRoutes(
      workspaceService,
      { getUserById: vi.fn(async () => USER) } as unknown as AuthService,
      workflowService,
      { emit: vi.fn() } as unknown as WorkflowEventBus,
      accessControl,
      testKbContext({ kbDirName: KB }),
      stubCreatorAccess,
      { isAdmin: async () => false } as unknown as IAdminAccessService,
      new NodeFs(),
    ),
  );
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    root,
    workspaceId,
    workspaceDir,
    repoDir: path.join(workspaceDir, KB),
    asked,
    locked,
  };
}

let h: Harness | null = null;
afterEach(async () => {
  if (h) {
    // `close` waits for every connection to end, and global fetch parks each
    // response socket in its keep-alive pool — so without this the teardown
    // sits out the keep-alive timeout, once per test. Every fetch in a test
    // has resolved by now, so the idle sockets are the only ones left.
    h.server.closeIdleConnections();
    await new Promise<void>((resolve) => h!.server.close(() => resolve()));
    await fs.rm(h.root, { recursive: true, force: true });
  }
  h = null;
});

const q = (p: string) => encodeURIComponent(p);
const call = (method: string, route: string, body?: unknown) =>
  fetch(`${h!.baseUrl}/api/workspace/${h!.workspaceId}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** True when anything at all sits beside the checkout. */
async function besideCheckout(): Promise<string[]> {
  return (await fs.readdir(h!.workspaceDir)).filter((n) => n !== KB).sort();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** A zip holding `files`, written into the repository at `repoRelative`. */
async function seedZip(repoRelative: string, files: Record<string, string>): Promise<void> {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  const abs = path.join(h!.repoDir, repoRelative);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, zip.toBuffer());
}

describe('every workspace route places an unprefixed path inside the repository', () => {
  it('POST /directory — the folder of the core-staging report lands in the repository', async () => {
    h = await makeHarness();
    const res = await call('POST', '/directory', { path: 'KnowledgeBase/Reports' });
    expect(res.status).toBe(200);

    expect(await exists(path.join(h.repoDir, 'KnowledgeBase', 'Reports'))).toBe(true);
    expect(await besideCheckout()).toEqual([]);
    // The lock — and so the commit — is taken on the repository path.
    expect(h.locked).toEqual([`${KB}/KnowledgeBase/Reports/.gitkeep`]);
  });

  it('POST /upload — a file with no folder lands at the repository root, not beside it', async () => {
    h = await makeHarness();
    const res = await fetch(`${h.baseUrl}/api/workspace/${h.workspaceId}/upload?path=${q('TestDocx.docx')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('document bytes'),
    });
    expect(res.status).toBe(200);

    expect(await fs.readFile(path.join(h.repoDir, 'TestDocx.docx'), 'utf-8')).toBe('document bytes');
    expect(await besideCheckout()).toEqual([]);
    expect(h.locked).toEqual([`${KB}/TestDocx.docx`]);
  });

  it('PUT /file — an unprefixed save is written inside the repository', async () => {
    h = await makeHarness();
    const res = await call('PUT', `/file?path=${q('KnowledgeBase/Report.md')}`, { content: '# Report' });
    expect(res.status).toBe(200);

    expect(await fs.readFile(path.join(h.repoDir, 'KnowledgeBase', 'Report.md'), 'utf-8')).toBe('# Report');
    expect(await besideCheckout()).toEqual([]);
    expect(h.locked).toEqual([`${KB}/KnowledgeBase/Report.md`]);
  });

  it('GET /file and GET /file/raw — an unprefixed read is judged and served on the repository path', async () => {
    h = await makeHarness();
    await fs.writeFile(path.join(h.repoDir, 'Notes.md'), 'contents', 'utf-8');

    const read = await call('GET', `/file?path=${q('Notes.md')}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { content: string }).content).toBe('contents');

    const raw = await call('GET', `/file/raw?path=${q('Notes.md')}`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe('contents');

    // The read gate saw the REPO-relative path, not the workspace-relative one:
    // an unprefixed request used to be judged as this very path and then served
    // from beside the checkout.
    expect(h.asked).toEqual(['Notes.md', 'Notes.md']);
  });

  it('DELETE /file — an unprefixed delete removes the repository file', async () => {
    h = await makeHarness();
    await fs.writeFile(path.join(h.repoDir, 'Gone.md'), 'x', 'utf-8');

    const res = await call('DELETE', `/file?path=${q('Gone.md')}`);
    expect(res.status).toBe(200);
    expect(await exists(path.join(h.repoDir, 'Gone.md'))).toBe(false);
    expect(h.locked).toContain(`${KB}/Gone.md`);
  });

  it('PATCH /file — an unprefixed move renames inside the repository, and locks both repository paths', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'From'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'From', 'a.md'), 'a', 'utf-8');

    const res = await call('PATCH', '/file', { oldPath: 'From/a.md', newPath: 'To/a.md' });
    expect(res.status).toBe(200);

    expect(await fs.readFile(path.join(h.repoDir, 'To', 'a.md'), 'utf-8')).toBe('a');
    expect(await besideCheckout()).toEqual([]);
    expect(h.locked).toEqual(expect.arrayContaining([`${KB}/From/a.md`, `${KB}/To/a.md`]));
  });

  it('GET /folder/zip — an unprefixed folder is judged and zipped from inside the repository', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Sales'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Sales', 'deal.md'), 'deal', 'utf-8');

    const res = await call('GET', `/folder/zip?download=1&path=${q('Sales')}`);
    expect(res.status).toBe(200);
    const names = new AdmZip(Buffer.from(await res.arrayBuffer())).getEntries().map((e) => e.entryName);
    expect(names).toEqual(['Sales/deal.md']);
    expect(h.asked).toEqual(['Sales']);
  });

  it('POST /unzip — an unprefixed archive extracts beside itself INSIDE the repository', async () => {
    h = await makeHarness();
    await seedZip('drop.zip', { 'one.md': '1', 'two.md': '2' });

    const res = await call('POST', '/unzip', { path: 'drop.zip' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { destination: string; extracted: string[] };
    expect(body.destination).toBe(KB);
    expect(body.extracted.sort()).toEqual([`${KB}/one.md`, `${KB}/two.md`]);
    expect(await besideCheckout()).toEqual([]);
  });

  it('POST /unzip — an unprefixed destination is a repository folder', async () => {
    h = await makeHarness();
    await seedZip('drop.zip', { 'one.md': '1' });

    const res = await call('POST', '/unzip', { path: 'drop.zip', destination: 'Uploads/Batch' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { destination: string; extracted: string[] };
    expect(body.destination).toBe(`${KB}/Uploads/Batch`);
    expect(await exists(path.join(h.repoDir, 'Uploads', 'Batch', 'one.md'))).toBe(true);
    expect(await besideCheckout()).toEqual([]);
  });

  it('POST /flush — carries no path, so there is nothing to place', async () => {
    h = await makeHarness();
    expect((await call('POST', '/flush')).status).toBe(200);
  });
});

describe('the paths no spelling can rescue are refused, not written', () => {
  const REFUSED = ['../etc/hostname', 'KnowledgeBase\\x', '/tmp/x', 'KnowledgeBase/../../escape.md'];

  it('every write route refuses them, and leaves the workspace as it was', async () => {
    h = await makeHarness();
    for (const p of REFUSED) {
      expect((await call('PUT', `/file?path=${q(p)}`, { content: 'x' })).status, `PUT ${p}`).toBe(400);
      expect((await call('POST', '/directory', { path: p })).status, `directory ${p}`).toBe(400);
      expect((await call('DELETE', `/file?path=${q(p)}`)).status, `DELETE ${p}`).toBe(400);
      expect((await call('PATCH', '/file', { oldPath: p, newPath: `${KB}/x.md` })).status, `PATCH src ${p}`).toBe(400);
      expect((await call('PATCH', '/file', { oldPath: `${KB}/x.md`, newPath: p })).status, `PATCH dest ${p}`).toBe(400);
      expect((await call('POST', '/unzip', { path: p })).status, `unzip ${p}`).toBe(400);
      expect(
        (
          await fetch(`${h.baseUrl}/api/workspace/${h.workspaceId}/upload?path=${q(p)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: Buffer.from('x'),
          })
        ).status,
        `upload ${p}`,
      ).toBe(400);
    }
    // Not one of them reached the access rules, a lock, or the disk.
    expect(h.asked).toEqual([]);
    expect(h.locked).toEqual([]);
    expect(await besideCheckout()).toEqual([]);
    expect(await fs.readdir(h.repoDir)).toEqual(['.git']);
  });

  it('every read route refuses them with the same message', async () => {
    h = await makeHarness();
    for (const p of REFUSED) {
      for (const route of [`/file?path=${q(p)}`, `/file/raw?path=${q(p)}`, `/folder/zip?download=1&path=${q(p)}`]) {
        const res = await call('GET', route);
        expect(res.status, `${route}`).toBe(400);
        expect(((await res.json()) as { error: string }).error, route).toContain(
          'is outside the knowledge base repository',
        );
      }
    }
    expect(h.asked).toEqual([]);
  });

  it('a path that resolves outside the repository is caught after normalisation, not written', async () => {
    h = await makeHarness();
    // A link inside the repository pointing beside it. The path normalises into
    // the repository and its SPELLING is contained, so the lexical root check
    // passes it: what refuses it is the link guard, which resolves the way out.
    // Named precisely because the two checks are easy to confuse — the lexical
    // one is pinned structurally, in the drift guard at the foot of this file.
    const outside = path.join(h.workspaceDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    // A junction on Windows: an unprivileged `symlink` there raises EPERM, and
    // the traversal this pins has nothing to do with which kind of link it is.
    await fs.symlink(outside, path.join(h.repoDir, 'Escape'), process.platform === 'win32' ? 'junction' : 'dir');

    expect((await call('PUT', `/file?path=${q('Escape/x.md')}`, { content: 'x' })).status).toBe(403);
    expect((await call('GET', `/file?path=${q('Escape/x.md')}`)).status).toBe(403);
    expect(await fs.readdir(outside)).toEqual([]);
  });
});

describe('the checkout folder name is reserved at the repository root', () => {
  const reserved = `${KB}/${KB}`;

  it('cannot be created', async () => {
    h = await makeHarness();
    const res = await call('POST', '/directory', { path: reserved });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(`"${KB}" is reserved`);
    expect(error).toContain("it is the checkout folder's name");
    expect(await exists(path.join(h.repoDir, KB))).toBe(false);
  });

  it('cannot be moved to, nor renamed to', async () => {
    h = await makeHarness();
    await fs.mkdir(path.join(h.repoDir, 'Folder'), { recursive: true });
    await fs.writeFile(path.join(h.repoDir, 'Folder', 'a.md'), 'a', 'utf-8');
    await fs.writeFile(path.join(h.repoDir, 'loose.md'), 'l', 'utf-8');

    // A move of a folder ONTO the reserved name…
    const moved = await call('PATCH', '/file', { oldPath: 'Folder', newPath: reserved });
    expect(moved.status).toBe(400);
    expect(((await moved.json()) as { error: string }).error).toContain(`"${KB}" is reserved`);

    // …and a rename of a root file into a folder of that name.
    const renamed = await call('PATCH', '/file', { oldPath: 'loose.md', newPath: `${reserved}/loose.md` });
    expect(renamed.status).toBe(400);
    expect(((await renamed.json()) as { error: string }).error).toContain(`"${KB}" is reserved`);

    expect(await exists(path.join(h.repoDir, KB))).toBe(false);
    expect(await exists(path.join(h.repoDir, 'Folder', 'a.md'))).toBe(true);
    expect(await exists(path.join(h.repoDir, 'loose.md'))).toBe(true);
  });

  it('cannot be written into, or extracted into', async () => {
    h = await makeHarness();
    expect((await call('PUT', `/file?path=${q(`${reserved}/note.md`)}`, { content: 'x' })).status).toBe(400);
    await seedZip('drop.zip', { [`${KB}/sneaky.md`]: 'x', 'fine.md': 'ok' });

    const res = await call('POST', '/unzip', { path: `${KB}/drop.zip` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: string[]; skipped: { path: string; reason: string }[] };
    expect(body.extracted).toEqual([`${KB}/fine.md`]);
    expect(body.skipped.map((s) => s.reason).join(' ')).toContain(`"${KB}" is reserved`);
    expect(await exists(path.join(h.repoDir, KB))).toBe(false);
  });

  it('leaves a namesake deeper in the tree alone', async () => {
    h = await makeHarness();
    // Only the ROOT name is unreachable; `KnowledgeBase/knowledge-base` is an
    // ordinary folder with an ordinary path.
    const res = await call('POST', '/directory', { path: `KnowledgeBase/${KB}` });
    expect(res.status).toBe(200);
    expect(await exists(path.join(h.repoDir, 'KnowledgeBase', KB))).toBe(true);
  });
});

/**
 * The drift guard. Two inline spellings of "resolve a workspace path" is how
 * the routes and the tools came apart in the first place — nine
 * `path.resolve(workspaceDir, …)` calls in the service, none checking the
 * repository root, and a strip-if-present helper on the routes. Each file keeps
 * exactly one, inside the helper that also checks the root.
 */
describe('no code path outside the normaliser resolves a workspace path', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sources: [file: string, helper: string][] = [
    [path.join(here, '..', 'workspace.service.ts'), 'resolveInsideRepo'],
    [path.join(here, '..', 'workspace.routes.ts'), 'absoluteInRepo'],
  ];

  it.each(sources)('%s resolves a workspace path in one place only', async (file, helper) => {
    const text = await fs.readFile(file, 'utf-8');
    const lines = text.split('\n');
    // `path.resolve(<dir>, <relative>)` — the two-argument form that turns a
    // workspace path into a location. The one-argument `path.resolve(x)`
    // (canonicalising an absolute) is not a resolution of a relative path and
    // is deliberately not matched; neither is a COMMENT that quotes the shape,
    // which both files do when they explain why there is only one left.
    const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
    const hits = lines
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => !isComment(line) && /path\.resolve\(\s*(workspaceDir|wsDir|workspacesRoot)\s*,/.test(line));

    expect(hits.map((x) => `${path.basename(file)}:${x.n}`)).toHaveLength(1);
    // …and the one that is left is inside the designated helper.
    const helperAt = lines.findIndex((line) => line.includes(`${helper}(`));
    expect(helperAt, `${helper} not found in ${file}`).toBeGreaterThan(-1);
    const hit = hits[0].n - 1;
    expect(hit, `the resolution at line ${hits[0].n} is not inside ${helper}`).toBeGreaterThan(helperAt);
    expect(hit - helperAt).toBeLessThan(12);
    // …and the resolved path is checked against the repository root right
    // after it is resolved. This is where THAT check is pinned: normalisation
    // refuses every spelling that could lexically climb out, so no request can
    // reach the check with a path that fails it — deleting it would break no
    // other test, which is exactly why the guard has to say so here.
    expect(
      lines.slice(hit + 1, hit + 4).some((line) => line.includes('assertWithinDirectory(')),
      `the resolution at line ${hits[0].n} is not followed by the repository-root check`,
    ).toBe(true);
  });

  it('every write route passes its path through the normaliser before anything else', async () => {
    const text = await fs.readFile(path.join(here, '..', 'workspace.routes.ts'), 'utf-8');
    // One helper, and it is the normaliser's: a route that grew its own
    // strip-if-present reading of the prefix is what this forbids.
    expect(text).toContain("import { normalizeWorkspacePath } from '../kb-fs/repo-path.js'");
    expect(text.match(/normalizeWorkspacePath\(/g)).toHaveLength(1);
    // The old reading, spelled out so it cannot come back unnoticed.
    expect(text).not.toMatch(/startsWith\(`\$\{kbDirName\}\/`\)\s*\n?\s*\?/);
  });
});
