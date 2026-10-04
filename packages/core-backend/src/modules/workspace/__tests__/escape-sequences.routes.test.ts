import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createManualRoutes } from '../../tool-registry/manual.routes.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../agent-access.gate.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { createMcpRoutes } from '../../mcp/mcp.routes.js';
import { McpService } from '../../mcp/mcp.service.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { sharedFileRules, sharedFileRulesSection, sharedRulesPointer } from '../../agent-instructions/shared-file-rules.js';

/**
 * Who decodes escape sequences in written content a second time — settled on
 * all three routes an agent can write through, with RAW request bodies and a
 * BYTE-level read of what landed:
 *
 *   1. the tool route        POST /api/agent/tools/<name>
 *   2. the MCP endpoint      POST /api/mcp  (JSON-RPC `tools/call`)
 *   3. `call_tool_chain`     the same endpoint, content as a JavaScript
 *                            string literal inside the chain's code
 *
 * Route 2 and 3 run the real `McpService` proxy over the real Streamable-HTTP
 * transport, and dispatch back to route 1 over loopback through UTCP — so the
 * three cases exercise one, two and three serialization hops respectively.
 *
 * Nothing in this file is written as an escape sequence. Every character of
 * the payload is built from its code point, so neither an editor nor the tool
 * that wrote this file can decode the thing under test and leave a broken
 * assertion looking green. What goes on the wire is asserted too
 * ({@link WIRE_ESC_A}), so a payload that was already decoded before it was
 * sent cannot pass as a payload that survived the trip.
 */

const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);
const KB_DIR = 'knowledge-base';
const BRANCH = 'main';

/** The six characters backslash, `u`, `0`, `0`, `4`, `1` — the ticket's ESC-A. */
const ESC_A = `${BACKSLASH}u0041`;
/** ESC-A as it must appear in the JSON *text* of a request: the backslash doubled. */
const WIRE_ESC_A = `${BACKSLASH}${BACKSLASH}u0041`;

/**
 * One payload carrying an escape for a letter (ESC-A), a quote, a backslash
 * and a line break — each meant to stay TEXT — plus a real em dash, which is
 * meant to stay the character it is. Nine distinct characters of interest and
 * no accident: if any hop decodes once more than it should, this string is
 * stored shorter than it was sent.
 */
const PAYLOAD = [
  ESC_A,
  `${BACKSLASH}${QUOTE}`,
  `${BACKSLASH}${BACKSLASH}`,
  `${BACKSLASH}n`,
  String.fromCharCode(0x2014),
].join('|');

/** What `PAYLOAD` must be on disk, as bytes. */
const EXPECTED = Buffer.from(PAYLOAD, 'utf8');

const BEARER = 'bevel_key_user_a';

/** Sets both surfaces' auth stamps: `toolAuth` for the tool routes, `userId` for MCP. */
const fakeAuth: RequestHandler = (req, _res, next) => {
  req.toolAuth = { source: 'internal', userId: 'u', scope: 'write' };
  req.userId = 'u';
  req.externalApiKeyId = 'tok-a';
  next();
};
const passthrough: RequestHandler = (_req, _res, next) => next();

interface Platform {
  baseUrl: string;
  /** The bytes of a stored workspace file, read straight off disk. */
  bytesOf(path: string): Promise<Buffer>;
  /** Tool name → the description an agent reads, off the served catalog. */
  descriptions(): Promise<Record<string, string>>;
  stop(): Promise<void>;
}

const running: Platform[] = [];

