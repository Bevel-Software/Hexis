import type { Server as HttpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry, createManualRoutes } from '../../tool-registry/index.js';
import { createToolContextResolver } from '../tool-context.js';
import { createToolHandlerFactory } from '../tool-handler.js';
import { DocExtractService, SpillStore, ToolDescriptionNotes, WorkerDocumentExtractor } from '../../workspace/index.js';
import {
  InternalTokenService,
  RoutineWritePolicyService,
  VersionControlHooks,
  createToolAuthMiddleware,
  registerWorkspaceTools,
} from '../../../__tests__/tool-wiring.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

const WS = 'target-company-state';
let recorded: unknown[][] = [];
/** Workspace-relative targets the stub archive holds; each is offered to the tool's write guard. */
let archiveEntries: string[] = [];
/** The bytes an entry holds, offered to the guard with its target (a folder entry has none). */
let archiveContents = new Map<string, string>();

/**
 * This test's own workspace folder, made empty for each test: what the bot's
 * guard reads as each file's current state is exactly what a test put there.
 */
let workspaceDir = '';
/** The paths whose lock is held right now, and every landing with whether its lock was held. */
let heldLocks = new Set<string>();
let landings: { path: string; locked: boolean }[] = [];

const externalApiKeyService = { verifyAndLoadToken: async () => null } as never;
const authService = { getUserById: async (id: string) => ({ id, email: 'e@x', name: 'N' }) } as never;
const workspaceService = {
  getOrCreateForUser: async () => ({ id: WS }),
  getWorkspacePath: async () => workspaceDir,
  unzipFile: async (
    ws: string,
    p: string,
    d?: string,
    guardWrite?: (target: string, content?: Buffer) => Promise<void>,
    landEntry?: (target: string, content: Buffer, write: () => Promise<void>) => Promise<string | undefined>,
  ) => {
    recorded.push(['unzip', ws, p, d]);
    if (archiveEntries.length === 0) return { extracted: [p], skipped: [] };
    // Mirrors the real extraction: a guard refusal skips that entry with its
    // message, and a file that passed lands through `landEntry` (a refusal
    // it answers skips it too; a throw would fail the extraction).
    const extracted: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const target of archiveEntries) {
      try {
        const text = archiveContents.get(target);
        const bytes = text === undefined ? undefined : Buffer.from(text);
        await guardWrite?.(target, bytes);
        if (bytes !== undefined) {
          const write = async () => {
            landings.push({ path: target, locked: heldLocks.has(target) });
            await mkdir(path.dirname(path.join(workspaceDir, target)), { recursive: true });
            await writeFile(path.join(workspaceDir, target), bytes);
          };
          const refused = landEntry ? await landEntry(target, bytes, write) : (await write(), undefined);
          if (refused !== undefined) {
            skipped.push({ path: target, reason: refused });
            continue;
          }
        }
        extracted.push(target);
      } catch (err) {
        skipped.push({ path: target, reason: (err as Error).message });
      }
    }
    return { extracted, skipped };
  },
  readFile: async () => {
    throw new Error('no such file');
  },
} as never;
const versionControlService = {
  acquireLock: async (_w: string, _b: string, p: string) => {
    heldLocks.add(p);
    return { acquired: true, lock: {} };
  },
  releaseLock: async (_w: string, _b: string, p: string) => {
    heldLocks.delete(p);
    return null;
  },
  releaseLockNoCommit: async (_w: string, _b: string, p: string) => {
    heldLocks.delete(p);
  },
  releaseLockUntouched: async (_w: string, _b: string, p: string) => {
    heldLocks.delete(p);
  },
} as never;
const events = {} as never;
const accessControl = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
} as never;

const internalToken = new InternalTokenService({ secret: 's' });
let httpServer: HttpServer | undefined;

function resolverFor(opts: { isBot?: (email: string) => boolean }) {
  return createToolContextResolver({ authService, workspaceService, versionControlService, events, kbDirName: 'knowledge-base', ...(opts.isBot ? { isBot: opts.isBot } : {}), creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} } });
}

