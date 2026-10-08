import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolContext } from '../../tool-helpers/tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { BranchNotFoundError } from '../../../shared/domain-errors.js';
import { registerSkillsTools } from '../skills.tools.js';
import { unmergedSkillNotice } from '../skills.service.js';
import type { GetSkillOptions, ISkillService, ListSkillsOptions, Skill } from '../skills.contract.js';
import { AllowedToolsChecker } from '../allowed-tools-check.js';
import type { ToolManualDetail, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * The two skill tools reading a draft branch: the input reaches the service,
 * the branch's own answer comes back with its mark and its first line, the
 * `allowed-tools` warnings are computed from the BRANCH's version of the
 * skill, a branch nobody pushed is the file tools' 404, and `branch` with
 * `version` is refused rather than silently ranked.
 */

const DRAFT = 'juan/skill-deck';
const KB_DIR = 'knowledge-base';

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
  testKbContext({ kbDirName: KB_DIR }),
);

/** The released skill and the draft's changed copy of it — only the draft names a tool nobody serves. */
const released: Skill = {
  name: 'rfi',
  description: 'RFI.',
  path: 'Plugins/Sales/rfi',
  body: '# RFI',
  files: [],
  allowedTools: ['hubspot.search'],
};
const onDraft: Skill = {
  ...released,
  body: `${unmergedSkillNotice(DRAFT)}\n\n# RFI, rewritten`,
  allowedTools: ['hubspot.search', 'hubspot.serch'],
  unmerged: true,
  branch: DRAFT,
};

/** What the tools handed the service, so a test can see the branch arrive (or not). */
let listArgs: [string | undefined, ListSkillsOptions | undefined][] = [];
let getArgs: [string, string, string | undefined, GetSkillOptions | undefined][] = [];

const skillService: ISkillService = {
  listSkills: async (userEmail?: string, options?: ListSkillsOptions) => {
    listArgs.push([userEmail, options]);
    if (options?.branch === 'juan/typo') throw new BranchNotFoundError('juan/typo');
    if (options?.branch === DRAFT) {
      return [
        { name: 'rfi', description: 'RFI.', path: released.path, unmerged: true, branch: DRAFT },
        { name: 'make-deck', description: 'Decks.', path: 'Plugins/make-deck', unmerged: true, branch: DRAFT },
      ];
    }
    return [{ name: 'rfi', description: 'RFI.', path: released.path }];
  },
  getSkill: async (userEmail: string, name: string, file?: string, options?: GetSkillOptions) => {
    getArgs.push([userEmail, name, file, options]);
    if (options?.branch === 'juan/typo') throw new BranchNotFoundError('juan/typo');
    return { ok: true, kind: 'skill', skill: options?.branch === DRAFT ? onDraft : released };
  },
  invalidate: () => {},
};

let httpServer: HttpServer | undefined;
let registry: ToolRegistry;

