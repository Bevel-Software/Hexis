import type { Server as HttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import { routeToolSchemas } from '../../tool-helpers/route-tool-schemas.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../workspace.tools.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { ToolDescriptionNotes } from '../agent-access.gate.js';
import { SpillStore } from '../spill-store.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { BRANCH_REQUIRED_MESSAGE } from '../../../shared/domain-errors.js';
import { callLine, compileCheck, exampleArguments } from '@bevel-software/platform-mcp-core';

/**
 * The REST route a script, a runner or a CI job calls with a connection key —
 * `POST /api/agent/tools/<name>` — driven against the REAL workspace tools.
 *
 * This is the surface the first implementation left unprotected: `write_file`
 * without `content` answered a 500 `TypeError`, `move_file` without `dest` the
 * same, and `grep` without `pattern` answered 200 having matched every file in
 * the knowledge base. The three calls the ticket names are here, with their own
 * schemas and their own route handlers, so the refusal under test is the one a
 * caller really gets.
 */

const KB = 'knowledge-base';
const BRANCH = 'main';

const TREE: Record<string, string> = {
  'roles.yaml': 'roles:\n  Admin:\n    - author@x.io\n',
  'access.md': '---\nread:\n  - everyone\nwrite:\n  - everyone\n---\n',
  'KnowledgeBase/Note.md': '# Note\n\nthe needle is here\n',
  'KnowledgeBase/Other.md': '# Other\n\nthe needle is here too\n',
};

let root = '';
let docCache = '';
let base = '';
let server: HttpServer;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rest-tool-arguments-'));
  for (const [rel, text] of Object.entries(TREE)) {
    const abs = join(root, KB, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
  }
  const workspaceService = {
    getWorkspacePath: async () => root,
    ensureRemotesFetched: async () => undefined,
  } as unknown as Parameters<typeof AccessControlService.prototype.constructor>[0];
  const access = new AccessControlService(workspaceService as never, KB, new NodeFs());
  const fs = new LocalFilesystem({ basePath: root, contained: true });
  const resolve = async (auth: ToolAuth, signal: AbortSignal): Promise<ToolContext> =>
    ({
      user: { id: 'u', email: 'author@x.io', name: 'Author' },
      scope: auth.scope,
      source: auth.source,
      abortSignal: signal,
      workspaceService: workspaceService as never,
      workflowService: {} as never,
      events: {} as never,
      getFilesystem: async () => fs,
    }) as unknown as ToolContext;
  const app = express();
  app.use(express.json());
  const router = express.Router();
  docCache = await mkdtemp(join(tmpdir(), 'rest-tool-arguments-doc-'));
  registerWorkspaceTools(
    new ToolRegistry(),
    router,
    (req, _res, next) => {
      req.toolAuth = { source: 'external', userId: 'u', scope: 'write' };
      next();
    },
    createToolHandlerFactory(resolve),
    new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    new DocExtractService(docCache),
    access,
    testKbContext({ kbDirName: KB }),
    { recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks(), notes: new ToolDescriptionNotes() },
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

interface Answered {
  status: number;
  body: { error?: string; kind?: string; matches?: unknown[]; truncated?: boolean };
}

/** One call on the REST route, exactly as a script with a connection key makes it. */
async function callTool(tool: string, body: unknown): Promise<Answered> {
  const res = await fetch(`${base}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer connection-key' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Answered['body'] };
}

const exists = (rel: string) =>
  stat(join(root, rel))
    .then(() => true)
    .catch(() => false);

describe('POST /api/agent/tools/<name> checks the arguments against the tool', () => {
  it('refuses write_file without `content` — the 400 with the interface, not a 500, and writes nothing', async () => {
    const { status, body } = await callTool('write_file', {
      branch: BRANCH,
      path: `${KB}/KnowledgeBase/New.md`,
      sessionId: 's-1',
    });
    expect(status).toBe(400);
    expect(body.kind).toBe('arguments-do-not-match');
    expect(body.error).toContain('The arguments do not match the "write_file" tool.');
    expect(body.error).toContain('"content" is required, and was not given.');
    expect(body.error).toContain('Interface of "write_file":');
    expect(body.error).toContain('content (string, required)');
    expect(body.error).toContain('path (string, required)');
    expect(body.error?.split('\n').pop()).toBe(
      callLine('KNOWLEDGE_BASE.write_file', routeToolSchemas('write_file')!.wire),
    );
    // The call ran nothing: no file was created.
    expect(await exists(`${KB}/KnowledgeBase/New.md`)).toBe(false);
  });

  it('refuses move_file without `dest`, and moves nothing', async () => {
    const { status, body } = await callTool('move_file', {
      branch: BRANCH,
      src: `${KB}/KnowledgeBase/Note.md`,
    });
    expect(status).toBe(400);
    expect(body.kind).toBe('arguments-do-not-match');
    expect(body.error).toContain('"dest" is required, and was not given.');
    expect(body.error).toContain('dest (string, required)');
    expect(await readFile(join(root, KB, 'KnowledgeBase/Note.md'), 'utf8')).toContain('the needle is here');
  });

  it('refuses grep without `pattern`, and searches nothing', async () => {
    const { status, body } = await callTool('grep', { branch: BRANCH });
    expect(status).toBe(400);
    expect(body.kind).toBe('arguments-do-not-match');
    expect(body.error).toContain('"pattern" is required, and was not given.');
    expect(body.error).toContain('pattern (string, required) — JavaScript regular expression.');
    // Not a 200 that matched every file, which is what this surface answered
    // before the check lived in the route.
    expect(body.matches).toBeUndefined();
  });

  it('names an argument of the wrong type, and one the tool does not have', async () => {
    const wrongType = await callTool('grep', { branch: BRANCH, pattern: 'needle', max_results: 'ten' });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error).toContain('"max_results" must be integer, but string was given.');
    const unknown = await callTool('grep', { branch: BRANCH, pattern: 'needle', recursive: true });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toContain('"recursive" is not an argument of this tool.');
  });

  it('keeps the refusal that names a missing branch, word for word', async () => {
    const { status, body } = await callTool('read_file', { path: `${KB}/KnowledgeBase/Note.md` });
    expect(status).toBe(400);
    expect(body.kind).toBe('branch-required');
    expect(body.error).toBe(BRANCH_REQUIRED_MESSAGE);
  });

  it('passes a matching call on with exactly the arguments that were sent', async () => {
    const { status, body } = await callTool('grep', {
      branch: BRANCH,
      pattern: 'needle',
      path: `${KB}/KnowledgeBase`,
      max_results: 1,
    });
    expect(status).toBe(200);
    // `max_results: 1` was honoured, so the argument reached the tool as sent —
    // the check neither dropped it nor rewrote it.
    expect(body.matches).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });

  it('every mounted tool can be called with its own generated example', async () => {
    const names = ['read_file', 'write_file', 'move_file', 'grep', 'list_files'];
    for (const name of names) {
      const schemas = routeToolSchemas(name);
      expect(schemas, name).toBeDefined();
      // The example an agent is told to copy is generated from the WIRE schema;
      // what its route checks is the FLAT one. Both must accept it, or the
      // platform publishes an example its own check refuses.
      const flat = compileCheck(schemas!.flat);
      expect(flat.checkable, name).toBe(true);
      if (flat.checkable) expect(flat.check(exampleArguments(schemas!.flat)), name).toEqual([]);
      const wire = compileCheck(schemas!.wire);
      expect(wire.checkable, name).toBe(true);
      if (wire.checkable) expect(wire.check(exampleArguments(schemas!.wire)), name).toEqual([]);
    }
  });
});
