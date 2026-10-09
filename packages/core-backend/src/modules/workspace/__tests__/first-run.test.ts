import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { defaultKbTemplateDir } from '../../../assets.js';
import { agentGuideSections } from '../../agent-guide/agent-guide.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import {
  FIRST_RUN_SECTION_ID,
  FOLDER_BUDGET,
  STARTER_GUIDE_FILE,
  firstRunNote,
  knowledgeFolderIsNew,
  type MayRead,
} from '../first-run.js';

/**
 * What makes a knowledge base "new" for the `firstRun` note: nothing in its
 * knowledge folder but the starter guide the template seeds. Pinned here on a
 * real checkout; the route that returns the note is exercised in
 * workspace.tools.test.ts.
 */
describe('knowledgeFolderIsNew', () => {
  const disk = new NodeFs();
  const KNOWLEDGE = 'KnowledgeBase';
  /** The checkout, and its knowledge folder. */
  let repo = '';
  let dir = '';
  const isNew = (starter?: ReadonlyMap<string, string>, mayRead?: MayRead) =>
    knowledgeFolderIsNew(disk, repo, KNOWLEDGE, starter, mayRead);
  const everyone: MayRead = async (rels) => new Map(rels.map((rel) => [rel, true]));

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'bevel-first-run-unit-'));
    dir = join(repo, KNOWLEDGE);
    await mkdir(dir);
    await writeFile(join(dir, STARTER_GUIDE_FILE), '# How to get started\n');
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('is new with only the starter guide', async () => {
    expect(await isNew()).toBe(true);
  });

  it('is new with nothing at all: a starter guide someone deleted leaves an empty knowledge base', async () => {
    await rm(join(dir, STARTER_GUIDE_FILE));
    expect(await isNew()).toBe(true);
  });

  it('passes over empty folders, their placeholders, dot-files and access rules', async () => {
    await mkdir(join(dir, 'Customers', 'Archive'), { recursive: true });
    await writeFile(join(dir, 'Customers', '.gitkeep'), '');
    await writeFile(join(dir, 'Customers', 'access.md'), '# Access\n');
    await writeFile(join(dir, '.DS_Store'), '');
    expect(await isNew()).toBe(true);
  });

  it('is not new once a page sits beside the starter guide', async () => {
    await writeFile(join(dir, 'Glossary.md'), '# Glossary\n');
    expect(await isNew()).toBe(false);
  });

  it('is not new once a page sits in a folder, of any kind', async () => {
    await mkdir(join(dir, 'Products'), { recursive: true });
    await writeFile(join(dir, 'Products', 'Pricing.pdf'), 'bytes');
    expect(await isNew()).toBe(false);
  });

  it('counts a file named like the starter guide below the top as a page', async () => {
    await mkdir(join(dir, 'Team'), { recursive: true });
    await writeFile(join(dir, 'Team', STARTER_GUIDE_FILE), '# Our own onboarding\n');
    expect(await isNew()).toBe(false);
  });

  it('is not new when the folder is not there: a shape the template never made is not greeted', async () => {
    expect(await knowledgeFolderIsNew(disk, repo, 'missing')).toBe(false);
  });

  it('passes over a starter pack page that still holds what the pack wrote, line endings aside', async () => {
    await mkdir(join(dir, 'Team'), { recursive: true });
    await writeFile(join(dir, 'About us.md'), '# About us\r\n\r\nAsk your agent: _Draft this_\r\n');
    await writeFile(join(dir, 'Team', 'Glossary.md'), '# Glossary\n');
    const starter = new Map([
      ['About us.md', '# About us\n\nAsk your agent: _Draft this_\n'],
      ['Team/Glossary.md', '# Glossary\n'],
    ]);
    expect(await isNew(starter)).toBe(true);
    // The same pages count without the pack to recognise them by.
    expect(await isNew()).toBe(false);
  });

  it('is not new once someone fills a starter page in', async () => {
    await writeFile(join(dir, 'About us.md'), '# About us\n\nWe make bicycles.\n');
    expect(await isNew(new Map([['About us.md', '# About us\n']]))).toBe(false);
  });

  it('sees what the explorer sees: a page a `.bevelignore` hides, in the folder or at the repository root, is not there', async () => {
    await mkdir(join(dir, 'Drafts'), { recursive: true });
    await writeFile(join(dir, 'Drafts', 'Plan.md'), '# Plan\n');
    await writeFile(join(dir, '.bevelignore'), 'Drafts/\n');
    expect(await isNew()).toBe(true);
    // The rules above the folder apply on the way down as well.
    await rm(join(dir, '.bevelignore'));
    expect(await isNew()).toBe(false);
    await writeFile(join(repo, '.bevelignore'), 'Drafts/\n');
    expect(await isNew()).toBe(true);
    // A knowledge folder the root's rules hide is one the explorer never enters: not greeted.
    await writeFile(join(repo, '.bevelignore'), `${KNOWLEDGE}/\n`);
    expect(await isNew()).toBe(false);
  });

  it("answers for the caller when asked to: a page they may not read does not make the folder old for them", async () => {
    await mkdir(join(dir, 'Leadership'), { recursive: true });
    await writeFile(join(dir, 'Leadership', 'Plan.md'), '# Plan\n');
    const seen: string[][] = [];
    const nobody: MayRead = async (rels) => {
      seen.push(rels);
      return new Map(rels.map((rel) => [rel, false]));
    };
    expect(await isNew(undefined, nobody)).toBe(true);
    // Asked about the page, and only the page: folders are entered, not judged.
    expect(seen).toEqual([['Leadership/Plan.md']]);

    expect(await isNew(undefined, everyone)).toBe(false);
    // Without anyone to ask, a page is a page.
    expect(await isNew()).toBe(false);
  });

  it("enters every folder, as the agent's listing shows every folder: a page a deeper rule opens counts", async () => {
    await mkdir(join(dir, 'Leadership', 'Shared'), { recursive: true });
    await writeFile(join(dir, 'Leadership', 'Plan.md'), '# Plan\n');
    await writeFile(join(dir, 'Leadership', 'Shared', 'Note.md'), '# Note\n');
    const asked: string[][] = [];
    const sharedOnly: MayRead = async (rels) => {
      asked.push(rels);
      return new Map(rels.map((rel) => [rel, rel === 'Leadership/Shared/Note.md']));
    };
    expect(await isNew(undefined, sharedOnly)).toBe(false);
    // Each folder's pages in turn; the readable one ends the walk.
    expect(asked).toEqual([['Leadership/Plan.md'], ['Leadership/Shared/Note.md']]);
  });

  it('counts nothing the caller may not read, however much of it there is', async () => {
    const many = 1001;
    await Promise.all(Array.from({ length: many }, (_, i) => writeFile(join(dir, `Secret-${i}.md`), '# Secret\n')));
    const asked: number[] = [];
    const nobody: MayRead = async (rels) => {
      asked.push(rels.length);
      return new Map(rels.map((rel) => [rel, false]));
    };
    expect(await isNew(undefined, nobody)).toBe(true);
    // Judged in chunks, every one of them.
    expect(asked.reduce((n, k) => n + k, 0)).toBe(many);
    expect(Math.max(...asked)).toBeLessThanOrEqual(200);
    // One the caller may read, anywhere among them, and the folder is old.
    const justOne: MayRead = async (rels) => new Map(rels.map((rel) => [rel, rel === `Secret-${many - 1}.md`]));
    expect(await isNew(undefined, justOne)).toBe(false);
  });

  it('stops at its folder budget: that many folders and no page is not a new knowledge base', async () => {
    // The knowledge folder itself counts, so this many below it is one over.
    await Promise.all(Array.from({ length: FOLDER_BUDGET }, (_, i) => mkdir(join(dir, `Team-${i}`), { recursive: true })));
    expect(await isNew()).toBe(false);
    // Nobody is asked about a folder: with no page in sight the budget alone answers.
    const asked: string[][] = [];
    const nobody: MayRead = async (rels) => {
      asked.push(rels);
      return new Map(rels.map((rel) => [rel, false]));
    };
    expect(await isNew(undefined, nobody)).toBe(false);
    expect(asked).toEqual([]);
    // One fewer, and the walk lists them all.
    await rm(join(dir, 'Team-0'), { recursive: true });
    expect(await isNew()).toBe(true);
  });

  it('passes a link over by kind: not a page, never read through, never asked about', async () => {
    try {
      await symlink(join(tmpdir(), 'elsewhere.md'), join(dir, 'Alias.md'));
    } catch {
      return; // no symlinks on this machine: nothing to pass over
    }
    const asked: string[][] = [];
    const everyoneAsked: MayRead = async (rels) => {
      asked.push(rels);
      return new Map(rels.map((rel) => [rel, true]));
    };
    expect(await isNew(undefined, everyoneAsked)).toBe(true);
    expect(asked).toEqual([]);
    expect(await isNew()).toBe(true);
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
