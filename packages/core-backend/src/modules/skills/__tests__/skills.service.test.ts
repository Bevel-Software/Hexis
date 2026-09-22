import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { SkillService } from '../skills.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import { readFile as fsReadFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkflowHooks } from '../../workflow/workflow-hooks.js';
import { GitService } from '../../workflow/git/git.service.js';

const execFileAsync = promisify(execFile);

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
    new SkillService(workspaceService, access, KB_DIR, new NodeFs());

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
  // Retried: the version tests put a real git repository under `root`, and a
  // git child may still hold a `.git` handle for a moment on Windows.
  afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  test('lists shared skills under the Skills root alongside plugin skills', async () => {
    const shared = join(root, wsId, KB_DIR, 'Skills', 'Engineering', 'deploy');
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'SKILL.md'), '---\ndescription: Ship it.\n---\n\n# Deploy\n');
    // A skill directly under the root, no scope folder — also a skill.
    const bare = join(root, wsId, KB_DIR, 'Skills', 'triage');
    await mkdir(bare, { recursive: true });
    await writeFile(join(bare, 'SKILL.md'), '---\ndescription: Triage.\n---\n');

    const list = await svc().listSkills();
    expect(list.find((s) => s.name === 'deploy')?.path).toBe('Skills/Engineering/deploy');
    expect(list.find((s) => s.name === 'triage')?.path).toBe('Skills/triage');
    // The plugin tree is still scanned: the union is the catalog.
    expect(list.find((s) => s.name === 'rfi')?.path).toBe('Plugins/rfi');

    const res = await svc().getSkill('u@x.io', 'deploy');
    expect(res.ok && res.kind === 'skill' && res.skill.body).toContain('# Deploy');
  });

  test('honours a .bevelignore inside a root, so a build output never shadows the source', async () => {
    // A repository that commits a compiled copy of every skill beside the
    // source: without the ignore, `dist/…/rfi` would collide with `Plugins/rfi`.
    const dist = join(root, wsId, KB_DIR, 'Skills', 'dist', 'rfi');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'SKILL.md'), '---\ndescription: compiled copy\n---\n');
    await writeFile(join(root, wsId, KB_DIR, 'Skills', '.bevelignore'), 'dist/\n');

    const list = await svc().listSkills();
    expect(list.filter((s) => s.name === 'rfi').map((s) => s.path)).toEqual(['Plugins/rfi']);
    expect(list.some((s) => s.path.includes('/dist/'))).toBe(false);
  });

  test('ignores the repo-root .bevelignore: hiding a root from the file tree must not empty the catalog', async () => {
    // The seeded template hides `Plugins/` (and `Skills/`) from the Knowledge
    // tree with exactly this file. The catalog is what those roots exist for.
    await writeFile(join(root, wsId, KB_DIR, '.bevelignore'), 'Plugins/\nSkills/\n');
    const shared = join(root, wsId, KB_DIR, 'Skills', 'deploy');
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'SKILL.md'), '---\ndescription: Ship it.\n---\n');

    const list = await svc().listSkills();
    expect(list.map((s) => s.name).sort()).toEqual(['coding-guidelines', 'deploy', 'rfi']);
  });

  test('a nested .bevelignore applies beneath the folder that carries it', async () => {
    const scope = join(root, wsId, KB_DIR, 'Skills', 'Sales');
    await mkdir(join(scope, 'drafts', 'pitch'), { recursive: true });
    await mkdir(join(scope, 'pitch'), { recursive: true });
    await writeFile(join(scope, 'drafts', 'pitch', 'SKILL.md'), '---\ndescription: draft\n---\n');
    await writeFile(join(scope, 'pitch', 'SKILL.md'), '---\ndescription: released\n---\n');
    await writeFile(join(scope, '.bevelignore'), 'drafts/\n');

    const list = await svc().listSkills();
    expect(list.filter((s) => s.name === 'pitch').map((s) => s.path)).toEqual(['Skills/Sales/pitch']);
  });

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

  test('an ignored SKILL.md suppresses the skill and NEVER promotes its assets to skills', async () => {
    const rfi = join(root, wsId, KB_DIR, 'Plugins', 'rfi');
    await writeFile(join(rfi, '.bevelignore'), 'SKILL.md\n');
    await mkdir(join(rfi, 'examples'), { recursive: true });
    await writeFile(join(rfi, 'examples', 'SKILL.md'), '---\ndescription: An example, not a skill.\n---\n');
    const names = (await svc().listSkills()).map((s) => s.name);
    expect(names).not.toContain('rfi');
    expect(names).not.toContain('examples');
  });

  test('ignore rules reach a skill\'s bundled files: hidden from the listing and refused when asked for', async () => {
    const rfi = join(root, wsId, KB_DIR, 'Plugins', 'rfi');
    await writeFile(join(rfi, '.bevelignore'), 'scripts/\n');
    const res = await svc().getSkill('user@x.eu', 'rfi');
    expect(res.ok && res.kind === 'skill' ? res.skill.files : null).toEqual([]);
    expect(await svc().getSkill('user@x.eu', 'rfi', 'scripts/build_xlsx.py')).toEqual({
      ok: false,
      error: 'not_found',
    });
  });

  test('a skill that exists inline AND under the shared root resolves to the shared copy', async () => {
    const shared = join(root, wsId, KB_DIR, 'Skills', 'Ops', 'rfi');
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, 'SKILL.md'), '---\ndescription: The canonical one.\n---\n');
    const rfi = (await svc().listSkills()).find((s) => s.name === 'rfi');
    expect(rfi?.path).toBe('Skills/Ops/rfi');
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

  /**
   * The listing and the loader must never disagree about the same skill at the
   * same instant.
   *
   * The regression: `getSkill` gated on `canRead`, which reads a file's own
   * frontmatter rules off disk per call, while `listSkills` gated on
   * `canReadBatch`, which resolves them through a per-workspace memo with its
   * own lifetime. So a freshly written SKILL.md could be loadable by name and
   * absent from the listing — an author who writes a skill and then lists them
   * not seeing their own work, and an agent discovering by listing unable to
   * find a skill it could load. Both now resolve through the one batch gate.
   */
  describe('listSkills and getSkill never disagree', () => {
    /** Records which gate each surface consulted, and answers only on the batch one. */
    function splitBrain(batchVerdict: boolean) {
      const consulted: string[] = [];
      const access = {
        canRead: async () => {
          consulted.push('canRead');
          return !batchVerdict; // the OPPOSITE answer, so any use of it shows up
        },
        canReadBatch: async (_w: string, _e: string, paths: string[]) => {
          consulted.push('canReadBatch');
          return new Map(paths.map((p) => [p, batchVerdict]));
        },
      } as unknown as IAccessControl;
      return { access, consulted };
    }

    test('a skill the batch gate allows is both listed and loadable', async () => {
      const { access, consulted } = splitBrain(true);
      const service = svc(access);
      const listed = (await service.listSkills('user@x.eu')).map((s) => s.name);
      const loaded = await service.getSkill('user@x.eu', 'rfi');

      expect(listed).toContain('rfi');
      expect(loaded.ok).toBe(true);
      // The single-file gate — whose answer here is the opposite — was never
      // asked. One resolver decides both.
      expect(consulted).not.toContain('canRead');
    });

    test('a skill the batch gate denies is neither listed nor loadable', async () => {
      const { access, consulted } = splitBrain(false);
      const service = svc(access);
      const listed = (await service.listSkills('user@x.eu')).map((s) => s.name);
      const loaded = await service.getSkill('user@x.eu', 'rfi');

      expect(listed).not.toContain('rfi');
      expect(loaded).toEqual({ ok: false, error: 'forbidden' });
      expect(consulted).not.toContain('canRead');
    });

    test('a bundled file is served on the same verdict as the listing', async () => {
      const { access } = splitBrain(false);
      // Not `not_found`: the skill exists and the caller may not read it.
      expect(await svc(access).getSkill('user@x.eu', 'rfi', 'scripts/build_xlsx.py')).toEqual({
        ok: false,
        error: 'forbidden',
      });
    });
  });

  test('the version is `metadata.version` first, then `version`, then `lifecycle.version`', async () => {
    const skills = join(root, wsId, KB_DIR, 'Plugins');
    const put = async (name: string, frontmatter: string) => {
      await mkdir(join(skills, name), { recursive: true });
      await writeFile(join(skills, name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n# ${name}\n`);
    };
    await put('meta-wins', 'version: 0.9.0\nmetadata:\n  version: "2.0.0"');
    await put('lifecycle-only', 'lifecycle:\n  version: 3.1');
    await put('bare-metadata', 'metadata: notes');
    const list = await svc().listSkills();
    const version = (name: string) => list.find((s) => s.name === name)?.version;
    expect(version('meta-wins')).toBe('2.0.0');
    expect(version('rfi')).toBe('1.4.0'); // top-level `version`, no metadata
    expect(version('lifecycle-only')).toBe('3.1');
    expect(version('bare-metadata')).toBeUndefined();
  });

  /**
   * `getSkill` with a `version` reads the skill out of the default branch's
   * git history — a real repository here, driven through the real GitService,
   * because the walk (newest first, first declaring commit wins, files from
   * that commit's tree) is exactly what these assert.
   */
  describe('getSkill with a version', () => {
    let repo: string;

    const runGit = (args: string[]) =>
      execFileAsync('git', args, {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 't@x.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 't@x.com',
        },
      });
    const commit = async (message: string) => {
      await runGit(['add', '-A']);
      await runGit(['commit', '-q', '-m', message]);
    };
    const skillMd = (version: string, body: string, description = 'RFI.') =>
      `---\nname: rfi\ndescription: ${description}\nmetadata:\n  version: "${version}"\n---\n\n${body}\n`;

    const versioned = (access: IAccessControl = allowAll) => {
      const service = svc(access);
      service.setHistory(new GitService(workspaceService, new WorkflowHooks(), KB_DIR));
      return service;
    };

    beforeEach(async () => {
      repo = join(root, wsId, KB_DIR);
      const rfi = join(repo, 'Plugins', 'rfi');
      await runGit(['init', '-q', '-b', DEFAULT_BRANCH]);
      await runGit(['config', 'core.autocrlf', 'false']);
      // 1.0.0 — the body and one script; no build_xlsx.py yet.
      await rm(join(rfi, 'scripts', 'build_xlsx.py'));
      await writeFile(join(rfi, 'scripts', 'draft.py'), 'print("v1")\n');
      // A non-ASCII name: git would C-quote it on a line-based listing.
      await writeFile(join(rfi, 'scripts', 'übersicht.md'), 'v1\n');
      await writeFile(join(rfi, 'SKILL.md'), skillMd('1.0.0', '# RFI v1', 'First cut.'));
      await commit('rfi 1.0.0');
      // 1.1.0 — the script changes, draft.py stays.
      await writeFile(join(rfi, 'scripts', 'draft.py'), 'print("v1.1")\n');
      await writeFile(join(rfi, 'SKILL.md'), skillMd('1.1.0', '# RFI v1.1'));
      await commit('rfi 1.1.0');
      // An edit that keeps 1.1.0: the version's latest copy is this one.
      await writeFile(join(rfi, 'SKILL.md'), skillMd('1.1.0', '# RFI v1.1 (typo fixed)'));
      await commit('rfi 1.1.0 typo');
      // 1.4.0 — what is on disk now: the fixture body, build_xlsx.py, draft.py gone.
      await rm(join(rfi, 'scripts', 'draft.py'));
      await rm(join(rfi, 'scripts', 'übersicht.md'));
      await writeFile(join(rfi, 'scripts', 'build_xlsx.py'), 'print("xlsx")\n');
      await writeFile(join(rfi, 'SKILL.md'), RFI_SKILL);
      await commit('rfi 1.4.0');
    });

    test('serves the body, description and bundled files as they were at that version', async () => {
      const res = await versioned().getSkill('user@x.eu', 'rfi', undefined, { version: '1.0.0' });
      expect(res.ok && res.kind === 'skill').toBe(true);
      if (!res.ok || res.kind !== 'skill') return;
      expect(res.skill.version).toBe('1.0.0');
      expect(res.skill.description).toBe('First cut.');
      expect(res.skill.body).toBe('# RFI v1\n');
      expect(res.skill.files).toEqual(['Plugins/rfi/scripts/draft.py', 'Plugins/rfi/scripts/übersicht.md']);
      expect(res.skill.path).toBe('Plugins/rfi');
      const file = await versioned().getSkill('user@x.eu', 'rfi', 'scripts/übersicht.md', { version: '1.0.0' });
      expect(file.ok && file.kind === 'file' && file.file.content).toBe('v1\n');
    });

    test('a version declared by several commits answers with its most recent copy', async () => {
      const res = await versioned().getSkill('user@x.eu', 'rfi', undefined, { version: '1.1.0' });
      expect(res.ok && res.kind === 'skill' && res.skill.body).toBe('# RFI v1.1 (typo fixed)\n');
    });

    test('the current version, or no version, is served from disk', async () => {
      const now = await svc().getSkill('user@x.eu', 'rfi');
      // No history attached: were 1.4.0 looked up in git, this could not answer.
      expect(await svc().getSkill('user@x.eu', 'rfi', undefined, { version: '1.4.0' })).toEqual(now);
      expect(await svc().getSkill('user@x.eu', 'rfi', undefined, { version: '  ' })).toEqual(now);
    });

    test('a bundled file is read at that version, and one not there then is not found', async () => {
      const service = versioned();
      const file = await service.getSkill('user@x.eu', 'rfi', 'scripts/draft.py', { version: '1.0.0' });
      expect(file).toEqual({
        ok: true,
        kind: 'file',
        file: { name: 'rfi', file: 'scripts/draft.py', path: 'Plugins/rfi/scripts/draft.py', content: 'print("v1")\n' },
      });
      expect(await service.getSkill('user@x.eu', 'rfi', 'scripts/build_xlsx.py', { version: '1.0.0' })).toEqual({
        ok: false,
        error: 'not_found',
      });
      expect(await service.getSkill('user@x.eu', 'rfi', '../etc/passwd', { version: '1.0.0' })).toEqual({
        ok: false,
        error: 'invalid_file',
      });
    });

    test('a version never declared lists the ones that were, newest first', async () => {
      expect(await versioned().getSkill('user@x.eu', 'rfi', undefined, { version: '9.9.9' })).toEqual({
        ok: false,
        error: 'version_not_found',
        versions: ['1.4.0', '1.1.0', '1.0.0'],
      });
    });

    test('without a history source a version cannot be answered and lists nothing', async () => {
      expect(await svc().getSkill('user@x.eu', 'rfi', undefined, { version: '1.0.0' })).toEqual({
        ok: false,
        error: 'version_not_found',
        versions: [],
      });
    });

    test('history is gated on the caller reading the skill now', async () => {
      const denyRfi: IAccessControl = {
        canRead: async () => true,
        canReadBatch: async (_w: string, _e: string, paths: string[]) =>
          new Map(paths.map((p) => [p, !p.includes('/rfi/')])),
      } as unknown as IAccessControl;
      expect(await versioned(denyRfi).getSkill('user@x.eu', 'rfi', undefined, { version: '1.0.0' })).toEqual({
        ok: false,
        error: 'forbidden',
      });
    });
  });
});
