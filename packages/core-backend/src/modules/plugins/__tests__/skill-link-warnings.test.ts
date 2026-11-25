import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HEXIS_EXTENSION_NS,
  HEXIS_LINKED_SKILLS_KEY,
  linkedSkillEntries,
  linkedSkillRoots,
  readSkillRoots,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../../workspace/index.js';
import type { IAccessControl } from '../../access/index.js';
import type { ISkillService, SkillSummary } from '../../skills/index.js';
import type { IToolManualService } from '../../tool-manuals/index.js';
import { realDisk, realPluginSource } from '../../../__tests__/real-disk.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { PluginIndexService } from '../plugins.service.js';
import { PluginLinkIndex } from '../plugin-links.js';
import { SkillLinkCheck, skillLinkWarnings } from '../skill-link-warnings.js';

/**
 * A plugin.json `skills` entry that links nothing is said out loud, in the
 * same sentences on the plugin page (the listing's `linkWarnings`) and in
 * the app's save answer: one sentence per kind of fault, each naming its
 * entries in the file's order and saying what to do once. Advisory
 * everywhere: which entries count is unchanged.
 */

const KB_DIR = 'knowledge-base';
const kb = testKbContext({ kbDirName: KB_DIR });
const wsId = workspaceIdForBranch(kb.defaultBranch);
const ADMIN = 'admin@x.io';
const BOB = 'bob@x.io';

/** The entries the QA run saved, in its order: two good, three malformed, two holding no skill. */
const QA_ENTRIES = [
  'Skills/QALink/alpha',
  'Skills/QALink/beta/',
  './Skills/Design/update-website',
  '/Skills/Engineering/deploy-checklist',
  'Skills/../Plugins/Deal Desk/skills/account-research',
  'Skills/NoSuch/thing',
  'knowledge-base/Skills/Company/house-writing-standards',
];

const manifestWith = (entries: unknown[]) => ({
  name: 'skill-reviewers',
  displayName: 'Skill Reviewers',
  extensions: { [HEXIS_EXTENSION_NS]: { [HEXIS_LINKED_SKILLS_KEY]: entries } },
});

/** What the QA manifest earns a reader who can read every released skill. */
const QA_WARNINGS = [
  {
    entry: '"./Skills/Design/update-website", "/Skills/Engineering/deploy-checklist", "Skills/../Plugins/Deal Desk/skills/account-research"',
    message:
      '"./Skills/Design/update-website", "/Skills/Engineering/deploy-checklist" and "Skills/../Plugins/Deal Desk/skills/account-research" ' +
      'are not folder paths, so they are ignored. Write them like "Skills/Engineering/deploy".',
  },
  {
    entry: '"knowledge-base/Skills/Company/house-writing-standards"',
    message:
      '"knowledge-base/Skills/Company/house-writing-standards" starts with "knowledge-base/", so it links nothing. Remove "knowledge-base/".',
  },
  { entry: '"Skills/NoSuch/thing"', message: '"Skills/NoSuch/thing" has no skill in it that you can open.' },
];

/** Released skills, and who may read each: Bob reads only the QALink ones. */
const RELEASED = [
  'Skills/QALink/alpha',
  'Skills/QALink/beta',
  'Skills/Design/update-website',
  'Skills/Engineering/deploy-checklist',
  'Skills/Company/house-writing-standards',
];
const readableBy = (email: string) => (email === BOB ? RELEASED.filter((p) => p.startsWith('Skills/QALink/')) : RELEASED);

/** The catalog's rule: no caller is the unfiltered catalog; a caller gets the skills they may read. */
const skillService = {
  listSkills: async (email?: string): Promise<SkillSummary[]> =>
    (email === undefined ? RELEASED : readableBy(email)).map((path) => ({
      name: path.split('/').pop()!,
      description: '',
      path,
    })),
} as unknown as ISkillService;

describe('linkedSkillEntries', () => {
  it('reports each entry the root parser drops, with its place, and keeps the roots linkedSkillRoots keeps', () => {
    const manifest = manifestWith([...QA_ENTRIES, 'Skills\\Win\\x', 'Skills//x', 42, null, 'Skills/QALink/alpha']);
    const { roots, dropped } = linkedSkillEntries(manifest);
    expect(dropped).toEqual([
      { position: 3, entry: './Skills/Design/update-website' },
      { position: 4, entry: '/Skills/Engineering/deploy-checklist' },
      { position: 5, entry: 'Skills/../Plugins/Deal Desk/skills/account-research' },
      { position: 8, entry: 'Skills\\Win\\x' },
      { position: 9, entry: 'Skills//x' },
      { position: 10, entry: 42 },
      { position: 11, entry: null },
    ]);
    expect(roots).toEqual([
      'Skills/QALink/alpha',
      'Skills/QALink/beta',
      'Skills/NoSuch/thing',
      'knowledge-base/Skills/Company/house-writing-standards',
    ]);
    expect(linkedSkillRoots(manifest)).toEqual(roots);
  });

  it('drops nothing from a manifest or a value that holds no list', () => {
    expect(linkedSkillEntries({ name: 'x' })).toEqual({ roots: [], dropped: [] });
    expect(linkedSkillEntries(null)).toEqual({ roots: [], dropped: [] });
    expect(readSkillRoots('Skills/x')).toEqual({ roots: [], dropped: [] });
  });
});