async function startPlatform(): Promise<Platform> {
  const tempDir = await mkdtemp(join(tmpdir(), 'escape-seq-'));
  const fs = new LocalFilesystem({ basePath: tempDir, contained: true });
  // `write_files` lands its batch through the locking filesystem's `writeFiles`
  // (re-judge every path under the lock, then write what is kept). This plain
  // filesystem has none, so the same contract is honoured by hand.
  Object.assign(fs, {
    writeFiles: async (
      writes: { path: string; content: string }[],
      _summary: string,
      _deletes: string[],
      check: (pending: readonly { path: string; content: string }[]) => Promise<{ path: string; content: string }[]>,
    ) => {
      for (const w of await check(writes)) await fs.writeFile(w.path, w.content);
    },
  });

  const registry = new ToolRegistry();
  const resolve = async (auth: ToolAuth, signal: AbortSignal, sessionId?: string): Promise<ToolContext> => ({
    user: { id: 'u', email: 'e@x', name: 'N' },
    scope: auth.scope,
    source: auth.source,
    sessionId,
    abortSignal: signal,
    workspaceService: {} as never,
    workflowService: {} as never,
    events: {} as never,
    getFilesystem: async () => fs,
  });
  const allowAll = { canRead: async () => true } as unknown as IAccessControl;

  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerWorkspaceTools(
    registry,
    router,
    fakeAuth,
    createToolHandlerFactory(resolve),
    new SpillStore(join(tempDir, 'spills')),
    new DocExtractService(join(tempDir, 'doc-extract')),
    allowAll,
    testKbContext({ kbDirName: KB_DIR }),
    { recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() },
    new RoutineWritePolicyService(),
    {} as never,
  );
  app.use('/api', router);

  const httpServer = await new Promise<HttpServer>((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s));
  });
  const { port } = httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  // The catalog the MCP proxy discovers: this process's own tool manual.
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
  const service = new McpService({
    loopbackBaseUrl: baseUrl,
    manualName: 'KNOWLEDGE_BASE',
    spillStore: new SpillStore(join(tempDir, 'spills')),
    publicFrontendUrl: 'http://localhost:5173',
  });
  const stub = {} as never;
  app.use('/api', createMcpRoutes(service, stub, fakeAuth, fakeAuth, stub, stub, stub, ''));
  app.use('/api', createManualRoutes(registry, passthrough));

  let stopped = false;
  const platform: Platform = {
    baseUrl,
    bytesOf: (path) => readFile(join(tempDir, path)),
    async descriptions() {
      const res = await fetch(`${baseUrl}/api/agent/utcp`, { headers: { Authorization: `Bearer ${BEARER}` } });
      const manual = (await res.json()) as { tools: Array<{ name: string; description: string }> };
      return Object.fromEntries(manual.tools.map((t) => [t.name, t.description]));
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      service.onSecretsChanged(null);
      httpServer.closeAllConnections();
      await new Promise<void>((r) => httpServer.close(() => r()));
      await rm(tempDir, { recursive: true, force: true });
    },
  };
  running.push(platform);
  return platform;
}

/** POST a raw body string — no object is handed to `fetch`, only text. */
async function postRaw(url: string, body: string, accept = 'application/json'): Promise<string> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: `${accept}, text/event-stream`,
      Authorization: `Bearer ${BEARER}`,
    },
    body,
  });
  return res.text();
}

/** The JSON-RPC messages out of a `/api/mcp` answer, JSON or SSE alike. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw JSON-RPC, read by shape
function messagesOf(text: string): Array<{ result?: any; error?: any }> {
  if (!text.trim()) return [];
  if (!text.startsWith('event:') && !text.startsWith('data:')) return [JSON.parse(text)];
  return text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice('data:'.length)));
}

/** `tools/call` over the MCP endpoint, from raw JSON text. */
async function callTool(baseUrl: string, name: string, args: unknown): Promise<string> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  // What goes on the wire is the six characters, escaped once for JSON.
  expect(body).toContain(WIRE_ESC_A);
  const out = messagesOf(await postRaw(`${baseUrl}/api/mcp`, body));
  const result = out[out.length - 1]?.result;
  expect(out[out.length - 1]?.error, `tools/call ${name} failed`).toBeUndefined();
  expect(result?.isError, JSON.stringify(result)).toBeFalsy();
  return (result.content as Array<{ text: string }>)[0].text;
}

