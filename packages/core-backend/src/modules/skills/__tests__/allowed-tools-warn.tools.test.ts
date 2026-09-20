import type { Server as HttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFilesystem } from '@mastra/core/workspace';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerWorkspaceTools } from '../../workspace/workspace.tools.js';
import { RoutineWritePolicyService } from '../../workspace/routine-write-policy.js';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { SpillStore } from '../../workspace/spill-store.js';
import { DocExtractService } from '../../workspace/file-readers/doc-extract.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ToolManualDetail, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import { registerSkillsTools } from '../skills.tools.js';
import type { ISkillService } from '../skills.contract.js';
import { AllowedToolsChecker } from '../allowed-tools-check.js';

/**
 * The agent surfaces end to end: a SKILL.md written through the file tools
 * comes back with `warnings` (and is still written), and `get_skill` carries
 * the same list — both resolved through the real tool handler machinery.
 */

const KB_DIR = 'knowledge-base';
const SKILL_PATH = `${KB_DIR}/Plugins/Sales/rfi/SKILL.md`;
const SKILL = '---\nname: rfi\ndescription: RFI.\nallowed-tools: Bash Read hubspot.search hubspot.serch legacy_crm\n---\n\n# RFI\n';

const hubspot: ToolManualSummary = { slug: 'hubspot', name: 'hubspot', path: 'Plugins/Sales/hubspot.tool', type: 'inline' };
const checker = new AllowedToolsChecker(
  { listExternal: async () => [] },
  {
    listAccessible: async () => [hubspot],
    getDetail: async (): Promise<ToolManualDetail> => ({
      ...hubspot,
      description: null,
      capabilities: [{ name: 'search', description: null }],
    }),
  },
  KB_DIR,
);

const skillService: ISkillService = {
  listSkills: async () => [],
  getSkill: async () => ({
    ok: true,
    kind: 'skill',
    skill: {
      name: 'rfi',
      description: 'RFI.',
      path: 'Plugins/Sales/rfi',
      body: '# RFI',
      files: [],
      allowedTools: ['Bash', 'hubspot.search', 'hubspot.serch', 'legacy_crm'],
    },
  }),
  invalidate: () => {},
};

let httpServer: HttpServer | undefined;
let tempDir = '';

async function start(): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), 'allowed-tools-'));
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
  const toolHandler = createToolHandlerFactory(resolve);
  const fakeAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.toolAuth = { source: 'internal', userId: 'u', scope: 'write' };
    next();
  };
  const allowAll = { canRead: async () => true } as unknown as IAccessControl;
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerWorkspaceTools(
    registry, router, fakeAuth, toolHandler,
    new SpillStore(join(tmpdir(), 'bevel-test-spills')), new DocExtractService(join(tmpdir(), 'bevel-test-doc-extract')), allowAll, KB_DIR,
    { service: {} as never, enabled: false, kbDirName: KB_DIR, recoveryBotEmail: 'recovery-bot@bevel.local', hooks: new WorkflowHooks() },
    new RoutineWritePolicyService(),
    {} as never,
    checker,
  );
  registerSkillsTools(registry, router, fakeAuth, toolHandler, skillService, checker);
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify(body) });

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

type Warning = { entry: string; suggestion?: string };

describe('allowed-tools warnings on the agent surfaces', () => {
  it('write_file saves the skill AND returns warnings for the unknown platform tools only', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/write_file`, { branch: 'main', path: SKILL_PATH, content: SKILL });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings?: Warning[] };
    expect(body.warnings?.map((w) => w.entry)).toEqual(['hubspot.serch', 'legacy_crm']);
    expect(body.warnings?.[0]?.suggestion).toBe('hubspot.search');
    // Never blocked: the file is on disk as written.
    const read = (await (await post(`${base}/api/agent/tools/read_file`, { branch: 'main', path: SKILL_PATH })).json()) as {
      content: string;
    };
    expect(read.content).toBe(SKILL);
  });

  it('edit_file checks the file as edited, and a clean skill carries no warnings key', async () => {
    const base = await start();
    await post(`${base}/api/agent/tools/write_file`, { branch: 'main', path: SKILL_PATH, content: SKILL });
    const res = await post(`${base}/api/agent/tools/edit_file`, {
      branch: 'main',
      path: SKILL_PATH,
      old_string: ' hubspot.serch legacy_crm',
      new_string: '',
    });
    expect(await res.json()).toEqual({ path: SKILL_PATH, replaced: 1 });
  });

  it('write_files judges each landed skill once, by the content that is in the branch', async () => {
    const base = await start();
    const quote = `${KB_DIR}/Plugins/Sales/quote/SKILL.md`;
    const res = await post(`${base}/api/agent/tools/write_files`, {
      branch: 'main',
      mode: 'overwrite',
      files: [
        // Named twice: this first content is replaced below and must not be judged.
        { path: SKILL_PATH, content: SKILL },
        { path: SKILL_PATH, content: SKILL.replace(' hubspot.serch legacy_crm', '') },
        { path: quote, content: SKILL.replace('name: rfi', 'name: quote').replace(' hubspot.serch', '') },
        { path: `${KB_DIR}/Data/notes.md`, content: '---\nallowed-tools: nope.nothing\n---\n' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; warnings?: (Warning & { path: string })[] };
    expect(body.count).toBe(4);
    expect(body.warnings).toEqual([{ path: quote, entry: 'legacy_crm', message: expect.any(String) }]);
  });

  it('a non-skill file is never checked', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/write_file`, {
      branch: 'main',
      path: `${KB_DIR}/Data/notes.md`,
      content: '---\nallowed-tools: nope.nothing\n---\n',
    });
    expect(await res.json()).not.toHaveProperty('warnings');
  });

  it('get_skill includes the same warnings under `warnings`', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/get_skill`, { name: 'rfi' });
    const body = (await res.json()) as { ok: boolean; skill: { name: string }; warnings: Warning[] };
    expect(body.ok).toBe(true);
    expect(body.skill.name).toBe('rfi');
    expect(body.warnings.map((w) => w.entry)).toEqual(['hubspot.serch', 'legacy_crm']);
  });
});
