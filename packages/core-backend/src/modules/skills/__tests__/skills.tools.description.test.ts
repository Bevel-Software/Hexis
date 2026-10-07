import express from 'express';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../tool-registry/tool-registry.js';
import { TOOL_DESCRIPTION_CAP, clientVisibleLength } from '../../tool-registry/description-length.js';
import { GUIDE_FIRST_SENTENCE } from '../../tool-registry/guide-first.js';
import { createToolHandlerFactory } from '../../tool-helpers/tool-handler.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';
import { registerSkillsTools } from '../skills.tools.js';
import type { ISkillService, Skill } from '../skills.contract.js';

/**
 * The two skill tools name the skills the caller may read in their
 * descriptions. The catalog is the organisation's to grow, and a client cuts
 * a long description from the END — so the names are the part that gives way,
 * never the tool's own text, and never an id cut in half.
 */
describe('the skill tools name the available skills within the description cap', () => {
  const unused = () => new Proxy({}, { get: () => undefined }) as never;

  async function served(skills: readonly Skill[]) {
    const registry = new ToolRegistry();
    const skillService = { listSkills: async () => skills } as unknown as ISkillService;
    registerSkillsTools(registry, express.Router(), ((_req, _res, next) => next()) as unknown as ToolAuth, createToolHandlerFactory(unused()), skillService);
    const tools = await registry.listExternal();
    return {
      list: tools.find((t) => t.name === 'list_skills')!,
      get: tools.find((t) => t.name === 'get_skill')!,
    };
  }

  const skill = (name: string): Skill => ({ name, description: '', path: `Skills/${name}` }) as unknown as Skill;

  it('names every skill when they fit, and says so plainly when there are none', async () => {
    const few = await served(['rfi', 'deck-review'].map(skill));
    for (const tool of [few.list, few.get]) {
      expect(tool.description).toContain('Currently available skills: `rfi`, `deck-review`.');
      expect(tool.description).not.toContain(' more');
    }
    const none = await served([]);
    expect(none.list.description).toContain('No skills are currently available.');
  });

  it('lists every skill when the complete line fits, even where a shorter list plus its count would not', async () => {
    // The budget is what the tool's fixed text leaves under the cap once the
    // guide-first sentence is counted — read off a served description rather
    // than guessed, so the names below are sized to fill it EXACTLY.
    const probe = await served([skill('x')]);
    const fixed = probe.list.description!.slice(GUIDE_FIRST_SENTENCE.length + 1, probe.list.description!.indexOf('Currently available skills: '));
    const budget = TOOL_DESCRIPTION_CAP - GUIDE_FIRST_SENTENCE.length - 1 - fixed.length;
    const head = 'Currently available skills: '.length;
    // Twenty-one names, the LAST one short — shorter than the ", and 1 more…"
    // tail a cut before it would carry — and the first one sized so the
    // complete line is the budget to the character. A cut-then-count loop
    // stops at twenty names here (prefix plus tail is over budget) though the
    // complete line fits.
    const count = 21;
    const base = Math.floor((budget - head - 1 - (count - 1) * 2 - count * 2) / count); // chars inside the backticks
    const names = Array.from({ length: count }, (_, i) => `n${i}`.padEnd(base, 'x'));
    names[count - 1] = 'z';
    const slack = budget - (head + names.reduce((n, name) => n + name.length + 2, 0) + (count - 1) * 2 + 1);
    names[0] = names[0] + 'y'.repeat(slack);
    const { list } = await served(names.map(skill));
    const line = list.description!.slice(list.description!.indexOf('Currently available skills: '));
    expect(line.length).toBe(budget);
    expect(line.endsWith('.')).toBe(true);
    expect(line).not.toContain(' more');
    for (const name of names) expect(line).toContain(`\`${name}\``);
  });

  it('cuts the list to what fits under the cap with the guide-first sentence counted, and counts the rest', async () => {
    const many = Array.from({ length: 300 }, (_, i) => skill(`a-skill-with-a-long-name-number-${i}`));
    const { list, get } = await served(many);
    for (const tool of [list, get]) {
      // Measured as the registry serves it: the opener in front.
      expect(clientVisibleLength(tool), tool.name).toBeLessThanOrEqual(TOOL_DESCRIPTION_CAP);
      expect(tool.description!.startsWith(GUIDE_FIRST_SENTENCE), tool.name).toBe(true);
      // The tool's own text is whole; the names are what gave way.
      expect(tool.description, tool.name).toContain('Currently available skills: `a-skill-with-a-long-name-number-0`');
      const counted = /, and (\d+) more that list_skills names\.$/.exec(tool.description!);
      expect(counted, tool.name).not.toBeNull();
      const shown = (tool.description!.match(/`a-skill-with-a-long-name-number-\d+`/g) ?? []).length;
      expect(shown + Number(counted![1]), tool.name).toBe(300);
      // No name is cut in half: every one listed is a real one, closing
      // backtick included — a dangling name (no closing backtick) is caught
      // because the scan does not require one.
      for (const name of tool.description!.match(/`a-skill-with-a-long-name-number-[^`,.]*`?/g) ?? []) {
        expect(name, tool.name).toMatch(/^`a-skill-with-a-long-name-number-\d+`$/);
      }
    }
  });
});