afterEach(async () => {
  for (const p of running.splice(0)) await p.stop().catch(() => {});
});

describe('escape sequences survive a write — the tool route', () => {
  it('stores `write_file` content byte for byte', async () => {
    const { baseUrl, bytesOf } = await startPlatform();
    const path = `${KB_DIR}/esc/route-rest.md`;
    const body = JSON.stringify({ branch: BRANCH, path, content: PAYLOAD });
    expect(body).toContain(WIRE_ESC_A);

    const answer = JSON.parse(await postRaw(`${baseUrl}/api/agent/tools/write_file`, body));
    expect(answer.outcome).toBe('created');
    expect(await bytesOf(path)).toEqual(EXPECTED);
  });

  it('stores `write_files` content byte for byte', async () => {
    const { baseUrl, bytesOf } = await startPlatform();
    const path = `${KB_DIR}/esc/route-rest-batch.md`;
    const body = JSON.stringify({ branch: BRANCH, files: [{ path, content: PAYLOAD }] });
    expect(body).toContain(WIRE_ESC_A);

    const answer = JSON.parse(await postRaw(`${baseUrl}/api/agent/tools/write_files`, body));
    expect(answer.count).toBe(1);
    expect(await bytesOf(path)).toEqual(EXPECTED);
  });

  it('stores an `edit_file` `new_string` byte for byte', async () => {
    const { baseUrl, bytesOf } = await startPlatform();
    const path = `${KB_DIR}/esc/route-rest-edit.md`;
    await postRaw(
      `${baseUrl}/api/agent/tools/write_file`,
      JSON.stringify({ branch: BRANCH, path, content: 'PLACEHOLDER' }),
    );
    const body = JSON.stringify({ branch: BRANCH, path, old_string: 'PLACEHOLDER', new_string: PAYLOAD });
    expect(body).toContain(WIRE_ESC_A);

    const answer = JSON.parse(await postRaw(`${baseUrl}/api/agent/tools/edit_file`, body));
    expect(answer.replaced).toBe(1);
    expect(await bytesOf(path)).toEqual(EXPECTED);
  });
});

describe('escape sequences survive a write — the MCP endpoint', () => {
  it('stores `write_file` content byte for byte', async () => {
    const { baseUrl, bytesOf } = await startPlatform();
    const path = `${KB_DIR}/esc/route-mcp.md`;
    await callTool(baseUrl, 'write_file', { body: { branch: BRANCH, path, content: PAYLOAD } });
    expect(await bytesOf(path)).toEqual(EXPECTED);
  });

  it('stores `write_files` content byte for byte', async () => {
    const { baseUrl, bytesOf } = await startPlatform();
    const path = `${KB_DIR}/esc/route-mcp-batch.md`;
    await callTool(baseUrl, 'write_files', { body: { branch: BRANCH, files: [{ path, content: PAYLOAD }] } });
    expect(await bytesOf(path)).toEqual(EXPECTED);
  });

  it('stores an `edit_file` `new_string` byte for byte', async () => {
    const { baseUrl, bytesOf } = await startPlatform();
    const path = `${KB_DIR}/esc/route-mcp-edit.md`;
    await postRaw(
      `${baseUrl}/api/agent/tools/write_file`,
      JSON.stringify({ branch: BRANCH, path, content: 'PLACEHOLDER' }),
    );
    await callTool(baseUrl, 'edit_file', {
      body: { branch: BRANCH, path, old_string: 'PLACEHOLDER', new_string: PAYLOAD },
    });
    expect(await bytesOf(path)).toEqual(EXPECTED);
  });
});

