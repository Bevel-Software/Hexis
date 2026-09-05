import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_BRANCH, DEFAULT_KB_LAYOUT, configureKbLayout } from '@bevel-software/platform-shared';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { SkillService } from '../../skills/skills.service.js';
import { ToolManualService } from '../../tool-manuals/tool-manuals.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { PluginIndexService } from '../plugins.service.js';
import { PluginLinkIndex } from '../plugin-links.js';
import { PluginLinksService } from '../plugin-links.service.js';
import { BundlePluginSource } from '../discovery/bundle-dialect/bundle.source.js';
import { MarketplaceCompilerService } from '../compile/marketplace-compiler.service.js';

/**
 * A customer's repository, read as-is: lowercase `skills/` and `plugins/`
 * roots, bundles at the depths their org uses, a registry with a profile
 * chain, and a committed `dist/` beside the source. Every consumer — catalog,
 * plugin index, link index, tool manuals, compiler — must read the SOURCE
 * trees and agree on what a plugin holds, with nothing written back.
 */

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

describe('bundle dialect, end to end', () => {
  let root: string;
  let repo: string;
  let access: AccessControlService;
  let skills: SkillService;
  let tools: ToolManualService;
  let links: PluginLinkIndex;
  let index: PluginIndexService;
  let compiler: MarketplaceCompilerService;
  let linkService: PluginLinksService;

  const write = async (rel: string, text: string) => {
    const abs = path.join(repo, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };

  beforeEach(async () => {
    configureKbLayout({ knowledgeBaseDir: 'docs', skillsDir: 'skills', pluginsDir: 'plugins' });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-dialect-'));
    repo = path.join(root, wsId, KB_DIR);
    const workspaceService = {
      getOrCreateForBranch: async () => ({ id: wsId }),
      getWorkspacePath: async (id: string) => path.join(root, id),
      readFile: async (id: string, rel: string) => fs.readFile(path.join(root, id, rel), 'utf-8'),
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;

    await write('roles.yaml', 'roles:\n  Admin:\n    - admin@x.io\n');
    // Their scopes decide readability; everything here is open to signed-in people.
    await write('access.md', '---\nwrite:\n  - Admin\n---\nread:\n  - everyone\n');
    await write(
      'configs/mcp/registry.json',
      JSON.stringify({
        servers: [
          { id: 'jira', config: { command: 'npx', args: ['-y', 'jira-mcp'] } },
          { id: 'confluence', config: { type: 'http', url: 'https://mcp.confluence.example' } },
        ],
        profiles: [{ id: 'base', servers: ['jira'] }, { id: 'global', servers: ['confluence'], extends: 'base' }],
      }),
    );
    // Skills at their four depths; a build output that must be ignored.
    await write('skills/functional/cluster-a/one-skill/SKILL.md', '---\nname: one-skill\ndescription: One.\nmetadata:\n  version: "1.4.0"\n  author: "acme"\n---\n');
    await write('skills/departments/business/finance/close-books/SKILL.md', '---\ndescription: Close.\n---\n');
    await write('skills/departments/engineering/shared/cluster-a/deploy/SKILL.md', '---\ndescription: Deploy.\n---\n');
    await write('skills/departments/engineering/shared/cluster-a/rollback/SKILL.md', '---\ndescription: Undo.\n---\n');
    await write('skills/departments/engineering/team-x/team-only/SKILL.md', '---\ndescription: Ours.\n---\n');
    await write('dist/docs/plugins/functional/example/skills/deploy/SKILL.md', '---\ndescription: compiled copy\n---\n');
    // Plugins: one links a cluster + a single skill; one links a department.
    await write(
      'plugins/functional/cluster-a/example-plugin/plugin.bundle.json',
      JSON.stringify({
        name: 'example-plugin',
        version: '1.3.1',
        description: 'Example',
        mcpProfile: 'global',
        interface: { displayName: 'Example Plugin' },
        sourceSkillRoots: ['skills/departments/engineering/shared/cluster-a', 'skills/functional/cluster-a/one-skill'],
      }),
    );
    await write(
      'plugins/departments/business/finance/finance-kit/plugin.bundle.json',
      JSON.stringify({ name: 'finance-kit', sourceSkillRoots: ['skills/departments/business/finance'] }),
    );

    const source = new BundlePluginSource();
    access = new AccessControlService(workspaceService, KB_DIR);
    skills = new SkillService(workspaceService, access, KB_DIR);
    tools = new ToolManualService(workspaceService, access, KB_DIR, Date.now, source);
    links = new PluginLinkIndex(workspaceService, skills, access, KB_DIR, Date.now, source);
    index = new PluginIndexService(workspaceService, access, skills, tools, KB_DIR, Date.now, links, source);
    compiler = new MarketplaceCompilerService(workspaceService, access, skills, links, KB_DIR, { name: 'acme', owner: 'Acme' }, source);
    linkService = new PluginLinksService(workspaceService, { runPendingCommit: async () => undefined }, access, skills, links, KB_DIR);
  });
  afterEach(async () => {
    configureKbLayout({ ...DEFAULT_KB_LAYOUT });
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reads the source trees: skills at any depth, plugins as skill lists, servers from the registry', async () => {
    const catalog = await skills.listSkills();
    expect(catalog.map((s) => s.name).sort()).toEqual(['close-books', 'deploy', 'one-skill', 'rollback', 'team-only']);
    expect(catalog.find((s) => s.name === 'one-skill')?.version).toBe('1.4.0');
    expect(catalog.some((s) => s.path.startsWith('dist/'))).toBe(false);

    const membership = await links.membership();
    expect(membership.byPlugin.get('example-plugin')?.linkedSkills.sort()).toEqual([
      'skills/departments/engineering/shared/cluster-a/deploy',
      'skills/departments/engineering/shared/cluster-a/rollback',
      'skills/functional/cluster-a/one-skill',
    ]);
    expect(membership.byPlugin.get('example-plugin')?.linksAreManaged).toBe(false);
    expect(membership.bySkill.get('skills/departments/business/finance/close-books')).toEqual([
      { name: 'finance-kit', linked: true, granted: true },
    ]);
    // A standalone skill is in no plugin, and that is a normal state.
    expect(membership.bySkill.get('skills/departments/engineering/team-x/team-only')).toBeUndefined();

    const plugins = await index.catalog();
    expect(plugins.map((p) => [p.name, p.skillCount, p.toolCount])).toEqual([
      ['example-plugin', 3, 2],
      ['finance-kit', 1, 0],
    ]);
    expect(plugins[0].folders).toEqual(['plugins/functional/cluster-a/example-plugin']);

    const manuals = await tools.listAllSummaries();
    expect(manuals.map((m) => m.name).sort()).toEqual(['confluence', 'jira']);
  });

  it('compiles a marketplace from the source trees, per caller', async () => {
    const tree = await compiler.compileFor({ userEmail: 'someone@x.io' });
    const paths = [...tree.files.keys()];
    expect(paths).toContain('plugins/example-plugin/skills/deploy/SKILL.md');
    expect(paths).toContain('plugins/example-plugin/skills/one-skill/SKILL.md');
    expect(paths).toContain('plugins/finance-kit/skills/close-books/SKILL.md');
    // The standalone team skill rides in the leftovers plugin; linked ones do not repeat there.
    expect(paths).toContain('plugins/skills/skills/team-only/SKILL.md');
    expect(paths).not.toContain('plugins/skills/skills/deploy/SKILL.md');
    const manifest = JSON.parse(tree.files.get('plugins/example-plugin/plugin.json')!.toString());
    expect(manifest).toMatchObject({ name: 'example-plugin', version: '1.3.1', description: 'Example' });
    const mcp = JSON.parse(tree.files.get('plugins/example-plugin/.mcp.json')!.toString());
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(['confluence', 'jira']);
    expect(paths.some((p) => p.includes('dist/'))).toBe(false);
  });

  it('never writes into the dialect: linking through hexis is refused as read-only', async () => {
    const user = { id: 'u1', email: 'admin@x.io', name: 'Admin' };
    await expect(linkService.link(user, 'example-plugin', 'skills/departments/engineering/team-x/team-only')).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'read-only-links' },
    });
    const before = await fs.readFile(path.join(repo, 'plugins/functional/cluster-a/example-plugin/plugin.bundle.json'), 'utf-8');
    expect(JSON.parse(before).sourceSkillRoots).toHaveLength(2);
  });
});