describe('the plugin catalog', () => {
  let root: string;
  const kbRoot = () => join(root, wsId, KB_DIR);

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
  } as unknown as WorkspaceService;
  // No grant lines anywhere: the link index reports every link as needing
  // repair, which this suite does not look at.
  const access = {
    eligibleOwners: async () => ({ roles: [], users: [] }),
    eligibleWriters: async () => ({ roles: ['Admin'], users: [] }),
    eligibleReaders: async () => ({ restricted: false, roles: [], users: [] }),
    grantSources: async () => ({}),
  } as unknown as IAccessControl;

  const plugin = async (folder: string, manifest: unknown) => {
    await mkdir(join(kbRoot(), 'Plugins', folder), { recursive: true });
    await writeFile(join(kbRoot(), 'Plugins', folder, 'plugin.json'), JSON.stringify(manifest));
    await writeFile(join(kbRoot(), 'Plugins', folder, 'access.md'), '---\nread:\n  - everyone\n---\n');
  };

  const catalog = () => {
    const source = realPluginSource(realDisk(), kb);
    const links = new PluginLinkIndex(workspaceService, skillService, access, kb, source);
    const tools = { listAllSummaries: async () => [] } as unknown as IToolManualService;
    return new PluginIndexService(workspaceService, access, skillService, tools, kb, source, Date.now, links).catalog();
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skill-link-warnings-'));
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('carries the entries discovery drops, with their places, and changes nothing the entries link', async () => {
    await plugin('Skill Reviewers', manifestWith(QA_ENTRIES));
    await plugin('Clean', { name: 'clean', extensions: { [HEXIS_EXTENSION_NS]: { skills: ['Skills/QALink'] } } });

    const entries = await catalog();
    const reviewers = entries.find((p) => p.name === 'skill-reviewers')!;
    // Not as warning strings: the listing words them per reader, with the
    // roots that hold nothing (see `SkillLinkCheck.linkWarnings`).
    expect(reviewers.droppedRoots.map((d) => d.position)).toEqual([3, 4, 5]);
    expect(reviewers.warnings).toEqual([]);
    // Advisory: the entries that link something still do, and nothing else moved.
    expect(reviewers.linkedRoots).toEqual([
      'Skills/QALink/alpha',
      'Skills/QALink/beta',
      'Skills/NoSuch/thing',
      'knowledge-base/Skills/Company/house-writing-standards',
    ]);
    expect(reviewers.skillCount).toBe(2);
    expect(entries.find((p) => p.name === 'clean')!.droppedRoots).toEqual([]);
  });
});