describe('escape sequences survive a write — call_tool_chain', () => {
  /**
   * The chain's code with `PAYLOAD` as a JavaScript string LITERAL — the shape
   * the ticket describes, and the one that crosses the isolate boundary twice
   * (source in, arguments out). `JSON.stringify` of the payload is a valid JS
   * literal for it, so the literal is produced rather than hand-escaped.
   */
  const chainCode = (expr: string) => `return KNOWLEDGE_BASE.${expr};`;

  it('stores `write_file` content byte for byte', async () => {
    const { baseUrl, bytesOf } = await startPlatform();
    const path = `${KB_DIR}/esc/route-chain.md`;
    const code = chainCode(
      `write_file({ body: { branch: ${JSON.stringify(BRANCH)}, path: ${JSON.stringify(path)}, content: ${JSON.stringify(PAYLOAD)} } })`,
    );
    // The literal inside the chain's own source is the six characters, written
    // as a JS escape — two backslashes, exactly as on the JSON wire.
    expect(code).toContain(WIRE_ESC_A);

    const text = await callTool(baseUrl, 'call_tool_chain', { code });
    expect(JSON.parse(text).success, text).toBe(true);
    expect(await bytesOf(path)).toEqual(EXPECTED);
  });

  it('stores `write_files` content byte for byte', async () => {
    const { baseUrl, bytesOf } = await startPlatform();
    const path = `${KB_DIR}/esc/route-chain-batch.md`;
    const code = chainCode(
      `write_files({ body: { branch: ${JSON.stringify(BRANCH)}, files: [{ path: ${JSON.stringify(path)}, content: ${JSON.stringify(PAYLOAD)} }] } })`,
    );
    expect(code).toContain(WIRE_ESC_A);

    const text = await callTool(baseUrl, 'call_tool_chain', { code });
    expect(JSON.parse(text).success, text).toBe(true);
    expect(await bytesOf(path)).toEqual(EXPECTED);
  });

  it('stores an `edit_file` `new_string` byte for byte', async () => {
    const { baseUrl, bytesOf } = await startPlatform();
    const path = `${KB_DIR}/esc/route-chain-edit.md`;
    await postRaw(
      `${baseUrl}/api/agent/tools/write_file`,
      JSON.stringify({ branch: BRANCH, path, content: 'PLACEHOLDER' }),
    );
    const code = chainCode(
      `edit_file({ body: { branch: ${JSON.stringify(BRANCH)}, path: ${JSON.stringify(path)}, old_string: ${JSON.stringify('PLACEHOLDER')}, new_string: ${JSON.stringify(PAYLOAD)} } })`,
    );
    expect(code).toContain(WIRE_ESC_A);

    const text = await callTool(baseUrl, 'call_tool_chain', { code });
    expect(JSON.parse(text).success, text).toBe(true);
    expect(await bytesOf(path)).toEqual(EXPECTED);
  });
});

describe('what the write tools tell an agent about escape sequences', () => {
  it('states the warning once, in the shared rules, and in no description', async () => {
    const { descriptions } = await startPlatform();
    const served = await descriptions();
    // It applies to the three tools that take content as a JSON string, so it is
    // a SHARED rule: stated in the handshake instructions and in the managed
    // agent guide, and repeated in no tool description — a description that
    // carried it was long enough for a client to cut the end off.
    const rule = sharedFileRules(testKbContext().layout).find((r) => r.id === 'escape-sequences')!;
    expect(rule.body).toContain('some clients decode escape sequences in arguments before sending');
    expect(rule.body).toContain('request_upload_token');
    expect(rule.body).toContain('lands it unchanged');
    // It names the three tools it is about, so an agent reading the section
    // knows where it applies.
    for (const name of ['write_file', 'write_files', 'edit_file']) expect(rule.body, name).toContain(name);
    expect(sharedFileRulesSection(testKbContext().layout)).toContain(rule.body);

    const carrying = Object.entries(served)
      .filter(([, d]) => d.includes('decode escape sequences in arguments before sending') || d.includes('some clients decode them in arguments'))
      .map(([n]) => n);
    expect(carrying).toEqual([]);
    // Each of the three still points at where the warning is.
    for (const name of ['write_file', 'write_files', 'edit_file']) {
      expect(served[name], name).toContain(sharedRulesPointer(testKbContext().layout).trim());
    }
  });
});
