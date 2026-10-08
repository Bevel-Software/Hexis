import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { defaultKbTemplateDir } from '../../../assets.js';
import { agentGuideSections } from '../../agent-guide/agent-guide.js';
import {
  ENTRY_BUDGET,
  FIRST_RUN_SECTION_ID,
  STARTER_GUIDE_FILE,
  firstRunNote,
  knowledgeFolderIsNew,
} from '../first-run.js';

/**
 * What makes a knowledge base "new" for the `firstRun` note: nothing in its
 * knowledge folder but the starter guide the template seeds. Pinned here on a
 * real folder; the route that returns the note is exercised in
 * workspace.tools.test.ts.
 */
describe('knowledgeFolderIsNew', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bevel-first-run-unit-'));
    await writeFile(join(dir, STARTER_GUIDE_FILE), '# How to get started\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is new with only the starter guide', async () => {
    expect(await knowledgeFolderIsNew(dir)).toBe(true);
  });

  it('is new with nothing at all: a starter guide someone deleted leaves an empty knowledge base', async () => {
    await rm(join(dir, STARTER_GUIDE_FILE));
    expect(await knowledgeFolderIsNew(dir)).toBe(true);
  });

  it('passes over empty folders, their placeholders, dot-files and access rules', async () => {
    await mkdir(join(dir, 'Customers', 'Archive'), { recursive: true });
    await writeFile(join(dir, 'Customers', '.gitkeep'), '');
    await writeFile(join(dir, 'Customers', 'access.md'), '# Access\n');
    await writeFile(join(dir, '.DS_Store'), '');
    expect(await knowledgeFolderIsNew(dir)).toBe(true);
  });

  it('is not new once a page sits beside the starter guide', async () => {
    await writeFile(join(dir, 'Glossary.md'), '# Glossary\n');
    expect(await knowledgeFolderIsNew(dir)).toBe(false);
  });

  it('is not new once a page sits in a folder, of any kind', async () => {
    await mkdir(join(dir, 'Products'), { recursive: true });
    await writeFile(join(dir, 'Products', 'Pricing.pdf'), 'bytes');
    expect(await knowledgeFolderIsNew(dir)).toBe(false);
  });

  it('counts a file named like the starter guide below the top as a page', async () => {
    await mkdir(join(dir, 'Team'), { recursive: true });
    await writeFile(join(dir, 'Team', STARTER_GUIDE_FILE), '# Our own onboarding\n');
    expect(await knowledgeFolderIsNew(dir)).toBe(false);
  });

  it('is not new when the folder is not there: a shape the template never made is not greeted', async () => {
    expect(await knowledgeFolderIsNew(join(dir, 'missing'))).toBe(false);
  });

  it('passes over a starter pack page that still holds what the pack wrote, line endings aside', async () => {
    await mkdir(join(dir, 'Team'), { recursive: true });
    await writeFile(join(dir, 'About us.md'), '# About us\r\n\r\nAsk your agent: _Draft this_\r\n');
    await writeFile(join(dir, 'Team', 'Glossary.md'), '# Glossary\n');
    const starter = new Map([
      ['About us.md', '# About us\n\nAsk your agent: _Draft this_\n'],
      ['Team/Glossary.md', '# Glossary\n'],
    ]);
    expect(await knowledgeFolderIsNew(dir, starter)).toBe(true);
    // The same pages count without the pack to recognise them by.
    expect(await knowledgeFolderIsNew(dir)).toBe(false);
  });

  it('is not new once someone fills a starter page in', async () => {
    await writeFile(join(dir, 'About us.md'), '# About us\n\nWe make bicycles.\n');
    expect(await knowledgeFolderIsNew(dir, new Map([['About us.md', '# About us\n']]))).toBe(false);
  });

  it("answers for the caller when asked to: a page they may not read does not make the folder old for them", async () => {
    await mkdir(join(dir, 'Leadership'), { recursive: true });
    await writeFile(join(dir, 'Leadership', 'Plan.md'), '# Plan\n');
    const seen: string[][] = [];
    const nobody = async (rels: string[]) => {
      seen.push(rels);
      return new Map(rels.map((rel) => [rel, false]));
    };
    expect(await knowledgeFolderIsNew(dir, undefined, nobody)).toBe(true);
    // Asked about the folder before entering it; refused, its page was never seen.
    expect(seen).toEqual([['Leadership']]);

    const everyone = async (rels: string[]) => new Map(rels.map((rel) => [rel, true]));
    expect(await knowledgeFolderIsNew(dir, undefined, everyone)).toBe(false);
    // Without anyone to ask, a page is a page.
    expect(await knowledgeFolderIsNew(dir)).toBe(false);
  });

  it('does not enter a folder the caller may not read: nothing in it is walked, counted or judged', async () => {
    // More entries than the budget allows: were the closed folder walked,
    // the budget alone would answer "not new".
    await mkdir(join(dir, 'Leadership'), { recursive: true });
    await Promise.all(
      Array.from({ length: ENTRY_BUDGET + 1 }, (_, i) => writeFile(join(dir, 'Leadership', `Plan-${i}.md`), '# Plan\n')),
    );
    await mkdir(join(dir, 'Team'), { recursive: true });
    await writeFile(join(dir, 'Team', '.gitkeep'), '');
    const asked: string[][] = [];
    const notLeadership = async (rels: string[]) => {
      asked.push(rels);
      return new Map(rels.map((rel) => [rel, rel !== 'Leadership']));
    };
    expect(await knowledgeFolderIsNew(dir, undefined, notLeadership)).toBe(true);
    // Asked about the folders once, at the top (in whatever order the disk
    // lists them); the closed one's pages were never seen.
    expect(asked.map((rels) => [...rels].sort())).toEqual([['Leadership', 'Team']]);
  });

  it('passes a link over by kind: not a page, never read through, never asked about', async () => {
    try {
      await symlink(join(tmpdir(), 'elsewhere.md'), join(dir, 'Alias.md'));
    } catch {
      return; // no symlinks on this machine: nothing to pass over
    }
    const asked: string[][] = [];
    const everyone = async (rels: string[]) => {
      asked.push(rels);
      return new Map(rels.map((rel) => [rel, true]));
    };
    expect(await knowledgeFolderIsNew(dir, undefined, everyone)).toBe(true);
    expect(asked).toEqual([]);
    expect(await knowledgeFolderIsNew(dir)).toBe(true);
  });

  it('stops reading at its entry budget: that many entries and no page is not a new knowledge base', async () => {
    // Entries that are never pages, so only the budget can end the walk.
    await Promise.all(Array.from({ length: ENTRY_BUDGET }, (_, i) => writeFile(join(dir, `.note-${i}`), '')));
    expect(await knowledgeFolderIsNew(dir)).toBe(false);
    // One fewer, starter guide included, and the walk reads them all.
    await rm(join(dir, '.note-0'));
    expect(await knowledgeFolderIsNew(dir)).toBe(true);
  });
});

