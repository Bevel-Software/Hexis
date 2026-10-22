import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { ToolRegistry } from '../../modules/tool-registry/tool-registry.js';
import { createManualRoutes } from '../../modules/tool-registry/manual.routes.js';
import { createToolHandlerFactory } from '../../modules/tool-helpers/tool-handler.js';
import type { ToolContext } from '../../modules/tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../modules/tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../../modules/workspace/workspace.tools.js';
import { RoutineWritePolicyService } from '../../modules/workspace/routine-write-policy.js';
import { WorkflowHooks } from '../../modules/workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../../modules/workspace/agent-access.gate.js';
import { SpillStore } from '../../modules/workspace/spill-store.js';
import { RipgrepPatternMatcher } from '../../modules/workspace/index.js';
import { DocExtractService, type UnreadableDocument } from '../../modules/workspace/file-readers/doc-extract.service.js';
import type { IDocumentExtractor } from '../../modules/workspace/file-readers/document-extractor.contract.js';
import { WorkerDocumentExtractor, type WorkerDocumentExtractorOptions } from '../../modules/workspace/file-readers/extract-in-worker.js';
import type { IAccessControl } from '../../modules/access/access-control.interface.js';
import { createMcpRoutes } from '../../modules/mcp/mcp.routes.js';
import { McpService } from '../../modules/mcp/mcp.service.js';
import { testKbContext } from '../../__tests__/kb-context.js';
import { xrefPdf } from '../../modules/workspace/file-readers/__tests__/fixtures/damaged-pdf.js';

/**
 * A damaged document, on every surface that extracts: `read_file`, `grep`,
 * `file_stat` and `call_tool_chain` answer it with the same one-line notice,
 * extract it once, never again for the same bytes, and the server keeps
 * answering its health route throughout. The fixture is a synthetic PDF with
 * a damaged cross-reference table (`fixtures/damaged-pdf.ts`).
 *
 * It lives with the composition root's tests because it composes the server
 * across modules — the tool registry, the tool handler, the MCP proxy — as
 * `create-core-server.ts` does.
 */

const KB = 'knowledge-base';
const BRANCH = 'main';
const BEARER = 'bevel_key_user_a';
const DAMAGED = `${KB}/Legal/Supplier-Agreement.pdf`;
const PDFJS_SAYS = "could not extract the PDF's text (Bad (uncompressed) XRef entry: 4R)";
const NOTICE = `[${DAMAGED} ${PDFJS_SAYS} — the file may be corrupt or mislabeled. To fix it, replace the document by uploading a new version.]`;

const fakeAuth: RequestHandler = (req, _res, next) => {
  req.toolAuth = { source: 'internal', userId: 'u', scope: 'write' };
  req.userId = 'u';
  req.externalApiKeyId = 'tok-a';
  next();
};
const passthrough: RequestHandler = (_req, _res, next) => next();

interface Platform {
  baseUrl: string;
  /** Extractions the worker was actually asked for. */
  extractions(): number;
  /** Fresh failures the service reported. */
  told: UnreadableDocument[];
  write(path: string, bytes: Buffer | string): Promise<void>;
  stop(): Promise<void>;
}

const running: Platform[] = [];
afterEach(async () => {
  for (const p of running.splice(0)) await p.stop().catch(() => {});
});

