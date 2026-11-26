import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry, createManualRoutes } from '../../tool-registry/index.js';
import { createToolContextResolver } from '../tool-context.js';
import { createToolHandlerFactory } from '../tool-handler.js';
import {
  InternalTokenService,
  RoutineWritePolicyService,
  VersionControlHooks,
  createToolAuthMiddleware,
  registerWorkspaceTools,
} from '../../../__tests__/tool-wiring.js';
import { DocExtractService, SpillStore, ToolDescriptionNotes, WorkerDocumentExtractor } from '../../workspace/index.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

const WS = 'target-company-state';
let recorded: unknown[][] = [];
/** Workspace-relative targets the stub archive holds; each is offered to the tool's write guard. */
let archiveEntries: string[] = [];

const externalApiKeyService = { verifyAndLoadToken: async () => null } as never;
const authService = { getUserById: async (id: string) => ({ id, email: 'e@x', name: 'N' }) } as never;
const workspaceService = {
  getOrCreateForUser: async () => ({ id: WS }),
  getWorkspacePath: async () => '/tmp/ws',
  unzipFile: async (
    ws: string,
    p: string,
    d?: string,
    judge?: {
      entry(target: string, kind: 'file' | 'dir'): Promise<void>;
      skipped(target: string, name: string, why: unknown): Error | null;
    },
  ) => {
    recorded.push(['unzip', ws, p, d]);
    if (archiveEntries.length === 0) return { extracted: [p], skipped: [] };
    // Mirrors the real extraction: the judge's refusal skips that entry with
    // its message, unless the judge says the entry decides the whole archive.
    const extracted: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const target of archiveEntries) {
      try {
        await judge?.entry(target, 'file');
        extracted.push(target);
      } catch (err) {
        if ((err as { kind?: string }).kind === 'archive-refused') throw err;
        const whole = judge?.skipped(target, target, err);
        if (whole) throw whole;
        skipped.push({ path: target, reason: (err as Error).message });
      }
    }
    return { extracted, skipped };
  },
  readFile: async () => {
    throw new Error('no such file');
  },
} as never;
// The stub extraction above lands nothing, so no lock or commit is asked of it.
const versionControlService = {} as never;
const events = {} as never;
const accessControl = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
  // `unzip` asks the write rule at HEAD of each entry on this protected branch; no rules there means allow.
  canWriteBatchAtRef: async () => null,
} as never;

const internalToken = new InternalTokenService({ secret: 's' });
let httpServer: HttpServer | undefined;

async function start(): Promise<string> {
  const registry = new ToolRegistry();
  const toolAuth = createToolAuthMiddleware(externalApiKeyService, internalToken);
  const resolve = createToolContextResolver({ authService, workspaceService, versionControlService, events, kbDirName: 'knowledge-base', creatorAccess: { planForCreate: async () => null, grantInExtractedFile: async () => null, noteAccessFileWritten: () => {} } });
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

beforeEach(() => {
  recorded = [];
  archiveEntries = [];
});
afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
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

  it('unzip refuses an archive carrying a roles.yaml whole — extraction bypasses the filesystem gate that checks it', async () => {
    archiveEntries = ['knowledge-base/KnowledgeBase/notes.md', 'knowledge-base/roles.yaml'];
    const base = await start();
    const res = await post(`${base}/api/agent/tools/unzip`, { path: 'knowledge-base/a.zip', branch: WS });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; kind: string };
    expect(body.kind).toBe('archive-refused');
    expect(body.error).toBe(
      'roles.yaml never comes from an archive: edit the file itself, where the change is checked. Nothing in the archive was landed.',
    );
  });

  it('the registered core tool appears in the internal manual', async () => {
    const base = await start();
    const m = (await (await fetch(`${base}/api/agent/internal/utcp`, { headers: { authorization: `Bearer ${tok()}` } })).json()) as { tools: { name: string }[] };
    const names = m.tools.map((t) => t.name);
    expect(names).toContain('unzip');
  });
});