async function start(opts: { isBot?: (email: string) => boolean } = {}): Promise<string> {
  const registry = new ToolRegistry();
  const toolAuth = createToolAuthMiddleware(externalApiKeyService, internalToken);
  const resolve = resolverFor(opts);
  const th = createToolHandlerFactory(resolve);
  const router = express.Router();
  // NOTE (core split): this suite used to register the search, feedback and
  // kb (citation) tools alongside the workspace tools. Those registrations —
  // and their web_search / submit_feedback / cite_kb_node cases — moved to
  // the enterprise repo with their modules; core registers only core tools.
  registerWorkspaceTools(registry, router, toolAuth, th, new SpillStore('/tmp/bevel-test-spills'), new DocExtractService('/tmp/bevel-test-doc-extract', new WorkerDocumentExtractor()), accessControl, testKbContext(), {
    // No hook registered: the agent-access gate refuses nothing here.
    recoveryBotEmail: 'recovery-bot@bevel.local',
    hooks: new VersionControlHooks(),
    notes: new ToolDescriptionNotes(),
  }, new RoutineWritePolicyService(), {} as never /* sessionSink — start_session not exercised here */);
  router.use(createManualRoutes(registry, toolAuth));

  const app = express();
  app.use(express.json());
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

const tok = () => internalToken.mint({ userId: 'user-A' });
const post = (url: string, body: unknown = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok()}` }, body: JSON.stringify(body) });

beforeEach(async () => {
  recorded = [];
  archiveEntries = [];
  archiveContents = new Map();
  heldLocks = new Set();
  landings = [];
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), 'bevel-phase4-ws-'));
});
afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  await rm(workspaceDir, { recursive: true, force: true });
});

describe('Phase 4 tools (core subset)', () => {
  it('unzip calls workspaceService.unzipFile with the context workspace, on the repository path', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/unzip`, { path: 'a.zip', branch: WS });
    expect(res.status).toBe(200);
    // The archive is named without the clone-folder prefix; the normaliser
    // places it inside the checkout, and THAT is the path the service is given.
    expect(recorded).toContainEqual(['unzip', WS, 'knowledge-base/a.zip', undefined]);
  });

  it('unzip never extracts a roles.yaml — extraction bypasses the filesystem gate that checks it', async () => {
    archiveEntries = ['knowledge-base/KnowledgeBase/notes.md', 'knowledge-base/roles.yaml'];
    const base = await start();
    const res = await post(`${base}/api/agent/tools/unzip`, { path: 'knowledge-base/a.zip', branch: WS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: string[]; skipped: { path: string; reason: string }[] };
    expect(body.extracted).toEqual(['knowledge-base/KnowledgeBase/notes.md']);
    expect(body.skipped).toEqual([
      { path: 'knowledge-base/roles.yaml', reason: expect.stringContaining('roles.yaml is never extracted') },
    ]);
  });

  it("a bot's unzip extracts no access file and no file whose own access lines it would change: each entry takes the write tools' gate", async () => {
    archiveEntries = [
      'knowledge-base/KnowledgeBase/notes.md',
      'knowledge-base/KnowledgeBase/page.md',
      'knowledge-base/KnowledgeBase/access.md',
    ];
    archiveContents = new Map([
      ['knowledge-base/KnowledgeBase/notes.md', '# notes\n'],
      ['knowledge-base/KnowledgeBase/page.md', '---\nread:\n  - everyone\n---\n# page\n'],
      ['knowledge-base/KnowledgeBase/access.md', 'read:\n  - everyone\n'],
    ]);
    const base = await start({ isBot: () => true });
    const res = await post(`${base}/api/agent/tools/unzip`, { path: 'knowledge-base/a.zip', branch: WS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extracted: string[]; skipped: { path: string; reason: string }[] };
    expect(body.extracted).toEqual(['knowledge-base/KnowledgeBase/notes.md']);
    expect(body.skipped).toEqual([
      { path: 'knowledge-base/KnowledgeBase/page.md', reason: expect.stringContaining('A bot cannot change access') },
      { path: 'knowledge-base/KnowledgeBase/access.md', reason: expect.stringContaining('A bot cannot change access') },
    ]);
    // What did land, landed under its lock.
    expect(landings).toEqual([{ path: 'knowledge-base/KnowledgeBase/notes.md', locked: true }]);
    expect(heldLocks.size).toBe(0);
  });

  it("a bot's unzip over a page whose own access lines it would drop is skipped, judged against the page as it is on disk", async () => {
    await mkdir(path.join(workspaceDir, 'knowledge-base/KnowledgeBase'), { recursive: true });
    await writeFile(path.join(workspaceDir, 'knowledge-base/KnowledgeBase/page.md'), '---\nread:\n  - Eng\n---\n# page\n');
    archiveEntries = ['knowledge-base/KnowledgeBase/page.md'];
    archiveContents = new Map([['knowledge-base/KnowledgeBase/page.md', '# page, open to all now\n']]);
    const base = await start({ isBot: () => true });
    const body = (await (await post(`${base}/api/agent/tools/unzip`, { path: 'knowledge-base/a.zip', branch: WS })).json()) as {
      extracted: string[];
      skipped: { path: string; reason: string }[];
    };
    expect(body.extracted).toEqual([]);
    expect(body.skipped).toEqual([
      { path: 'knowledge-base/KnowledgeBase/page.md', reason: expect.stringContaining('A bot cannot change access') },
    ]);
    expect(await readFile(path.join(workspaceDir, 'knowledge-base/KnowledgeBase/page.md'), 'utf-8')).toContain('- Eng');
  });

  it("a bot's delete of an access file or of a page with its own access lines is refused through the resolved context; a person's is not judged by it", async () => {
    await mkdir(path.join(workspaceDir, 'knowledge-base/Team'), { recursive: true });
    await writeFile(path.join(workspaceDir, 'knowledge-base/Team/access.md'), 'read:\n  - Eng\n');
    await writeFile(path.join(workspaceDir, 'knowledge-base/Team/page.md'), '---\nread:\n  - Eng\n---\n# page\n');
    const auth = { userId: 'user-A', scope: 'write', source: 'internal' } as never;
    const asBot = await resolverFor({ isBot: () => true })(auth, new AbortController().signal);
    const botFs = await asBot.getFilesystem(WS);
    await expect(botFs.deleteFile('knowledge-base/Team/access.md')).rejects.toThrow(/A bot cannot change access/);
    await expect(botFs.deleteFile('knowledge-base/Team/page.md')).rejects.toThrow(/A bot cannot change access/);
    expect(await readFile(path.join(workspaceDir, 'knowledge-base/Team/access.md'), 'utf-8')).toBe('read:\n  - Eng\n');
    expect(await readFile(path.join(workspaceDir, 'knowledge-base/Team/page.md'), 'utf-8')).toContain('- Eng');

    const asPerson = await resolverFor({ isBot: () => false })(auth, new AbortController().signal);
    await (await asPerson.getFilesystem(WS)).deleteFile('knowledge-base/Team/page.md');
    await expect(readFile(path.join(workspaceDir, 'knowledge-base/Team/page.md'), 'utf-8')).rejects.toThrow();
  });

  it("a person's unzip extracts the same archive whole: the bot's guard is the bot's alone", async () => {
    archiveEntries = ['knowledge-base/KnowledgeBase/page.md'];
    archiveContents = new Map([['knowledge-base/KnowledgeBase/page.md', '---\nread:\n  - everyone\n---\n# page\n']]);
    const base = await start({ isBot: () => false });
    const body = (await (await post(`${base}/api/agent/tools/unzip`, { path: 'knowledge-base/a.zip', branch: WS })).json()) as {
      extracted: string[];
    };
    expect(body.extracted).toEqual(['knowledge-base/KnowledgeBase/page.md']);
  });

  it('the registered core tool appears in the internal manual', async () => {
    const base = await start();
    const m = (await (await fetch(`${base}/api/agent/internal/utcp`, { headers: { authorization: `Bearer ${tok()}` } })).json()) as { tools: { name: string }[] };
    const names = m.tools.map((t) => t.name);
    expect(names).toContain('unzip');
  });
});
