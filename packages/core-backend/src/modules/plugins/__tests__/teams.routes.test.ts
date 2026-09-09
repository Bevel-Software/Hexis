import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, afterEach, vi } from 'vitest';

import type { IAccessControl } from '../../access/access-control.interface.js';
import type { ISkillService, SkillSummary } from '../../skills/skills.contract.js';
import type { IToolManualService, ToolManualSummary } from '../../tool-manuals/tool-manuals.contract.js';
import type { IPluginIndexService, PluginCatalogEntry } from '../plugins.contract.js';
import { createTeamsRoutes } from '../teams.routes.js';

/**
 * `GET /api/teams` — what each group can use, by id, sliced to what the
 * caller already sees. The resolver is stubbed with two tables: what the
 * CALLER reads and what each GROUP reads; the route's job is the join.
 */

const ALI = 'ali@bevel.software';

const principals = (over: Partial<PluginCatalogEntry>): PluginCatalogEntry => ({
  name: 'gtm',
  displayName: 'GTM',
  folders: ['Plugins/GTM'],
  linksAreManaged: true,
  skillCount: 0,
  toolCount: 0,
  brokenLinks: 0,
  owners: { roles: [], users: [] },
  writers: { roles: [], users: [] },
  readers: { restricted: true, roles: [], users: [] },
  ...over,
});

const CATALOG: PluginCatalogEntry[] = [
  principals({}),
  principals({ name: 'finance', displayName: 'Finance', folders: ['Plugins/Finance'] }),
  principals({ name: 'personal-ali', displayName: "Ali's plugin", folders: ['Plugins/personal-ali'] }),
];

const SKILLS: SkillSummary[] = [
  { name: 'outreach', description: '', path: 'Skills/Sales/outreach' },
  { name: 'ledger', description: '', path: 'Skills/Finance/ledger' },
  { name: 'weekly', description: '', path: 'Plugins/personal-ali/skills/weekly' },
];

const TOOLS: ToolManualSummary[] = [
  { slug: 'hubspot', name: 'HubSpot', path: 'Plugins/GTM/mcp.json', type: 'mcp' } as ToolManualSummary,
  { slug: 'books', name: 'Books', path: 'Plugins/Finance/books.tool', type: 'inline' } as ToolManualSummary,
];

interface HarnessOpts {
  groups?: string[];
  /** What the caller reads. */
  caller?: string[];
  /** What each group reads; a group absent here is "not a group" (null). */
  team?: Record<string, string[]>;
  email?: string | null;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function harness(opts: HarnessOpts = {}) {
  const tableVerdict = (allowed: string[] | undefined, paths: string[]) =>
    new Map(paths.map((p) => [p, (allowed ?? []).includes(p)]));
  const accessControl = {
    kbPrincipals: vi.fn(async () => ({ roles: [], groups: opts.groups ?? ['Sales Team'], plugins: [], people: [] })),
    canReadBatch: vi.fn(async (_w: string, _email: string, paths: string[]) => tableVerdict(opts.caller, paths)),
    canReadAsGroupBatch: vi.fn(async (_w: string, group: string, paths: string[]) =>
      opts.team && group in opts.team ? tableVerdict(opts.team[group], paths) : null,
    ),
  } as unknown as IAccessControl;
  const index = { catalog: async () => CATALOG, invalidate: () => undefined } as IPluginIndexService;
  const skills = { listSkills: async () => SKILLS } as unknown as ISkillService;
  const tools = { listAllSummaries: async () => TOOLS } as unknown as IToolManualService;

  const email = opts.email === undefined ? ALI : opts.email;
  const app = express();
  app.use('/api', (req, _res, next) => {
    if (email) req.userEmail = email;
    next();
  });
  app.use('/api', createTeamsRoutes(accessControl, index, skills, tools));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { get: () => fetch(`${base}/api/teams`), accessControl };
}

describe('GET /api/teams', () => {
  const EVERYTHING = [
    'Plugins/GTM',
    'Plugins/GTM/access.md',
    'Plugins/Finance',
    'Plugins/Finance/access.md',
    'Skills/Sales/outreach/SKILL.md',
    'Skills/Finance/ledger/SKILL.md',
    'Plugins/personal-ali/skills/weekly/SKILL.md',
    'Plugins/GTM/mcp.json',
    'Plugins/Finance/books.tool',
  ];

  it('names what the team reads, by id, and only what the caller sees too', async () => {
    const h = await harness({
      groups: ['Sales Team', 'Finance Team'],
      caller: EVERYTHING,
      team: {
        'Sales Team': ['Plugins/GTM', 'Skills/Sales/outreach/SKILL.md', 'Plugins/GTM/mcp.json'],
        'Finance Team': ['Plugins/Finance', 'Skills/Finance/ledger/SKILL.md', 'Plugins/Finance/books.tool'],
      },
    });
    const res = await h.get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      teams: [
        { name: 'Sales Team', plugins: ['gtm'], skills: ['outreach'], tools: ['hubspot'] },
        { name: 'Finance Team', plugins: ['finance'], skills: ['ledger'], tools: ['books'] },
      ],
    });
  });