async function startPlatform(extractorOpts: WorkerDocumentExtractorOptions = {}): Promise<Platform> {
  const tempDir = await mkdtemp(join(tmpdir(), 'damaged-doc-'));
  const fs = new LocalFilesystem({ basePath: tempDir, contained: true });
  const worker = new WorkerDocumentExtractor(extractorOpts);
  let extractions = 0;
  const counting: IDocumentExtractor = {
    extract: (ext, bytes) => {
      extractions++;
      return worker.extract(ext, bytes);
    },
    close: () => worker.close(),
  };
  const told: UnreadableDocument[] = [];
  const docExtract = new DocExtractService(join(tempDir, '.doc-extract'), counting, { onUnreadable: (d) => told.push(d) });
  const matcher = new RipgrepPatternMatcher();

  const registry = new ToolRegistry();
  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: { id: 'u', email: 'e@x', name: 'N' },
    scope: auth.scope,
    source: auth.source,
    sessionId,
    abortSignal: signal,
    workspaceService: { getWorkspacePath: async () => tempDir } as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => fs,
  });
  // Everyone may do everything: what this suite is about is extraction, not access.
  const allowAll = new Proxy(
    {},
    {
      get: (_target, verb) =>
        typeof verb === 'string' && verb.endsWith('Batch')
          ? async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true]))
          : async () => true,
    },
  ) as IAccessControl;

  const app = express();
  app.use(express.json());
  // What the server's own health route does: answer at once, if the thread is free to.
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const router = express.Router();
  registerWorkspaceTools(
    registry,
    router,
    fakeAuth,
    createToolHandlerFactory(resolve),
    new SpillStore(join(tempDir, 'spills')),
    docExtract,
    allowAll,
    testKbContext({ kbDirName: KB }),
    { recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() },
    new RoutineWritePolicyService(),
    {} as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    matcher,
  );
  app.use('/api', router);
  const httpServer = await new Promise<HttpServer>((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
  });
  const baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;

  // `call_tool_chain`: the real MCP proxy, dispatching back over loopback.
  app.get('/api/agent/all-tools', (_req, res) => {
    res.json({
      manuals: [
        {
          name: 'KNOWLEDGE_BASE',
          call_template_type: 'http',
          http_method: 'GET',
          url: '${API_URL}/api/agent/utcp',
          content_type: 'application/json',
          headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
        },
      ],
    });
  });
  const mcp = new McpService({
    loopbackBaseUrl: baseUrl,
    manualName: 'KNOWLEDGE_BASE',
    spillStore: new SpillStore(join(tempDir, 'spills')),
    publicFrontendUrl: 'http://localhost:5173',
  });
  const stub = {} as never;
  app.use('/api', createMcpRoutes(mcp, stub, fakeAuth, fakeAuth, stub, stub, stub, ''));
  app.use('/api', createManualRoutes(registry, passthrough));

  const write = async (path: string, bytes: Buffer | string) => {
    await mkdir(dirname(join(tempDir, path)), { recursive: true });
    await writeFile(join(tempDir, path), bytes);
  };
  await write(DAMAGED, xrefPdf('Hello damaged', { damage: true }));
  await write(`${KB}/Legal/notes.md`, 'Hello from the notes\n');
  await write(`${KB}/Legal/sound.pdf`, xrefPdf('Hello sound', { damage: false }));

  let stopped = false;
  const platform: Platform = {
    baseUrl,
    extractions: () => extractions,
    told,
    write,
    async stop() {
      if (stopped) return;
      stopped = true;
      mcp.onSecretsChanged(null);
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
      await Promise.all([worker.close(), matcher.close()]);
      await rm(tempDir, { recursive: true, force: true });
    },
  };
  running.push(platform);
  return platform;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool answers, read by shape
