import type { Server as HttpServer } from 'node:http';
import nodeFs, { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { ToolRegistry } from '../../tool-registry/index.js';
import type { ToolContext } from '../../tool-helpers/index.js';
import type { ToolAuth } from '../../tool-auth/index.js';
import {
  createToolHandlerFactory,
  registerWorkspaceTools,
  RoutineWritePolicyService,
  VersionControlHooks,
} from '../../../__tests__/tool-wiring.js';
import { realAccessControl } from '../../../__tests__/real-access.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { ToolDescriptionNotes } from '../agent-access.gate.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { WorkerDocumentExtractor } from '../file-readers/extract-in-worker.js';
import { personalAccessMd } from '../../plugins/index.js';
import type { WorkspaceService } from '../index.js';

/**
 * `list_files` on someone else's personal shelf, over the REAL resolver and
 * the access.md the provisioning service seeds: the shelf is not listed under
 * `Plugins/`, and every path in it answers exactly as a missing path does —
 * in both directions (an Admin against a Business user, and back), while the
 * owner still lists their own.
 */

const KB = 'knowledge-base';
const ADMIN = { name: 'Ada Admin', email: 'admin@x.io' };
const BIZ = { name: 'Bea Business', email: 'biz@x.io' };

const TREE: Record<string, string> = {
  'roles.yaml': `roles:\n  Admin:\n    - ${ADMIN.email}\n`,
  'access.md': '---\nread:\n  - everyone\nwrite:\n  - Admin\n---\n',
  'Plugins/GTM/skills/shared-skill/SKILL.md': '---\nname: shared-skill\n---\n',
  // An ordinary plugin nobody but Admin reads: outside a personal shelf a
  // folder is still listed, as before.
  'Plugins/Locked/access.md': '---\nread:\n  - deny everyone\n  - Admin\n---\n',
  'Plugins/Locked/skills/locked-skill/SKILL.md': '---\nname: locked-skill\n---\n',
  'Plugins/personal-biz/access.md': personalAccessMd(BIZ),
  'Plugins/personal-biz/skills/weekly-summary/SKILL.md': '---\nname: weekly-summary\n---\n',
  'Plugins/personal-adm/access.md': personalAccessMd(ADMIN),
  'Plugins/personal-adm/skills/admin-standup/SKILL.md': '---\nname: admin-standup\n---\n',
};

let root = '';
let docCache = '';
let base = '';
let server: HttpServer;
let caller = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'list-files-shelf-'));
  for (const [rel, text] of Object.entries(TREE)) {
    const abs = join(root, KB, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
  const workspaceService = { getWorkspacePath: async () => root, ensureRemotesFetched: async () => undefined } as unknown as WorkspaceService;
  const access = realAccessControl(workspaceService, KB, realDisk());
  // The disk as a case-insensitive one serves it: a folder named in another
  // casing opens the folder that is there (`plugins/` opens `Plugins/`), as on
  // macOS or Windows, so the alternate spelling reaches the listing.
  const disk = new LocalFilesystem({ basePath: root, contained: true });
  const opened = async (path: string): Promise<string> => {
    const out: string[] = [];
    for (const segment of path.split('/').filter(Boolean)) {
      const entries = await readdir(join(root, ...out)).catch(() => [] as string[]);
      out.push(entries.find((n) => n.toLowerCase() === segment.toLowerCase()) ?? segment);
    }
    return out.join('/') || '.';
  };
  const fs = new Proxy(disk, {
    get: (target, key) =>
      key === 'readdir'
        ? async (path: string, ...rest: unknown[]) =>
            (target.readdir as (...a: unknown[]) => Promise<unknown>).call(target, await opened(path), ...rest)
        : Reflect.get(target, key, target),
  });
  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: { id: caller, email: caller, name: caller },
    scope: auth.scope,
    source: auth.source,
    sessionId,
    abortSignal: signal,
    workspaceService: workspaceService as never,
    versionControlService: {} as never,
    events: {} as never,
    getFilesystem: async () => fs,
  });
  const app = express();
  app.use(express.json());
  const router = express.Router();
  docCache = await mkdtemp(join(tmpdir(), 'list-files-shelf-doc-'));
  registerWorkspaceTools(
    new ToolRegistry(),
    router,
    (req, _res, next) => {
      req.toolAuth = { source: 'internal', userId: caller, scope: 'read' };
      next();
    },
    createToolHandlerFactory(resolve),
    new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    new DocExtractService(docCache, new WorkerDocumentExtractor()),
    access,
    testKbContext({ kbDirName: KB }),
    { recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new VersionControlHooks(), notes: new ToolDescriptionNotes() },
    new RoutineWritePolicyService(),
    {} as never,
  );
  app.use('/api', router);
  server = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
  await rm(docCache, { recursive: true, force: true });
});

