import { describe, it, expect } from 'vitest';
import type { FileTreeEntry, IWorkspaceService } from '@bevel-software/platform-shared';
import {
  listAccessDeclarationsUnder,
  AccessDeclarationsError,
  DECLARATION_SCAN_FILE_CAP,
} from '../access-declarations.js';

/**
 * The declaration scan: WHICH files under a folder declare access rules, and
 * what those rules literally say. Everything here is about honesty of report —
 * the folder's own summary must not be echoed back as an override, a broken
 * rule file must be visible, and a typo'd node must not take the page down.
 */

const WS = 'main';
const KB = 'knowledge-base';

/** Build the nested tree `listFiles` returns from a flat ws-path → text map. */
function buildTree(files: Record<string, string>): FileTreeEntry {
  const root: FileTreeEntry = { name: '', relativePath: '', type: 'directory', children: [] };
  for (const wsPath of Object.keys(files)) {
    const segments = wsPath.split('/');
    let node = root;
    segments.forEach((segment, i) => {
      const isLeaf = i === segments.length - 1;
      const relativePath = segments.slice(0, i + 1).join('/');
      let child = node.children?.find((c) => c.name === segment);
      if (!child) {
        child = {
          name: segment,
          relativePath,
          type: isLeaf ? 'file' : 'directory',
          ...(isLeaf ? {} : { children: [] }),
        };
        node.children?.push(child);
      }
      node = child;
    });
  }
  return root;
}

function makeWorkspace(files: Record<string, string>): IWorkspaceService {
  return {
    listFiles: async () => buildTree(files),
    readFile: async (_id: string, relativePath: string) => {
      const text = files[relativePath];
      if (text === undefined) throw new Error(`ENOENT ${relativePath}`);
      return text;
    },
  } as unknown as IWorkspaceService;
}

const scan = (files: Record<string, string>, folder = 'Groups/GTM') =>
  listAccessDeclarationsUnder(makeWorkspace(files), WS, KB, folder);

const fm = (body: string) => `---\n${body}\n---\n\n# Body\n`;

