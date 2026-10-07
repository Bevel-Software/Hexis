import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { defaultKbTemplateDir } from '../../../assets.js';
import { agentGuideSections } from '../../agent-guide/agent-guide.js';
import { FIRST_RUN_SECTION_ID, STARTER_GUIDE_FILE, firstRunNote, knowledgeFolderIsNew } from '../first-run.js';

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
});

describe('the firstRun note', () => {
  it('names the starter guide the template really seeds', async () => {
    const seeded = await stat(join(defaultKbTemplateDir(), 'KnowledgeBase', STARTER_GUIDE_FILE));
    expect(seeded.isFile()).toBe(true);
  });

  it('points at a section the guide has, which says what to do', async () => {
    const section = (await agentGuideSections(DEFAULT_KB_LAYOUT)).find((s) => s.id === FIRST_RUN_SECTION_ID);
    expect(section, `the guide has no "${FIRST_RUN_SECTION_ID}" section`).toBeDefined();
    expect(section!.body).toContain('`firstRun`');
    expect(section!.body).toContain(`${DEFAULT_KB_LAYOUT.knowledgeBaseDir}/`);
    expect(section!.body).toMatch(/once per conversation/i);
  });

  it('says what to offer and that the person\'s own request comes first', () => {
    const note = firstRunNote('knowledge-base/KnowledgeBase');
    expect(note).toContain('`knowledge-base/KnowledgeBase/`');
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