/** `list_files` as `as`: the status and the body, with `path` spelled `<path>` so two answers compare. */
async function list(as: string, path: string): Promise<{ status: number; body: string }> {
  caller = as;
  const res = await fetch(`${base}/api/agent/tools/list_files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    body: JSON.stringify({ branch: 'main', path: `${KB}/${path}` }),
  });
  return { status: res.status, body: (await res.text()).replaceAll(`${KB}/${path}`, '<path>') };
}

async function names(as: string, path: string): Promise<string[]> {
  const res = await list(as, path);
  expect(res.status, `${as} lists ${path}`).toBe(200);
  return (JSON.parse(res.body) as { entries: { name: string }[] }).entries.map((e) => e.name).sort();
}

describe("list_files on another person's personal shelf", () => {
  const cases = [
    { who: 'the Admin', as: ADMIN.email, own: 'personal-adm', ownSkill: 'admin-standup', other: 'personal-biz', otherSkill: 'weekly-summary' },
    { who: 'the Business user', as: BIZ.email, own: 'personal-biz', ownSkill: 'weekly-summary', other: 'personal-adm', otherSkill: 'admin-standup' },
  ];

  for (const c of cases) {
    it(`${c.who} does not see the other shelf under Plugins/, only their own`, async () => {
      const listed = await names(c.as, 'Plugins');
      expect(listed).toContain(c.own);
      expect(listed).not.toContain(c.other);
      // Ordinary plugins are listed as before, the denied one included.
      expect(listed).toEqual(expect.arrayContaining(['GTM', 'Locked']));
    });

    it(`${c.who} gets the missing-path answer for every path in the other shelf`, async () => {
      const missing = await list(c.as, 'Plugins/GTM/no-such-folder');
      expect(missing.status).toBe(404);
      for (const path of [
        `Plugins/${c.other}`,
        `Plugins/${c.other}/skills`,
        `Plugins/${c.other}/skills/${c.otherSkill}`,
        `Plugins/${c.other}/skills/${c.otherSkill}/SKILL.md`,
        `Plugins/${c.other}/skills/never-written`,
      ]) {
        expect(await list(c.as, path), path).toEqual(missing);
      }
    });

    it(`${c.who} gets that answer without any folder in the other shelf being read`, async () => {
      // The gate stands before the disk: no folder inside the shelf is read on
      // the way to the path, so nothing in it shapes the answer or its time.
      const shelf = join(root, KB, 'Plugins', c.other).toLowerCase();
      const spy = vi.spyOn(nodeFs, 'readdir');
      try {
        for (const path of [`Plugins/${c.other}/skills/${c.otherSkill}`, `plugins/${c.other.toUpperCase()}/skills`]) {
          expect((await list(c.as, path)).status, path).toBe(404);
        }
        const read = spy.mock.calls.map(([dir]) => String(dir).toLowerCase());
        expect(read.length).toBeGreaterThan(0);
        expect(read.filter((dir) => dir === shelf || dir.startsWith(`${shelf}/`))).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it(`${c.who} does not see the other shelf under an alternate casing of Plugins/ either`, async () => {
      const listed = await names(c.as, 'plugins');
      expect(listed).toContain(c.own);
      expect(listed).not.toContain(c.other);
    });

    it(`${c.who} cannot reach the other shelf through a dot-segment: refused as any such path is`, async () => {
      // The refusal comes before any disk read; its suggested path is the
      // caller's own input with the climb collapsed, so it tells nothing.
      for (const path of [`Plugins/GTM/../${c.other}`, `Plugins/GTM/../${c.other}/skills`]) {
        const res = await list(c.as, path);
        expect(res.status, path).toBe(400);
        expect(JSON.parse(res.body), path).toMatchObject({ kind: 'path-outside-repo' });
        expect(res.body, path).not.toContain(c.otherSkill);
      }
    });

    it(`${c.who} still lists everything in their own shelf`, async () => {
      expect(await names(c.as, `Plugins/${c.own}/skills`)).toEqual([c.ownSkill]);
      expect(await names(c.as, `Plugins/${c.own}/skills/${c.ownSkill}`)).toEqual(['SKILL.md']);
    });
  }
});