  it('withholds what the caller cannot read, whatever the team can', async () => {
    const h = await harness({
      caller: ['Plugins/GTM', 'Skills/Sales/outreach/SKILL.md'],
      team: {
        'Sales Team': [
          'Plugins/GTM',
          'Plugins/Finance',
          'Skills/Sales/outreach/SKILL.md',
          'Skills/Finance/ledger/SKILL.md',
          'Plugins/GTM/mcp.json',
        ],
      },
    });
    expect(await (await h.get()).json()).toEqual({
      teams: [{ name: 'Sales Team', plugins: ['gtm'], skills: ['outreach'], tools: [] }],
    });
  });

  it("lists a plugin the caller can only DISCOVER — it is on their index, locked", async () => {
    const h = await harness({
      caller: ['Plugins/Finance/access.md'],
      team: { 'Sales Team': ['Plugins/Finance'] },
    });
    expect(await (await h.get()).json()).toEqual({
      teams: [{ name: 'Sales Team', plugins: ['finance'], skills: [], tools: [] }],
    });
  });

  it("never offers a personal plugin, or what lives in it, as a team's", async () => {
    const h = await harness({
      caller: EVERYTHING,
      team: { 'Sales Team': EVERYTHING },
    });
    const body = (await (await h.get()).json()) as { teams: { plugins: string[]; skills: string[] }[] };
    expect(body.teams[0]?.plugins).toEqual(['gtm', 'finance']);
    // The personal skill is probed like any other; its verdict here is the
    // stub's "yes", so it stays — what keeps it out is the plugin, not the
    // skill. A real resolver answers no for it (a personal folder admits no group).
    expect(body.teams[0]?.plugins).not.toContain('personal-ali');
  });

  it('skips a group the resolver no longer knows', async () => {
    const h = await harness({ groups: ['Sales Team', 'Gone'], caller: EVERYTHING, team: { 'Sales Team': [] } });
    expect(await (await h.get()).json()).toEqual({
      teams: [{ name: 'Sales Team', plugins: [], skills: [], tools: [] }],
    });
  });

  it('asks the resolver once for the caller and once per group, over one probe set', async () => {
    const h = await harness({ groups: ['A', 'B'], caller: EVERYTHING, team: { A: [], B: [] } });
    await h.get();
    expect(h.accessControl.canReadBatch).toHaveBeenCalledTimes(1);
    expect(h.accessControl.canReadAsGroupBatch).toHaveBeenCalledTimes(2);
    const [, , probes] = vi.mocked(h.accessControl.canReadBatch).mock.calls[0]!;
    // Personal folders are not probed as plugins; everything else is, once.
    expect(probes).toEqual(expect.arrayContaining(['Plugins/GTM', 'Plugins/GTM/access.md', 'Plugins/Finance/books.tool']));
    expect(probes).not.toContain('Plugins/personal-ali');
    expect(new Set(probes).size).toBe(probes.length);
  });

  it('is 401 without a caller', async () => {
    const h = await harness({ email: null });
    expect((await h.get()).status).toBe(401);
  });
});