async function start(): Promise<string> {
  listArgs = [];
  getArgs = [];
  registry = new ToolRegistry();
  const resolve = async (auth: ToolAuth, signal: AbortSignal): Promise<ToolContext> =>
    ({
      user: { id: 'u', email: 'e@x', name: 'N' },
      scope: auth.scope,
      source: auth.source,
      abortSignal: signal,
      workspaceService: {} as never,
      workflowService: {} as never,
      events: {} as never,
      getFilesystem: async () => ({}) as never,
    }) as unknown as ToolContext;
  const fakeAuth = (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.toolAuth = { source: 'external', userId: 'u', scope: 'read' };
    next();
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerSkillsTools(registry, router, fakeAuth, createToolHandlerFactory(resolve), skillService, checker);
  app.use('/api', router);
  httpServer = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, () => r(s));
  });
  return `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
}

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    body: JSON.stringify(body),
  });

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
});

describe('the skill tools read a branch when asked', () => {
  it('declares `branch` as an OPTIONAL input on both tools', async () => {
    await start();
    const defs = await registry.listExternal({ userEmail: 'e@x' });
    for (const name of ['list_skills', 'get_skill']) {
      const def = defs.find((t) => t.name === name)!;
      // `toolDef` wraps a tool's flat inputs under `body`.
      const inputs = (def.inputs as { properties: { body: { properties: Record<string, unknown>; required?: string[] } } })
        .properties.body;
      expect(inputs.properties.branch).toBeDefined();
      expect(inputs.required ?? []).not.toContain('branch');
    }
  });

  it('list_skills passes the branch on and returns what that branch has, marked', async () => {
    const base = await start();
    const body = (await (await post(`${base}/api/agent/tools/list_skills`, { branch: DRAFT })).json()) as {
      skills: { name: string; unmerged?: boolean; branch?: string }[];
    };
    expect(listArgs).toEqual([['e@x', { branch: DRAFT }]]);
    expect(body.skills.map((s) => s.name)).toEqual(['rfi', 'make-deck']);
    expect(body.skills.every((s) => s.unmerged === true && s.branch === DRAFT)).toBe(true);
  });

  it('list_skills without a branch asks for the released catalog', async () => {
    const base = await start();
    const body = (await (await post(`${base}/api/agent/tools/list_skills`, {})).json()) as {
      skills: { name: string; unmerged?: boolean }[];
    };
    expect(listArgs).toEqual([['e@x', { branch: undefined }]]);
    expect(body.skills).toEqual([{ name: 'rfi', description: 'RFI.', path: released.path, canWrite: false }]);
  });

  it('a blank branch is no branch at all: the released catalog answers', async () => {
    const base = await start();
    await post(`${base}/api/agent/tools/list_skills`, { branch: '   ' });
    await post(`${base}/api/agent/tools/get_skill`, { name: 'rfi', branch: '' });
    expect(listArgs).toEqual([['e@x', { branch: undefined }]]);
    expect(getArgs[0][3]).toEqual({ version: undefined, branch: undefined });
  });

  it('get_skill passes the branch on, and the body keeps its unmerged first line', async () => {
    const base = await start();
    const body = (await (await post(`${base}/api/agent/tools/get_skill`, { name: 'rfi', branch: DRAFT })).json()) as {
      skill: { body: string; unmerged?: boolean; branch?: string };
    };
    expect(getArgs).toEqual([['e@x', 'rfi', undefined, { version: undefined, branch: DRAFT }]]);
    expect(body.skill.body.split('\n')[0]).toBe(unmergedSkillNotice(DRAFT));
    expect(body.skill.unmerged).toBe(true);
    expect(body.skill.branch).toBe(DRAFT);
  });

  it('the allowed-tools check runs on the BRANCH version of the skill', async () => {
    const base = await start();
    const onBranch = (await (
      await post(`${base}/api/agent/tools/get_skill`, { name: 'rfi', branch: DRAFT })
    ).json()) as { warnings: { entry: string; suggestion?: string }[] };
    // `hubspot.serch` is only in the DRAFT's `allowed-tools`: the warning can
    // only come from the copy the branch serves.
    expect(onBranch.warnings.map((w) => w.entry)).toEqual(['hubspot.serch']);
    expect(onBranch.warnings[0].suggestion).toBe('hubspot.search');
    const releasedRes = (await (await post(`${base}/api/agent/tools/get_skill`, { name: 'rfi' })).json()) as {
      warnings: unknown[];
    };
    expect(releasedRes.warnings).toEqual([]);
  });

  it('refuses `branch` together with `version`, naming both, without asking the service', async () => {
    const base = await start();
    const res = await post(`${base}/api/agent/tools/get_skill`, { name: 'rfi', branch: DRAFT, version: '1.4.0' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('`branch` or `version`, not both');
    expect(getArgs).toEqual([]);
  });

  it('answers 404 naming a branch that does not exist, on both tools', async () => {
    const base = await start();
    for (const [tool, args] of [
      ['list_skills', { branch: 'juan/typo' }],
      ['get_skill', { name: 'rfi', branch: 'juan/typo' }],
    ] as const) {
      const res = await post(`${base}/api/agent/tools/${tool}`, args);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        kind: 'branch-not-found',
        branch: 'juan/typo',
        error: 'There is no branch named juan/typo.',
      });
    }
  });
});
