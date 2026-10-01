import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../auth/auth.middleware.js'; // Express Request.userEmail augmentation
import { createSkillsRoutes } from '../skills.routes.js';
import type { ISkillService } from '../skills.contract.js';
import type { IAllowedToolsChecker } from '../allowed-tools-check.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * The browser's skill read carries the same `allowed-tools` warnings as
 * `get_skill`, resolved for the CALLER — that is what lets the skill page say
 * so when it opens, not only after a save.
 */

const EMAIL = 'alice@example.com';
const SKILL = {
  name: 'rfi',
  description: 'RFI.',
  path: 'Plugins/Sales/rfi',
  body: '# RFI',
  files: [] as string[],
  allowedTools: ['Bash', 'hubspot.serch'],
};
const WARNING = { entry: 'hubspot.serch', message: 'not a tool', suggestion: 'hubspot.search' };

const skillService = {
  listSkills: async () => [],
  getSkill: async (_email: string, name: string, file?: string) => {
    if (name === 'secret') return { ok: false, error: 'forbidden' };
    return file
      ? { ok: true, kind: 'file', file: { name: 'rfi', file, path: `Plugins/Sales/rfi/${file}`, content: 'notes' } }
      : { ok: true, kind: 'skill', skill: SKILL };
  },
  invalidate: () => {},
} as unknown as ISkillService;

let server: Server | undefined;

async function start(checker?: IAllowedToolsChecker): Promise<string> {
  const app = express();
  app.use((req, _res, next) => {
    req.userEmail = EMAIL;
    next();
  });
  app.use('/api', createSkillsRoutes(skillService, testKbContext(), undefined, undefined, undefined, checker));
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('GET /api/skills/:name — allowed-tools warnings', () => {
  it('answers with the warnings for the requesting user beside the skill', async () => {
    const check = vi.fn(async () => [WARNING]);
    const base = await start({ check, checkSave: async () => [], checkSaves: async () => [] });

    const body = await (await fetch(`${base}/api/skills/rfi`)).json();

    expect(body).toEqual({ ok: true, kind: 'skill', skill: SKILL, warnings: [WARNING] });
    expect(check).toHaveBeenCalledWith(EMAIL, SKILL.allowedTools);
  });

  it('leaves a bundled-file answer alone: nothing there to check', async () => {
    const check = vi.fn(async () => [WARNING]);
    const base = await start({ check, checkSave: async () => [], checkSaves: async () => [] });

    const body = (await (await fetch(`${base}/api/skills/rfi?file=notes.md`)).json()) as { kind: string };

    expect(body.kind).toBe('file');
    expect(body).not.toHaveProperty('warnings');
    expect(check).not.toHaveBeenCalled();
  });

  it('passes a refusal through untouched, without asking the checker', async () => {
    const check = vi.fn(async () => [WARNING]);
    const base = await start({ check, checkSave: async () => [], checkSaves: async () => [] });

    expect(await (await fetch(`${base}/api/skills/secret`)).json()).toEqual({ ok: false, error: 'forbidden' });
    expect(check).not.toHaveBeenCalled();
  });

  it('without a checker the answer keeps its previous shape', async () => {
    const base = await start();
    expect(await (await fetch(`${base}/api/skills/rfi`)).json()).toEqual({ ok: true, kind: 'skill', skill: SKILL });
  });
});