describe('the sentences', () => {
  const words = { skillsDir: 'Skills', kbDirName: KB_DIR };

  it('says one sentence per kind of fault, its entries in the file\'s order, the advice once', () => {
    const lines = skillLinkWarnings(
      {
        dropped: [
          { position: 9, entry: '/b' },
          { position: 2, entry: './a' },
          { position: 4, entry: 42 },
        ],
        prefixed: ['knowledge-base/Skills/x'],
        empty: ['Skills/NoSuch/one', 'Skills/NoSuch/two'],
      },
      words,
    ).map((w) => w.message);
    expect(lines).toEqual([
      '"./a", entry 4 (the number 42) and "/b" are not folder paths, so they are ignored. Write them like "Skills/Engineering/deploy".',
      '"knowledge-base/Skills/x" starts with "knowledge-base/", so it links nothing. Remove "knowledge-base/".',
      '"Skills/NoSuch/one" and "Skills/NoSuch/two" have no skill in them that you can open.',
    ]);
    expect(lines.join(' ').split('Skills/Engineering/deploy')).toHaveLength(2);
  });

  it('writes each line as a sentence that starts with its entries, in the reader\'s words', () => {
    const lines = skillLinkWarnings(
      { dropped: [{ position: 1, entry: null }], prefixed: [], empty: ['Skills/x'] },
      words,
    ).map((w) => w.message);
    expect(lines).toEqual([
      'Entry 1 (empty) is not a folder path, so it is ignored. Write it like "Skills/Engineering/deploy".',
      '"Skills/x" has no skill in it that you can open.',
    ]);
    for (const line of [...lines, ...QA_WARNINGS.map((w) => w.message)]) {
      expect(line).toMatch(/^("|Entry \d+ )/);
      expect(line).toMatch(/\.$/);
      for (const jargon of ['plugin.json', 'skills entry', 'a value of type', 'linked folder', ' on ', '—']) {
        expect(line).not.toContain(jargon);
      }
    }
  });

  it('says nothing when nothing is wrong', () => {
    expect(skillLinkWarnings({ dropped: [], prefixed: [], empty: [] }, words)).toEqual([]);
  });
});

describe('SkillLinkCheck', () => {
  const check = new SkillLinkCheck(skillService, kb);
  const MANIFEST = `${KB_DIR}/Plugins/Skill Reviewers/plugin.json`;
  const save = (email: string, entries: unknown[], path = MANIFEST) =>
    check.checkSave(email, path, JSON.stringify(manifestWith(entries)));

  it('answers a save with one sentence per kind of fault, naming each entry that links nothing', async () => {
    expect(await save(ADMIN, QA_ENTRIES)).toEqual(QA_WARNINGS);
  });

  it('answers nothing for a manifest whose every entry holds a skill the saver can read', async () => {
    expect(await save(ADMIN, ['Skills/QALink', 'Skills/Design/update-website'])).toEqual([]);
  });

  it("resolves against the saver's own catalog, so it says nothing about skills they cannot read", async () => {
    // A skill Bob cannot read is not confirmed to him: his answer is the one
    // he would get for a folder with nothing in it.
    expect(await save(BOB, ['Skills/QALink/alpha', 'Skills/Engineering/deploy-checklist'])).toEqual([
      {
        entry: '"Skills/Engineering/deploy-checklist"',
        message: '"Skills/Engineering/deploy-checklist" has no skill in it that you can open.',
      },
    ]);
  });

  it('names a non-string entry by its place in the list', async () => {
    expect(await save(ADMIN, ['Skills/QALink', 7])).toEqual([
      {
        entry: 'entry 2 (the number 7)',
        message: 'Entry 2 (the number 7) is not a folder path, so it is ignored. Write it like "Skills/Engineering/deploy".',
      },
    ]);
  });

  it('has nothing to say about any other file, or a manifest that does not parse', async () => {
    expect(await save(ADMIN, QA_ENTRIES, `${KB_DIR}/Skills/QALink/alpha/plugin.json`)).toEqual([]);
    expect(await save(ADMIN, QA_ENTRIES, `${KB_DIR}/Plugins/Skill Reviewers/SKILL.md`)).toEqual([]);
    expect(await check.checkSave(ADMIN, MANIFEST, '{ "extensions": ')).toEqual([]);
  });

  it("says nothing about roots from an empty catalog, the skill service's answer when the default branch cannot be read", async () => {
    const degraded = new SkillLinkCheck({ listSkills: async () => [] }, kb);
    const warnings = await degraded.checkSave(ADMIN, MANIFEST, JSON.stringify(manifestWith(QA_ENTRIES)));
    expect(warnings).toEqual([QA_WARNINGS[0]]);
  });

  it('still names the entries that are no folder path when the catalog cannot be read', async () => {
    const failing = new SkillLinkCheck(
      {
        listSkills: async () => {
          throw new Error('catalog down');
        },
      },
      kb,
    );
    const warnings = await failing.checkSave(ADMIN, MANIFEST, JSON.stringify(manifestWith(QA_ENTRIES)));
    expect(warnings).toEqual([QA_WARNINGS[0]]);
  });

  it("answers the listing's plugins from one catalog read, per reader, the agent-path spelling included", async () => {
    const listSkills = vi.fn(skillService.listSkills);
    const lists = new SkillLinkCheck({ listSkills }, kb);
    const answers = await lists.linkWarnings(BOB, [
      { roots: ['knowledge-base/Skills/QALink/beta'], dropped: [] },
      { roots: [], dropped: [] },
      { roots: ['Skills/QALink', 'Skills/Company/house-writing-standards'], dropped: [] },
    ]);
    expect(answers.map((list) => list.map((w) => w.message))).toEqual([
      ['"knowledge-base/Skills/QALink/beta" starts with "knowledge-base/", so it links nothing. Remove "knowledge-base/".'],
      [],
      // Bob cannot read that skill: to him the folder holds none.
      ['"Skills/Company/house-writing-standards" has no skill in it that you can open.'],
    ]);
    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(listSkills).toHaveBeenCalledWith(BOB);
    // No roots at all: no catalog read, and the dropped entries are still said.
    expect(await lists.linkWarnings(BOB, [{ roots: [], dropped: [{ position: 1, entry: './x' }] }])).toEqual([
      [
        {
          entry: '"./x"',
          message: '"./x" is not a folder path, so it is ignored. Write it like "Skills/Engineering/deploy".',
        },
      ],
    ]);
    expect(listSkills).toHaveBeenCalledTimes(1);
  });
});
