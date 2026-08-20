import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { SkillService } from '../skills.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { readFile as fsReadFile } from 'node:fs/promises';

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

const RFI_SKILL = `---
name: rfi
version: 1.4.0
description: |
  Specialist RFI responder. Runs KB-only: every answer is
  grounded in a real knowledge-graph node.
allowed-tools:
  - Bash
  - Read
---

# /rfi: Specialist RFI Responder

You answer RFIs.
`;

describe('SkillService', () => {
  let root: string;

  // WorkspaceService stub: default-branch workspace lives at <root>/<wsId>, the
  // KB clone at <root>/<wsId>/<KB_DIR>.
  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
    readFile: async (id: string, rel: string) => fsReadFile(join(root, id, rel), 'utf-8'),
  } as unknown as WorkspaceService;

  const allowAll: IAccessControl = {
    canRead: async () => true,
    canReadBatch: async (_w: string, _e: string, paths: string[]) =>
      new Map(paths.map((p) => [p, true])),
  } as unknown as IAccessControl;

  const svc = (access: IAccessControl = allowAll) =>
    new SkillService(workspaceService, access, KB_DIR);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'skills-'));
    const skills = join(root, wsId, KB_DIR, 'Plugins');
    await mkdir(join(skills, 'rfi', 'scripts'), { recursive: true });
    await writeFile(join(skills, 'rfi', 'SKILL.md'), RFI_SKILL);
    await writeFile(join(skills, 'rfi', 'scripts', 'build_xlsx.py'), 'print("xlsx")\n');
    // A folder with no SKILL.md is not a skill.
    await mkdir(join(skills, 'not-a-skill'), { recursive: true });
    await writeFile(join(skills, 'not-a-skill', 'README.md'), '# nope\n');
    // A skill nested in a category subfolder (Plugins/Development/coding-guidelines).
    await mkdir(join(skills, 'Development', 'coding-guidelines'), { recursive: true });
    await writeFile(
      join(skills, 'Development', 'coding-guidelines', 'SKILL.md'),
      '---\nname: coding-guidelines\ndescription: Coding guidelines.\n---\n\n# Guidelines\n',
    );
    await writeFile(join(skills, 'Development', 'access.md'), '---\nwrite:\n  - Developer\n---\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  test('lists skills with a block-scalar description parsed correctly', async () => {
    const skills = await svc().listSkills();
    expect(skills).toHaveLength(2);
    const rfi = skills.find((s) => s.name === 'rfi')!;
    expect(rfi).toBeDefined();
    expect(rfi.path).toBe('Plugins/rfi');
    expect(rfi.version).toBe('1.4.0');
    expect(rfi.description).not.toBe('|');
    expect(rfi.description).toContain('Specialist RFI responder');
    expect(rfi.description).toContain('grounded in a real knowledge-graph node');
  });

  test('discovers a skill nested in a category subfolder', async () => {
    const skills = await svc().listSkills();
    const cg = skills.find((s) => s.name === 'coding-guidelines')!;
    expect(cg).toBeDefined();
    expect(cg.path).toBe('Plugins/Development/coding-guidelines');
    expect(cg.description).toBe('Coding guidelines.');

    const res = await svc().getSkill('user@x.eu', 'coding-guidelines');
    expect(res.ok).toBe(true);
    if (res.ok && res.kind === 'skill') {
      expect(res.skill.path).toBe('Plugins/Development/coding-guidelines');
      expect(res.skill.body).toContain('# Guidelines');
    }
  });

  test('refuses a colliding id (no auto-suffix) — the shared dedup rule', async () => {
    const skills = join(root, wsId, KB_DIR, 'Plugins');
    // Two skills resolve to the same id `dup` (no frontmatter id/name → folder name).
    await mkdir(join(skills, 'Zeta', 'dup'), { recursive: true });
    await writeFile(join(skills, 'Zeta', 'dup', 'SKILL.md'), '---\ndescription: zeta dup\n---\n\n# Z\n');
    await mkdir(join(skills, 'Alpha', 'dup'), { recursive: true });
    await writeFile(join(skills, 'Alpha', 'dup', 'SKILL.md'), '---\ndescription: alpha dup\n---\n\n# A\n');

    const list = await svc().listSkills();
    // Only the first (smallest path) survives; the duplicate is dropped, not suffixed.
    expect(list.filter((s) => s.name === 'dup').map((s) => s.path)).toEqual(['Plugins/Alpha/dup']);
    expect(list.find((s) => s.name === 'dup2')).toBeUndefined();

    const a = await svc().getSkill('user@x.eu', 'dup');
    expect(a.ok && a.kind === 'skill' && a.skill.path).toBe('Plugins/Alpha/dup');
  });

  test('frontmatter `id`/`name` overrides the folder name for identity', async () => {
    const skills = join(root, wsId, KB_DIR, 'Plugins');
    await mkdir(join(skills, 'folderx'), { recursive: true });
    await writeFile(join(skills, 'folderx', 'SKILL.md'), '---\nid: my_skill\ndescription: d\n---\n\n# X\n');
    const list = await svc().listSkills();
    expect(list.find((s) => s.name === 'my_skill')?.path).toBe('Plugins/folderx');
  });

  test('getSkill returns body, folder path, files and allowed-tools', async () => {
    const res = await svc().getSkill('user@x.eu', 'rfi');
    expect(res.ok).toBe(true);
    if (res.ok && res.kind === 'skill') {
      expect(res.skill.path).toBe('Plugins/rfi');
      expect(res.skill.body).toContain('# /rfi: Specialist RFI Responder');
      expect(res.skill.files).toEqual(['Plugins/rfi/scripts/build_xlsx.py']);
      expect(res.skill.allowedTools).toEqual(['Bash', 'Read']);
    }
  });

  test('getSkill with a `file` returns that bundled file content', async () => {
    const res = await svc().getSkill('user@x.eu', 'rfi', 'scripts/build_xlsx.py');
    expect(res.ok).toBe(true);
    if (res.ok && res.kind === 'file') {
      expect(res.file.path).toBe('Plugins/rfi/scripts/build_xlsx.py');
      expect(res.file.content).toContain('print("xlsx")');
    }
  });

  test('getSkill rejects an unknown skill and path-traversal file', async () => {
    expect(await svc().getSkill('user@x.eu', 'nope')).toEqual({ ok: false, error: 'not_found' });
    const trav = await svc().getSkill('user@x.eu', 'rfi', '../../etc/passwd');
    expect(trav).toEqual({ ok: false, error: 'invalid_file' });
  });

  test('listSkills filters by canRead for a given user', async () => {
    const denyRfi: IAccessControl = {
      canRead: async () => false,
      canReadBatch: async (_w: string, _e: string, paths: string[]) =>
        new Map(paths.map((p) => [p, false])),
    } as unknown as IAccessControl;
    expect(await svc(denyRfi).listSkills('user@x.eu')).toHaveLength(0);
    // No email → global set, unfiltered.
    expect(await svc(denyRfi).listSkills()).toHaveLength(2);
  });

  test('listSkills fails CLOSED: a path the checker gave no verdict for is hidden', async () => {
    // A checker that "skips" every path (returns an empty map) must hide
    // everything — a missing answer is a denial, never an exposure.
    const noVerdicts: IAccessControl = {
      canRead: async () => false,
      canReadBatch: async () => new Map<string, boolean>(),
    } as unknown as IAccessControl;
    expect(await svc(noVerdicts).listSkills('user@x.eu')).toHaveLength(0);
  });

  test('getSkill is forbidden when the user cannot read it', async () => {
    const denyRfi = {
      canRead: async () => false,
      canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, false])),
    } as unknown as IAccessControl;
    expect(await svc(denyRfi).getSkill('user@x.eu', 'rfi')).toEqual({ ok: false, error: 'forbidden' });
  });
});
