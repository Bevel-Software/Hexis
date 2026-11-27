import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import '../../auth/index.js'; // Express Request.userEmail augmentation, through auth's entry
import { createSkillsRoutes, type SkillMembershipSource } from '../skills.routes.js';
import type { ISkillService } from '../skills.contract.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * A grant a link left behind when its entry was edited out of plugin.json is
 * decorated onto the skill it still opens, so the skill page can name it and
 * who can remove it: only for plugins the caller may discover, and without
 * the other skills the same grant opens.
 */

const EMAIL = 'sam@x.io';
const EDITORS = { roles: ['Admin'], users: [{ name: 'eve@x.io', email: 'eve@x.io' }] };

const skillService = {
  listSkills: async () => [
    { name: 'beta', description: 'B.', path: 'Skills/QALink/beta' },
    { name: 'gamma', description: 'G.', path: 'Skills/QALink/gamma' },
  ],
} as unknown as ISkillService;

const links: SkillMembershipSource = {
  membership: async () => ({
    bySkill: new Map(),
    byPlugin: new Map([
      ['lead-ops', { folder: 'Plugins/Lead Ops' }],
      ['hidden', { folder: 'Plugins/Hidden' }],
    ]),
    leftoverBySkill: new Map([
      [
        'Skills/QALink/beta',
        [
          { plugin: 'lead-ops', folder: 'Skills/QALink', skills: ['Skills/QALink/beta', 'Skills/Secret/x'], editors: EDITORS },
          { plugin: 'hidden', folder: 'Skills/QALink/beta', skills: ['Skills/QALink/beta'], editors: EDITORS },
        ],
      ],
    ]),
  }),
};

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('GET /api/skills — leftover plugin grants', () => {
  it('names the grant, its folder and its editors on the skill, for discoverable plugins only', async () => {
    const app = express();
    app.use((req, _res, next) => {
      req.userEmail = EMAIL;
      next();
    });
    const gate = {
      canReadBatch: async (_ws: string, _email: string, paths: string[]) =>
        new Map(paths.map((p) => [p, p === 'Plugins/Lead Ops/access.md'])),
    };
    app.use('/api', createSkillsRoutes(skillService, testKbContext(), undefined, links, gate));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const body = (await (await fetch(`${base}/api/skills`)).json()) as {
      skills: { path: string; leftoverGrants: unknown[] }[];
    };

    const beta = body.skills.find((s) => s.path === 'Skills/QALink/beta');
    // `hidden` is a plugin the caller may not discover; the other skills the
    // grant opens are not this caller's to learn about.
    expect(beta?.leftoverGrants).toEqual([{ plugin: 'lead-ops', folder: 'Skills/QALink', editors: EDITORS }]);
    expect(body.skills.find((s) => s.path === 'Skills/QALink/gamma')?.leftoverGrants).toEqual([]);
  });
});