describe('listAccessDeclarationsUnder', () => {
  it('reports a descendant access.md against the directory it governs', async () => {
    const { overrides, truncated } = await scan({
      [`${KB}/Groups/GTM/battlecards/access.md`]: fm('write:\n  - GTM Team'),
    });

    expect(truncated).toBe(false);
    expect(overrides).toEqual([
      {
        path: 'Groups/GTM/battlecards/access.md',
        governs: 'Groups/GTM/battlecards',
        source: 'access-md',
        entries: [{ verb: 'write', deny: false, principal: { kind: 'role', role: 'GTM Team' } }],
      },
    ]);
  });

  it("excludes the target folder's own access.md — that is the summary, not an override", async () => {
    const { overrides } = await scan({
      [`${KB}/Groups/GTM/access.md`]: fm('read:\n  - GTM Team'),
      [`${KB}/Groups/GTM/battlecards/access.md`]: fm('read:\n  - Developer'),
    });

    expect(overrides.map((o) => o.path)).toEqual(['Groups/GTM/battlecards/access.md']);
  });

  it('reads verbs out of SKILL.md and .tool frontmatter, governing the file itself', async () => {
    const { overrides } = await scan({
      [`${KB}/Groups/GTM/outreach/SKILL.md`]: fm('nodeType: Skill\nowner: Ali <ali@bevel.software>'),
      [`${KB}/Groups/GTM/slack.tool`]: fm('write:\n  - Developer'),
    });

    expect(overrides).toEqual([
      {
        path: 'Groups/GTM/outreach/SKILL.md',
        governs: 'Groups/GTM/outreach/SKILL.md',
        source: 'frontmatter',
        entries: [
          {
            verb: 'owner',
            deny: false,
            principal: { kind: 'user', email: 'ali@bevel.software', name: 'Ali' },
          },
        ],
      },
      {
        path: 'Groups/GTM/slack.tool',
        governs: 'Groups/GTM/slack.tool',
        source: 'frontmatter',
        entries: [{ verb: 'write', deny: false, principal: { kind: 'role', role: 'Developer' } }],
      },
    ]);
  });

  it('ignores nodes whose frontmatter declares no access verb', async () => {
    const { overrides } = await scan({
      [`${KB}/Groups/GTM/outreach/SKILL.md`]: fm('nodeType: Skill\ndescription: Runs outreach'),
    });

    expect(overrides).toEqual([]);
  });

  it('preserves the deny prefix, collapses everyone, and carries user name + email', async () => {
    const { overrides } = await scan({
      [`${KB}/Groups/GTM/battlecards/access.md`]: fm(
        'read:\n  - everyone\n  - deny Bob Ruiz <bob@bevel.software>\nwrite:\n  - deny GTM Team',
      ),
    });

    expect(overrides[0].entries).toEqual([
      { verb: 'read', deny: false, principal: { kind: 'everyone' } },
      {
        verb: 'read',
        deny: true,
        principal: { kind: 'user', email: 'bob@bevel.software', name: 'Bob Ruiz' },
      },
      { verb: 'write', deny: true, principal: { kind: 'role', role: 'GTM Team' } },
    ]);
  });

  it('surfaces an unparseable access.md and silently skips an unparseable node', async () => {
    const { overrides } = await scan({
      // `read:` must be a LIST in an access.md — this file controls nothing.
      [`${KB}/Groups/GTM/battlecards/access.md`]: fm('read: GTM Team'),
      // Unterminated frontmatter on a node — forgiven, exactly like the resolver.
      [`${KB}/Groups/GTM/outreach/SKILL.md`]: '---\nowner: Ali <ali@bevel.software>\n\n# Body\n',
    });

    expect(overrides).toHaveLength(1);
    expect(overrides[0].path).toBe('Groups/GTM/battlecards/access.md');
    expect(overrides[0].entries).toEqual([]);
    expect(overrides[0].parseError).toContain("'read:' must be a list");
  });

  it('stops at the file cap and says so', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < DECLARATION_SCAN_FILE_CAP + 5; i++) {
      const n = String(i).padStart(4, '0');
      files[`${KB}/Groups/GTM/n${n}/SKILL.md`] = fm('read:\n  - Developer');
    }

    const { overrides, truncated } = await scan(files);

    expect(truncated).toBe(true);
    expect(overrides).toHaveLength(DECLARATION_SCAN_FILE_CAP);
  });

  it('returns an empty result for a folder with nothing in it', async () => {
    expect(await scan({ [`${KB}/Groups/Product/roadmap/SKILL.md`]: fm('read:\n  - Developer') }))
      .toEqual({ overrides: [], truncated: false });
  });

  it('returns an empty result for a folder that is not in the clone', async () => {
    expect(await scan({}, 'Groups/Nope')).toEqual({ overrides: [], truncated: false });
  });

  it('refuses a target that is a file', async () => {
    await expect(
      scan({ [`${KB}/Groups/GTM/slack.tool`]: fm('write:\n  - Developer') }, 'Groups/GTM/slack.tool'),
    ).rejects.toBeInstanceOf(AccessDeclarationsError);
  });

  it('sorts rows by declaring path', async () => {
    const { overrides } = await scan({
      [`${KB}/Groups/GTM/zeta.tool`]: fm('write:\n  - Developer'),
      [`${KB}/Groups/GTM/alpha/access.md`]: fm('read:\n  - Developer'),
      [`${KB}/Groups/GTM/mid/SKILL.md`]: fm('owner:\n  - Developer'),
    });

    expect(overrides.map((o) => o.path)).toEqual([
      'Groups/GTM/alpha/access.md',
      'Groups/GTM/mid/SKILL.md',
      'Groups/GTM/zeta.tool',
    ]);
  });
});
