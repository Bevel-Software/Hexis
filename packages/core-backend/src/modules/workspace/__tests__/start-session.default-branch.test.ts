import type { Server as HttpServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { toolHandlerFactory } from '../../../__tests__/tool-handler.js';
import type { KbContext } from '../../../shared/kb-context.js';
import type { IAccessControl } from '../../access/index.js';
import type { ToolAuth } from '../../tool-auth/index.js';
import type { ToolContext } from '../../tool-helpers/index.js';
import { ToolRegistry } from '../../tool-registry/index.js';
import { ToolDescriptionNotes } from '../agent-access.gate.js';
import { DocExtractService } from '../file-readers/doc-extract.service.js';
import { WorkerDocumentExtractor } from '../file-readers/extract-in-worker.js';
import { STARTER_GUIDE_FILE, firstRunNote } from '../first-run.js';
import { RoutineWritePolicyService } from '../routine-write-policy.js';
import { SpillStore } from '../spill-store.js';
import { registerWorkspaceTools } from '../workspace.tools.js';

/**
 * The guide's start names the deployment's default branch, but only to an
 * agent that calls `get_agent_guide`; every file tool asks for "the branch you
 * are working on", and an agent left to guess guesses `main`. `start_session`, the call every agent is told to make
 * first, answers it beside the id: this deployment's, which here is not `main`
 * (`testKbContext`'s default branch is `target-company-state`).
 */

const KB_DIR = 'knowledge-base';

/** Every read allowed: the `firstRun` note is gated like a read, and these tests are not about the gate. */
const allowAll = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _u: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
} as unknown as IAccessControl;

let server: HttpServer | undefined;
let extractor: WorkerDocumentExtractor | undefined;
let wsDir: string | undefined;

/**
 * `start_session` mounted as the root mounts it, for an external caller.
 * `defaultWorkspaceDir` is the default branch's checkout, for the `firstRun`
 * note; without one the note's check has no workspace and the answer carries
 * none.
 */
async function startSession(kb: KbContext, defaultWorkspaceDir?: string): Promise<{ base: string; registry: ToolRegistry }> {
  const registry = new ToolRegistry();
  const resolve = async (auth: ToolAuth, signal: AbortSignal): Promise<ToolContext> => ({
    user: { id: 'user-42', email: 'e@x', name: 'N' },
    scope: auth.scope,
    source: auth.source,
    abortSignal: signal,
    workspaceService: (defaultWorkspaceDir
      ? { hasBootstrappedWorkspace: async () => true, getWorkspacePath: async () => defaultWorkspaceDir }
      : {}) as never,
    versionControlService: {} as never,
    events: {} as never,
    getFilesystem: async () => ({}) as never,
    getWriteValidator: async () => ({}) as never,
  });
  const auth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.toolAuth = { source: 'external', userId: 'user-42', scope: 'write' };
    next();
  };
  extractor = new WorkerDocumentExtractor();
  const router = express.Router();
  registerWorkspaceTools(
    registry,
    router,
    auth,
    toolHandlerFactory(resolve),
    new SpillStore(join(tmpdir(), 'bevel-test-spills')),
    new DocExtractService(join(tmpdir(), 'bevel-test-doc-extract'), extractor),
    allowAll,
    kb,
    // No hook runs: `start_session` reads and writes no file.
    { recoveryBotEmail: 'recovery-bot@bevel.local', hooks: {} as never, notes: new ToolDescriptionNotes() },
    new RoutineWritePolicyService(),
    { createSession: async () => ({ sessionId: 'thread-xyz' }) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined /* downloads */,
    undefined /* starter packs */,
    realDisk(),
  );
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, registry };
}

const call = async (base: string): Promise<Record<string, unknown>> =>
  (await (
    await fetch(`${base}/api/agent/tools/start_session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: '{}',
    })
  ).json()) as Record<string, unknown>;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  await extractor?.close();
  extractor = undefined;
  if (wsDir) await rm(wsDir, { recursive: true, force: true });
  wsDir = undefined;
});

describe('start_session names the default branch', () => {
  it('answers { sessionId, defaultBranch }, the branch being the deployment\'s', async () => {
    const { base } = await startSession(testKbContext({ kbDirName: KB_DIR }));
    expect(await call(base)).toEqual({ sessionId: 'thread-xyz', defaultBranch: 'target-company-state' });
  });

  it('answers firstRun beside them while the knowledge base is empty', async () => {
    wsDir = await mkdtemp(join(tmpdir(), 'bevel-start-session-'));
    await mkdir(join(wsDir, KB_DIR, 'KnowledgeBase'), { recursive: true });
    await writeFile(join(wsDir, KB_DIR, 'KnowledgeBase', STARTER_GUIDE_FILE), '# How to get started\n');
    const { base } = await startSession(testKbContext({ kbDirName: KB_DIR }), wsDir);
    expect(await call(base)).toEqual({
      sessionId: 'thread-xyz',
      defaultBranch: 'target-company-state',
      firstRun: firstRunNote(`${KB_DIR}/KnowledgeBase`),
    });
  });

  it('names the branch in effect when called, not the one in effect when the tool was registered', async () => {
    const kb = testKbContext({ kbDirName: KB_DIR });
    const { base } = await startSession(kb);
    kb.applyBranchModel({ defaultBranch: 'company-state', protectedBranches: ['company-state'] });
    expect(await call(base)).toEqual({ sessionId: 'thread-xyz', defaultBranch: 'company-state' });
  });

  it('says so in its description and declares the field, required, in its output schema', async () => {
    const { registry } = await startSession(testKbContext({ kbDirName: KB_DIR }));
    const def = (await registry.listExternal()).find((t) => t.name === 'start_session')!;
    expect(def.description).toContain('Returns `{ sessionId, defaultBranch }`, plus `firstRun` while the knowledge base is empty');
    const outputs = def.outputs as { properties: Record<string, { description?: string }>; required: string[] };
    expect(Object.keys(outputs.properties)).toEqual(['sessionId', 'defaultBranch', 'firstRun']);
    expect(outputs.properties.defaultBranch.description).toContain('the branch people read');
    expect(outputs.required).toEqual(['sessionId', 'defaultBranch']);
  });
});
