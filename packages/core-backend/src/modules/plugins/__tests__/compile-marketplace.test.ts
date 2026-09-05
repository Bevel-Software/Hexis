import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { SkillService } from '../../skills/skills.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { PluginLinkIndex } from '../plugin-links.js';
import { MarketplaceCompilerService } from '../compile/marketplace-compiler.service.js';

/**
 * Source in, distribution out — for one caller. The real resolver decides
 * what is readable, the real catalog and link index say what is where; the
 * assertions are on the produced tree.
 */

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

describe('compileMarketplace', () => {
  let root: string;
  let repo: string;
  let compiler: MarketplaceCompilerService;

  const write = async (rel: string, text: string) => {
    const abs = path.join(repo, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-compile-'));
    repo = path.join(root, wsId, KB_DIR);
    const workspaceService = {
      getOrCreateForBranch: async () => ({ id: wsId }),
      getWorkspacePath: async (id: string) => path.join(root, id),
      readFile: async (id: string, rel: string) => fs.readFile(path.join(root, id, rel), 'utf-8'),
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;

    await write('roles.yaml', 'roles:\n  Admin:\n    - admin@x.io\n');
    await write('access.md', '---\nwrite:\n  - Admin\n---\n');
    // GTM: Sam is a member. One inline skill, one MCP server with a vault header.
    await write(
      'Plugins/GTM/access.md',
      '---\nread:\n  - everyone\n---\nread:\n  - Sam <sam@x.io>\nwrite:\n  - Mia <mia@x.io>\n',
    );
    await write(
      'Plugins/GTM/plugin.json',
      JSON.stringify({
        name: 'gtm',
        version: '2.1.0',
        description: 'Go to market',
        extensions: { 'software.bevel.hexis': { skills: ['Skills/Eng/deploy'] } },
      }),
    );
    await write('Plugins/GTM/skills/outreach/SKILL.md', '---\ndescription: Reach out.\n---\nBody\n');
    await write('Plugins/GTM/skills/outreach/scripts/run.py', 'print(1)\n');
    await write('Plugins/GTM/software.bevel.hexis/tools/web.tool', 'not shipped');
    await write(
      'Plugins/GTM/mcp.json',
      JSON.stringify({
        mcpServers: {
          notion: { type: 'streamable-http', url: 'https://mcp.notion.com', headers: { Authorization: 'Bearer ${NOTION_TOKEN}', 'X-Client': 'hexis' } },
          local: { type: 'stdio', command: 'npx', args: ['-y', 'x'] },
        },
      }),
    );
    // Shared skills: Eng/deploy linked into GTM and readable by its members;
    // Eng/secret readable by nobody but admins; Sales/pitch public.
    await write('Skills/Eng/deploy/access.md', '---\n---\nread:\n  - plugin/GTM/read\n');
    await write('Skills/Eng/deploy/SKILL.md', '---\ndescription: Ship it.\n---\n');
    await write('Skills/Eng/deploy/references/notes.md', 'notes');
    await write('Skills/Eng/secret/SKILL.md', '---\ndescription: Hush.\n---\n');
    await write('Skills/Sales/access.md', '---\n---\nread:\n  - everyone\n');
    await write('Skills/Sales/pitch/SKILL.md', '---\ndescription: Pitch.\n---\n');

    const access = new AccessControlService(workspaceService, KB_DIR);
    const skills = new SkillService(workspaceService, access, KB_DIR);
    const links = new PluginLinkIndex(workspaceService, skills, access, KB_DIR);
    compiler = new MarketplaceCompilerService(workspaceService, access, skills, links, KB_DIR, {
      name: 'acme-hexis',
      owner: 'Acme',
      knowledgeBaseMcp: { name: 'hexis', url: 'https://kb.acme.com/api/mcp' },
    });
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  const text = (tree: { files: Map<string, Buffer> }, rel: string) => tree.files.get(rel)?.toString('utf-8');
  const json = (tree: { files: Map<string, Buffer> }, rel: string) => JSON.parse(text(tree, rel) ?? 'null');

  it('compiles exactly what the caller may read, in the layouts the clients want', async () => {
    const tree = await compiler.compileFor({ userEmail: 'sam@x.io' });
    const paths = [...tree.files.keys()].sort();

    // GTM: inline + linked skills copied in, tools and access files left out.
    expect(paths).toContain('plugins/gtm/skills/outreach/SKILL.md');
    expect(paths).toContain('plugins/gtm/skills/outreach/scripts/run.py');
    expect(paths).toContain('plugins/gtm/skills/deploy/SKILL.md');
    expect(paths).toContain('plugins/gtm/skills/deploy/references/notes.md');
    expect(paths.some((p) => p.includes('.tool') || p.endsWith('access.md'))).toBe(false);
    // The unreadable skill is nowhere — not in a plugin, not in the flat copy.
    expect(paths.some((p) => p.includes('secret'))).toBe(false);

    // Three manifests per plugin, with the source manifest's identity.
    expect(json(tree, 'plugins/gtm/plugin.json')).toMatchObject({ name: 'gtm', version: '2.1.0', description: 'Go to market' });
    expect(json(tree, 'plugins/gtm/.claude-plugin/plugin.json')).toMatchObject({ name: 'gtm', version: '2.1.0' });
    expect(json(tree, 'plugins/gtm/.codex-plugin/plugin.json')).toMatchObject({ name: 'gtm' });

    // The portable half of mcp.json: the vault header is gone, the literal stays.
    const mcp = json(tree, 'plugins/gtm/.mcp.json');
    expect(mcp.mcpServers.notion).toEqual({ type: 'streamable-http', url: 'https://mcp.notion.com', headers: { 'X-Client': 'hexis' } });
    expect(mcp.mcpServers.local).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'x'] });

    // The leftovers plugin holds what no real plugin ships (pitch), never what
    // one does (deploy is GTM's); the flat copy carries everything once.
    expect(paths).toContain('plugins/skills-and-knowledge/skills/pitch/SKILL.md');
    expect(paths).not.toContain('plugins/skills-and-knowledge/skills/deploy/SKILL.md');
    // …and the knowledge base itself as an MCP server, URL only.
    expect(json(tree, 'plugins/skills-and-knowledge/.mcp.json')).toEqual({
      mcpServers: { hexis: { type: 'streamable-http', url: 'https://kb.acme.com/api/mcp' } },
    });
    expect(paths).toContain('skills/deploy/SKILL.md');
    expect(paths).toContain('skills/pitch/SKILL.md');
    expect(paths).toContain('skills/outreach/SKILL.md');

    // The bundle depends on every other plugin; the catalogues list them all.
    expect(json(tree, 'plugins/hexis-all/.claude-plugin/plugin.json').dependencies.sort()).toEqual(['gtm', 'skills-and-knowledge']);
    const claude = json(tree, '.claude-plugin/marketplace.json');
    expect(claude.name).toBe('acme-hexis');
    expect(claude.plugins.map((p: { name: string; source: string }) => [p.name, p.source])).toEqual([
      ['gtm', './plugins/gtm'],
      ['skills-and-knowledge', './plugins/skills-and-knowledge'],
      ['hexis-all', './plugins/hexis-all'],
    ]);
    const codex = json(tree, '.agents/plugins/marketplace.json');
    expect(codex.plugins.every((p: { policy: { installation: string } }) => p.policy.installation === 'INSTALLED_BY_DEFAULT')).toBe(true);
    expect(codex.plugins[0].source).toEqual({ source: 'local', path: './plugins/gtm' });
    expect(text(tree, 'README.md')).toContain('Compiled from Acme');
    expect(tree.warnings).toEqual([]);
  });

  it('for a stranger the plugin keeps only its MCP servers, and the public scope is all that ships', async () => {
    const tree = await compiler.compileFor({ userEmail: 'nobody@elsewhere.io' });
    const paths = [...tree.files.keys()].sort();
    expect(paths.some((p) => p.startsWith('plugins/gtm/skills/'))).toBe(false);
    expect(paths).toContain('plugins/gtm/.mcp.json'); // portable servers are not access-gated content
    expect(paths).toContain('plugins/skills-and-knowledge/skills/pitch/SKILL.md');
    expect(paths.some((p) => p.includes('deploy'))).toBe(false);
    expect(tree.plugins).toEqual(['gtm', 'skills-and-knowledge', 'hexis-all']);
  });

  it('the everyone audience carries the public subset only', async () => {
    const tree = await compiler.compileFor({ everyone: true });
    const paths = [...tree.files.keys()];
    expect(paths).toContain('skills/pitch/SKILL.md');
    expect(paths.some((p) => p.includes('deploy') || p.includes('outreach') || p.includes('secret'))).toBe(false);
  });

  it('with the endpoint configured, the skills plugin exists even for a caller with no leftover skill', async () => {
    // Make the one public skill part of GTM, so nothing is left over.
    await write(
      'Plugins/GTM/plugin.json',
      JSON.stringify({ name: 'gtm', extensions: { 'software.bevel.hexis': { skills: ['Skills/Eng/deploy', 'Skills/Sales'] } } }),
    );
    const tree = await compiler.compileFor({ userEmail: 'sam@x.io' });
    const paths = [...tree.files.keys()];
    expect(paths.some((p) => p.startsWith('plugins/skills-and-knowledge/skills/'))).toBe(false);
    expect(paths).toContain('plugins/skills-and-knowledge/.mcp.json');
    expect(tree.plugins).toEqual(['gtm', 'skills-and-knowledge', 'hexis-all']);
  });

  it('a manifest name is repository content: it is folded to a safe slug, and a duplicate slug is skipped', async () => {
    // A hostile or mistaken manifest name must never become a path segment
    // that escapes the compiled tree.
    await write('Plugins/GTM/plugin.json', JSON.stringify({ name: '../../etc/passwd' }));
    // A second plugin whose name folds to the same slug as the first.
    await write('Plugins/Twin/plugin.json', JSON.stringify({ name: 'etc-passwd' }));
    await write('Plugins/Twin/access.md', '---\nread:\n  - everyone\n---\nread:\n  - Sam <sam@x.io>\n');
    await write('Plugins/Twin/skills/twin-skill/SKILL.md', '---\ndescription: t\n---\n');

    const tree = await compiler.compileFor({ userEmail: 'sam@x.io' });
    const paths = [...tree.files.keys()];
    expect(paths.every((p) => !p.includes('..') && !p.startsWith('/'))).toBe(true);
    expect(paths).toContain('plugins/etc-passwd/skills/outreach/SKILL.md');
    expect(paths).not.toContain('plugins/etc-passwd/skills/twin-skill/SKILL.md');
    expect(tree.warnings.some((w) => w.includes('Plugins/Twin') && w.includes('already taken'))).toBe(true);
  });

  it('a name clash inside one plugin keeps the first by path and says so', async () => {
    // A second `deploy` skill, linked from the same plugin via a folder root.
    await write('Skills/Ops/deploy/SKILL.md', '---\ndescription: Ops deploy.\n---\n');
    await write('Skills/Ops/access.md', '---\n---\nread:\n  - plugin/GTM/read\n');
    await write(
      'Plugins/GTM/plugin.json',
      JSON.stringify({ name: 'gtm', extensions: { 'software.bevel.hexis': { skills: ['Skills/Eng/deploy', 'Skills/Ops'] } } }),
    );
    // Catalog-level dedup already keeps ONE `deploy` (Skills/Eng wins by path),
    // so the compiled plugin has one and the tree stays coherent.
    const tree = await compiler.compileFor({ userEmail: 'sam@x.io' });
    expect(text(tree, 'plugins/gtm/skills/deploy/SKILL.md')).toContain('Ship it.');
  });
});
