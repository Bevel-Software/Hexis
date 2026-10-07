import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_KB_LAYOUT } from '@bevel-software/platform-shared';
import { defaultStarterPacksDir } from '../../../assets.js';
import { loadStarterPacks, packProblem, readStarterPack, starterPackFiles } from '../starter-packs.js';

/**
 * Reading the packs: what makes a folder a pack, that one bad folder never
 * takes the others away, and how a pack's files map onto a deployment's
 * layout.
 */

let root = '';
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-starter-packs-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A pack.yaml with every field valid, then `over` on top. */
function manifest(id: string, over: Record<string, string> = {}): string {
  const fields: Record<string, string> = {
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    description: `Pages for ${id}.`,
    order: '5',
    firstPagePrompt: `Write the ${id} page.`,
    suggestedPages: '[About us, Glossary]',
    ...over,
  };
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

async function write(rel: string, content: string | Buffer): Promise<void> {
  const abs = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

describe('loadStarterPacks', () => {
  it('lists the valid packs in chip order, then by name', async () => {
    await write('sales/pack.yaml', manifest('sales', { order: '2' }));
    await write('engineering/pack.yaml', manifest('engineering', { order: '1' }));
    await write('general/pack.yaml', manifest('general', { name: 'Something else', order: '99' }));
    await write('README.md', '# not a pack\n');

    const packs = await loadStarterPacks(root);

    expect(packs.map((p) => p.id)).toEqual(['engineering', 'sales', 'general']);
    expect(packs[2]).toMatchObject({
      name: 'Something else',
      description: 'Pages for general.',
      order: 99,
      firstPagePrompt: 'Write the general page.',
      suggestedPages: ['About us', 'Glossary'],
      dir: path.join(root, 'general'),
    });
  });

  it('skips a folder that is not a pack and keeps offering the rest', async () => {
    await write('good/pack.yaml', manifest('good'));
    await write('no-manifest/KnowledgeBase/Page.md', '# Page\n');
    await write('broken-yaml/pack.yaml', 'id: [unclosed');
    await write('wrong-id/pack.yaml', manifest('something-else'));
    await write('no-order/pack.yaml', manifest('no-order', { order: 'soon' }));

    expect((await loadStarterPacks(root)).map((p) => p.id)).toEqual(['good']);
  });

  it('offers nothing when the folder is not there', async () => {
    expect(await loadStarterPacks(path.join(root, 'missing'))).toEqual([]);
  });

  it('the packaged packs all read as packs', async () => {
    const dirs = (await fs.readdir(defaultStarterPacksDir(), { withFileTypes: true })).filter((e) => e.isDirectory());
    const packs = await loadStarterPacks(defaultStarterPacksDir());
    expect(packs.map((p) => p.id).sort()).toEqual(dirs.map((d) => d.name).sort());
  });

  it("the packaged skills are named, described, unique across packs, and free of their upstream's install", async () => {
    const names = new Map<string, string>();
    for (const pack of await loadStarterPacks(defaultStarterPacksDir())) {
      for (const file of await starterPackFiles(pack, DEFAULT_KB_LAYOUT)) {
        if (path.posix.basename(file.repoPath) !== 'SKILL.md') continue;
        const text = file.content as string;
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
        const name = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
        expect(name, `${pack.id}: ${file.repoPath} has no name`).toBeTruthy();
        expect(frontmatter, `${pack.id}: ${file.repoPath} has no description`).toMatch(/^description:/m);
        expect(path.posix.basename(path.posix.dirname(file.repoPath)), `${file.repoPath}: folder and name differ`).toBe(name);
        expect(names.get(name!), `skill "${name}" is in two packs`).toBeUndefined();
        names.set(name!, pack.id);
        expect(text, `${file.repoPath} points into an upstream install`).not.toMatch(/~\/\.claude\/skills/);
      }
    }
    expect(names.size).toBeGreaterThan(0);
  });
});

describe('packProblem', () => {
  const complete = { id: 'x', name: 'X', description: 'd', firstPagePrompt: 'p', order: 1, suggestedPages: ['A'] };

  it.each([
    ['not a mapping', ['a list'], 'x', 'mapping'],
    ['an id that is not kebab-case', { ...complete, id: 'Sales' }, 'Sales', '`id`'],
    ['an id that is not the folder', complete, 'y', "folder's name"],
    ['the reserved skip', { ...complete, id: 'none' }, 'none', 'reserved'],
    ['a missing name', { ...complete, name: undefined }, 'x', '`name`'],
    ['a blank first-page prompt', { ...complete, firstPagePrompt: '  ' }, 'x', '`firstPagePrompt`'],
    ['an order that is not a number', { ...complete, order: '1' }, 'x', '`order`'],
    ['suggested pages that are not names', { ...complete, suggestedPages: [3] }, 'x', '`suggestedPages`'],
  ])('refuses %s', (_label, value, folder, mentions) => {
    expect(packProblem(value, folder)).toContain(mentions);
  });

  it('accepts a complete manifest', () => {
    expect(packProblem(complete, 'x')).toBeNull();
  });
});

describe('starterPackFiles', () => {
  it('writes the pack under the layout in effect, rendered, and leaves everything else behind', async () => {
    await write('eng/pack.yaml', manifest('eng'));
    await write('eng/notes.md', 'for whoever maintains the pack\n');
    await write('eng/KnowledgeBase/About us.md', '# About us\n\nSee {{pluginsDir}}/eng-starter.\n');
    await write('eng/KnowledgeBase/.DS_Store', 'junk');
    await write('eng/Plugins/eng-starter/skills/review/SKILL.md', '---\nname: review\n---\n');
    await write('eng/Plugins/eng-starter/logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
    await write('eng/Skills/Shared/tidy/SKILL.md', '---\nname: tidy\n---\n');
    const pack = (await readStarterPack(path.join(root, 'eng')))!;

    const files = await starterPackFiles(pack, {
      ...DEFAULT_KB_LAYOUT,
      knowledgeBaseDir: 'Wiki',
      pluginsDir: 'Teams',
      skillsDir: 'Playbooks',
    });

    expect(files.map((f) => [f.root, f.repoPath])).toEqual([
      ['KnowledgeBase', 'Wiki/About us.md'],
      ['Plugins', 'Teams/eng-starter/logo.png'],
      ['Plugins', 'Teams/eng-starter/skills/review/SKILL.md'],
      ['Skills', 'Playbooks/Shared/tidy/SKILL.md'],
    ]);
    // Text is rendered for the layout; a binary file is copied as it is.
    expect(files[0]!.content).toBe('# About us\n\nSee Teams/eng-starter.\n');
    expect(Buffer.isBuffer(files[1]!.content)).toBe(true);
  });
});
