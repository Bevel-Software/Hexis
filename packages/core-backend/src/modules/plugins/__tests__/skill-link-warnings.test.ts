import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HEXIS_EXTENSION_NS,
  HEXIS_LINKED_SKILLS_KEY,
  linkedSkillEntries,
  linkedSkillRoots,
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
import { SkillLinkCheck } from '../skill-link-warnings.js';

/**
 * A plugin.json `skills` entry that links nothing is said out loud: on the
 * plugin page (the catalog's `warnings` for a dropped entry, the listing's
 * per-reader line for a root holding nothing) and on the app's save answer.
 * Advisory everywhere: which entries count is unchanged.
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

const ignored = (entry: string) =>
  `skills entry ${JSON.stringify(entry)} is ignored: use a folder path like "Skills/Engineering/deploy"`;

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
  it('reports each entry the root parser drops, as written, and keeps the roots linkedSkillRoots keeps', () => {
    const manifest = manifestWith([...QA_ENTRIES, 'Skills\\Win\\x', 'Skills//x', 42, null, 'Skills/QALink/alpha']);
    const { roots, dropped } = linkedSkillEntries(manifest);
    expect(dropped).toEqual([
      './Skills/Design/update-website',
      '/Skills/Engineering/deploy-checklist',
      'Skills/../Plugins/Deal Desk/skills/account-research',
      'Skills\\Win\\x',
      'Skills//x',
      42,
      null,
    ]);
    expect(roots).toEqual([
      'Skills/QALink/alpha',
      'Skills/QALink/beta',
      'Skills/NoSuch/thing',
      'knowledge-base/Skills/Company/house-writing-standards',
    ]);
    expect(linkedSkillRoots(manifest)).toEqual(roots);
  });

  it('drops nothing from a manifest that links nothing', () => {
    expect(linkedSkillEntries({ name: 'x' })).toEqual({ roots: [], dropped: [] });
    expect(linkedSkillEntries(null)).toEqual({ roots: [], dropped: [] });
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

  it('carries each entry discovery drops as a warning naming it, and changes nothing the entries link', async () => {
    await plugin('Skill Reviewers', manifestWith(QA_ENTRIES));
    await plugin('Clean', { name: 'clean', extensions: { [HEXIS_EXTENSION_NS]: { skills: ['Skills/QALink'] } } });

    const entries = await catalog();
    const reviewers = entries.find((p) => p.name === 'skill-reviewers')!;
    // The roots that hold nothing are not the catalog's to say: that answer
    // depends on who reads it (see the listing route and `SkillLinkCheck`).
    expect(reviewers.warnings).toEqual([
      `plugin.json ${ignored('./Skills/Design/update-website')}`,
      `plugin.json ${ignored('/Skills/Engineering/deploy-checklist')}`,
      `plugin.json ${ignored('Skills/../Plugins/Deal Desk/skills/account-research')}`,
    ]);
    // Advisory: the entries that link something still do, and nothing else moved.
    expect(reviewers.linkedRoots).toEqual([
      'Skills/QALink/alpha',
      'Skills/QALink/beta',
      'Skills/NoSuch/thing',
      'knowledge-base/Skills/Company/house-writing-standards',
    ]);
    expect(reviewers.skillCount).toBe(2);
    expect(entries.find((p) => p.name === 'clean')!.warnings).toEqual([]);
  });
});

describe('SkillLinkCheck', () => {
  const check = new SkillLinkCheck(skillService, kb);
  const MANIFEST = `${KB_DIR}/Plugins/Skill Reviewers/plugin.json`;
  const save = (email: string, entries: unknown[], path = MANIFEST) =>
    check.checkSave(email, path, JSON.stringify(manifestWith(entries)));

  it('names each entry that links nothing, for the saver', async () => {
    expect(await save(ADMIN, QA_ENTRIES)).toEqual([
      { entry: './Skills/Design/update-website', message: ignored('./Skills/Design/update-website') },
      { entry: '/Skills/Engineering/deploy-checklist', message: ignored('/Skills/Engineering/deploy-checklist') },
      {
        entry: 'Skills/../Plugins/Deal Desk/skills/account-research',
        message: ignored('Skills/../Plugins/Deal Desk/skills/account-research'),
      },
      {
        entry: 'Skills/NoSuch/thing',
        message: 'linked folder "Skills/NoSuch/thing" holds no skill you can read on target-company-state',
      },
      {
        entry: 'knowledge-base/Skills/Company/house-writing-standards',
        message:
          'linked folder "knowledge-base/Skills/Company/house-writing-standards" holds no skill you can read on target-company-state',
      },
    ]);
  });

  it('answers nothing for a manifest whose every entry holds a skill the saver can read', async () => {
    expect(await save(ADMIN, ['Skills/QALink', 'Skills/Design/update-website'])).toEqual([]);
  });

  it("resolves against the saver's own catalog, so it says nothing about skills they cannot read", async () => {
    // A skill Bob cannot read is not confirmed to him: his answer is the one
    // he would get for a folder with nothing in it.
    expect(await save(BOB, ['Skills/QALink/alpha', 'Skills/Engineering/deploy-checklist'])).toEqual([
      {
        entry: 'Skills/Engineering/deploy-checklist',
        message: 'linked folder "Skills/Engineering/deploy-checklist" holds no skill you can read on target-company-state',
      },
    ]);
  });

  it('names a non-string entry by its type', async () => {
    const [warning] = await save(ADMIN, [7]);
    expect(warning).toEqual({
      entry: '(a value of type number)',
      message:
        'skills entry (a value of type number) is ignored: use a folder path like "Skills/Engineering/deploy"',
    });
  });

  it('has nothing to say about any other file, or a manifest that does not parse', async () => {
    expect(await save(ADMIN, QA_ENTRIES, `${KB_DIR}/Skills/QALink/alpha/plugin.json`)).toEqual([]);
    expect(await save(ADMIN, QA_ENTRIES, `${KB_DIR}/Plugins/Skill Reviewers/SKILL.md`)).toEqual([]);
    expect(await check.checkSave(ADMIN, MANIFEST, '{ "extensions": ')).toEqual([]);
  });

  it('says nothing about roots from an empty catalog, the skill service\'s answer when the default branch cannot be read', async () => {
    const degraded = new SkillLinkCheck({ listSkills: async () => [] }, kb);
    const warnings = await degraded.checkSave(ADMIN, MANIFEST, JSON.stringify(manifestWith(QA_ENTRIES)));
    expect(warnings.map((w) => w.entry)).toEqual([
      './Skills/Design/update-website',
      '/Skills/Engineering/deploy-checklist',
      'Skills/../Plugins/Deal Desk/skills/account-research',
    ]);
  });

  it('still names the malformed entries when the catalog cannot be read', async () => {
    const failing = new SkillLinkCheck(
      {
        listSkills: async () => {
          throw new Error('catalog down');
        },
      },
      kb,
    );
    const warnings = await failing.checkSave(ADMIN, MANIFEST, JSON.stringify(manifestWith(QA_ENTRIES)));
    expect(warnings.map((w) => w.entry)).toEqual([
      './Skills/Design/update-website',
      '/Skills/Engineering/deploy-checklist',
      'Skills/../Plugins/Deal Desk/skills/account-research',
    ]);
  });

  it("answers the listing's lists from one catalog read, per reader, the agent-path spelling included", async () => {
    const listSkills = vi.fn(skillService.listSkills);
    const lists = new SkillLinkCheck({ listSkills }, kb);
    const answers = await lists.emptyRootWarnings(BOB, [
      ['knowledge-base/Skills/QALink/beta'],
      [],
      ['Skills/QALink', 'Skills/Company/house-writing-standards'],
    ]);
    expect(answers.map((list) => list.map((w) => w.entry))).toEqual([
      ['knowledge-base/Skills/QALink/beta'],
      [],
      // Bob cannot read that skill: to him the folder holds none.
      ['Skills/Company/house-writing-standards'],
    ]);
    expect(listSkills).toHaveBeenCalledTimes(1);
    expect(listSkills).toHaveBeenCalledWith(BOB);
    // No roots at all: no catalog read.
    expect(await lists.emptyRootWarnings(BOB, [[], []])).toEqual([[], []]);
    expect(listSkills).toHaveBeenCalledTimes(1);
  });
});