async function tool(baseUrl: string, name: string, body: object): Promise<any> {
  const res = await fetch(`${baseUrl}/api/agent/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text);
}

/** `call_tool_chain` over the MCP endpoint; answers what the chain returned. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the chain's result, read by shape
async function chain(baseUrl: string, code: string): Promise<any> {
  const res = await fetch(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${BEARER}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'call_tool_chain', arguments: { code } } }),
  });
  const text = await res.text();
  const lines = text.startsWith('event:') || text.startsWith('data:')
    ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)))
    : [JSON.parse(text)];
  const result = lines[lines.length - 1]?.result;
  expect(result?.isError, JSON.stringify(lines)).toBeFalsy();
  const answer = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  expect(answer.success, JSON.stringify(answer)).toBe(true);
  return answer.result;
}

/**
 * Run `work` while asking the health route every 50 ms; answers the slowest
 * health answer seen, in ms, and what `work` answered.
 */
async function timingHealth<T>(baseUrl: string, work: () => Promise<T>): Promise<{ slowest: number; answer: T }> {
  let slowest = 0;
  let done = false;
  const probes: Promise<void>[] = [];
  const probe = async () => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/health`);
    await res.text();
    slowest = Math.max(slowest, Date.now() - started);
  };
  const loop = (async () => {
    while (!done) {
      probes.push(probe());
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const answer = await work();
  done = true;
  await loop;
  await Promise.all(probes);
  return { slowest, answer };
}

describe('a PDF with a damaged cross-reference table', () => {
  it('read_file answers the one-line notice with pdf.js’s message — once extracted, never again', async () => {
    const p = await startPlatform();
    const first = await tool(p.baseUrl, 'read_file', { branch: BRANCH, path: DAMAGED });
    expect(first.content).toBe(NOTICE);
    const second = await tool(p.baseUrl, 'read_file', { branch: BRANCH, path: DAMAGED });
    expect(second.content).toBe(NOTICE);
    expect(p.extractions()).toBe(1);
    // Reported once, for the workspace it was read in.
    expect(p.told).toEqual([{ workspaceId: 'main', path: DAMAGED, reason: PDFJS_SAYS }]);
  });

  it('file_stat answers the remembered notice — and extracts nothing to do so', async () => {
    const p = await startPlatform();
    const before = await tool(p.baseUrl, 'file_stat', { branch: BRANCH, path: DAMAGED });
    expect(before.unreadable).toBeUndefined();
    expect(before.contentMode).toBe('document');
    expect(p.extractions()).toBe(0);
    await tool(p.baseUrl, 'read_file', { branch: BRANCH, path: DAMAGED });
    const after = await tool(p.baseUrl, 'file_stat', { branch: BRANCH, path: DAMAGED });
    expect(after.unreadable).toBe(NOTICE);
    expect(p.extractions()).toBe(1);
  });

  it('call_tool_chain gets the same notice as a direct read_file', async () => {
    const p = await startPlatform();
    const result = await chain(
      p.baseUrl,
      `return KNOWLEDGE_BASE.read_file({ body: { branch: ${JSON.stringify(BRANCH)}, path: ${JSON.stringify(DAMAGED)} } });`,
    );
    expect(result.content).toBe(NOTICE);
  });

  it('grep skips it — every other file’s matches come back — and the next grep does not extract it again', async () => {
    const p = await startPlatform();
    const first = await tool(p.baseUrl, 'grep', { branch: BRANCH, pattern: 'Hello', path: `${KB}/Legal` });
    const paths = (first.matches as Array<{ path: string }>).map((m) => m.path).sort();
    expect(paths).toEqual([`${KB}/Legal/notes.md`, `${KB}/Legal/sound.pdf`]);
    const extracted = p.extractions();
    expect(extracted).toBe(2);
    const second = await tool(p.baseUrl, 'grep', { branch: BRANCH, pattern: 'Hello', path: `${KB}/Legal` });
    expect(second.matches).toEqual(first.matches);
    expect(p.extractions()).toBe(extracted);
  });

  it('grep spends no extraction budget on a remembered failure', async () => {
    const p = await startPlatform();
    // 21 different damaged documents — one more than a grep's budget of 20 cold extractions.
    for (let i = 0; i < 21; i++) await p.write(`${KB}/Many/damaged-${String(i).padStart(2, '0')}.pdf`, xrefPdf(`copy ${i}`, { damage: true }));
    const first = await tool(p.baseUrl, 'grep', { branch: BRANCH, pattern: 'copy', path: `${KB}/Many` });
    expect(first.note).toMatch(/^1 document\(s\) .* were not searched/);
    // The twenty it remembers cost nothing now, so the twenty-first fits.
    const second = await tool(p.baseUrl, 'grep', { branch: BRANCH, pattern: 'copy', path: `${KB}/Many` });
    expect(second.note).toBeUndefined();
    expect(p.extractions()).toBe(21);
    const third = await tool(p.baseUrl, 'grep', { branch: BRANCH, pattern: 'copy', path: `${KB}/Many` });
    expect(third.note).toBeUndefined();
    expect(p.extractions()).toBe(21);
  });

  it('a repaired version, saved over it, is extracted and reads normally', async () => {
    const p = await startPlatform();
    await tool(p.baseUrl, 'read_file', { branch: BRANCH, path: DAMAGED });
    await p.write(DAMAGED, xrefPdf('Hello repaired', { damage: false }));
    const repaired = await tool(p.baseUrl, 'read_file', { branch: BRANCH, path: DAMAGED });
    expect(repaired.content).toBe(`[extracted text of ${DAMAGED} — 1 page; layout, images and formatting omitted]\n[page 1]\nHello repaired`);
  });
});

describe('an extraction that runs long', () => {
  const trouble = (budgetMs?: number): WorkerDocumentExtractorOptions => ({
    entry: {
      url: new URL('../../modules/workspace/file-readers/__tests__/fixtures/pdf-in-trouble.worker.ts', import.meta.url),
      execArgv: ['--import', 'tsx'],
    },
    ...(budgetMs === undefined ? {} : { budgetMs }),
  });

  it('is stopped at the budget and answered with the timeout notice; within the hour the notice comes at once', async () => {
    const p = await startPlatform(trouble(500));
    await p.write(`${KB}/Legal/stuck.pdf`, xrefPdf('HANG', { damage: false }));
    const first = await tool(p.baseUrl, 'read_file', { branch: BRANCH, path: `${KB}/Legal/stuck.pdf` });
    expect(first.content).toContain('could not be read: extracting its text took longer than 0.5 seconds');
    const started = Date.now();
    const again = await tool(p.baseUrl, 'read_file', { branch: BRANCH, path: `${KB}/Legal/stuck.pdf` });
    expect(again.content).toBe(first.content);
    expect(Date.now() - started).toBeLessThan(400);
    expect(p.extractions()).toBe(1);
    const grep = await tool(p.baseUrl, 'grep', { branch: BRANCH, pattern: 'HANG', path: `${KB}/Legal/stuck.pdf` });
    expect(grep.matches).toEqual([]);
    expect(p.extractions()).toBe(1);
    expect(p.told).toEqual([
      { workspaceId: 'main', path: `${KB}/Legal/stuck.pdf`, reason: 'extracting its text took longer than 0.5 seconds' },
    ]);
  });

  it('leaves /api/health answering under a second, on every surface that extracts', async () => {
    const p = await startPlatform(trouble());
    for (const name of ['a', 'b', 'c', 'd']) await p.write(`${KB}/Slow/${name}.pdf`, xrefPdf(`SLOW ${name}`, { damage: false }));
    const surfaces: Array<[string, () => Promise<unknown>]> = [
      ['read_file', () => tool(p.baseUrl, 'read_file', { branch: BRANCH, path: `${KB}/Slow/a.pdf` })],
      ['grep', () => tool(p.baseUrl, 'grep', { branch: BRANCH, pattern: 'SLOW', path: `${KB}/Slow/b.pdf` })],
      ['file_stat', () => tool(p.baseUrl, 'file_stat', { branch: BRANCH, path: `${KB}/Slow/c.pdf` })],
      [
        'call_tool_chain',
        () => chain(p.baseUrl, `return KNOWLEDGE_BASE.read_file({ body: { branch: "main", path: "${KB}/Slow/d.pdf" } });`),
      ],
    ];
    for (const [surface, work] of surfaces) {
      const { slowest } = await timingHealth(p.baseUrl, work);
      expect(slowest, surface).toBeLessThan(1_000);
    }
    // Three of the four extracted (file_stat never does), each spinning 1.5 s in its worker.
    expect(p.extractions()).toBe(3);
  });
});