describe('the firstRun note', () => {
  it('names the starter guide the template really seeds', async () => {
    const seeded = await stat(join(defaultKbTemplateDir(), 'KnowledgeBase', STARTER_GUIDE_FILE));
    expect(seeded.isFile()).toBe(true);
  });

  it('points at a section the guide has, which says what to do', async () => {
    const sections = await agentGuideSections(DEFAULT_KB_LAYOUT, undefined, { kbDirName: 'kb-checkout' });
    const section = sections.find((s) => s.id === FIRST_RUN_SECTION_ID);
    expect(section, `the guide has no "${FIRST_RUN_SECTION_ID}" section`).toBeDefined();
    expect(section!.body).toContain('`firstRun`');
    // The folder spelled as the note spells it: the checkout-prefixed form the file tools report.
    const folder = `kb-checkout/${DEFAULT_KB_LAYOUT.knowledgeBaseDir}`;
    expect(section!.body).toContain(`\`${folder}/\``);
    expect(firstRunNote(folder)).toContain(`\`${folder}/\``);
    expect(section!.body).toMatch(/once per conversation/i);
  });

  it('says what to offer and that the person\'s own request comes first', () => {
    const note = firstRunNote('knowledge-base/KnowledgeBase');
    expect(note).toContain('`knowledge-base/KnowledgeBase/`');
    // True whether the starter guide is still there or someone deleted it.
    expect(note).toContain('has no pages yet');
    expect(note).toMatch(/offer to draft/);
    expect(note).toMatch(/answer that first/);
    expect(note).toContain(`\`${FIRST_RUN_SECTION_ID}\``);
  });

  it("after a starter pack, names the team's pages and says they are placeholders", () => {
    const note = firstRunNote('knowledge-base/KnowledgeBase', { name: 'Sales', suggestedPages: ['About us', 'Customers'] });
    expect(note).toContain('the Sales starter pages');
    expect(note).toMatch(/placeholders/);
    expect(note).toContain('offer to draft its first pages (About us, Customers)');
    expect(note).toMatch(/answer that first/);
    expect(note).toContain(`\`${FIRST_RUN_SECTION_ID}\``);
  });
});
