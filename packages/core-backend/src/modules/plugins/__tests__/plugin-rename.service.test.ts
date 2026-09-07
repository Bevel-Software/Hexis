import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DEFAULT_BRANCH, type AuthUser } from '@bevel-software/platform-shared';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../../access/access-control.service.js';
import { PushNeedsAgentResolutionError } from '../../../shared/domain-errors.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { KbPluginSource } from '../discovery/kb-plugin-source.js';
import { PluginRenameError, PluginRenameService, renamePluginPrincipalInText } from '../plugin-rename.service.js';

// The walk the rename rewrites through, with a switch that makes it refuse
// exactly when asked to be strict — the way a folder it cannot list would.
const walkMock = vi.hoisted(() => ({ holeInTheWalk: false }));
vi.mock('../../../shared/fs-walk.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/fs-walk.js')>();
  return {
    ...actual,
    walkFiles: (root: string, match: (b: string) => boolean, opts?: { strict?: boolean }) => {
      if (walkMock.holeInTheWalk && opts?.strict) {
        throw new actual.WalkError('KnowledgeBase/Notes', Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      }
      return actual.walkFiles(root, match, opts);
    },
  };
});

/**
 * Renaming over a real tree: the real resolver decides who may rename and
 * who still reads afterwards, real discovery finds the plugin, and the commit
 * driver is the only thing stubbed (it records what would land).
 */

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

const manager: AuthUser = { id: 'u-mia', email: 'mia@x.io', name: 'Mia' } as AuthUser;
const member: AuthUser = { id: 'u-sam', email: 'sam@x.io', name: 'Sam' } as AuthUser;

const GTM_RULES = '---\nread:\n  - everyone\n---\nread:\n  - Sam <sam@x.io>\nwrite:\n  - Mia <mia@x.io>\nowner:\n  - Mia <mia@x.io>\n';
const GTM_MANIFEST = '{\n  "name": "gtm",\n  "version": "1.0.0"\n}\n';
// The linked skill's grants, in BOTH spellings a knowledge base may hold:
// the folder's casing from before the manifest became the identity, and the
// identifier itself.
const DEPLOY_RULES = '---\n---\nread:\n  - plugin/GTM/read\nwrite:\n  - plugin/gtm/write\n';

describe('PluginRenameService', () => {
  let root: string;
  let repo: string;
  let commits: { summary: string; paths: string[] }[];
  let failNextCommit: Error | null;
  let failWriteMatching: string | null;
  let invalidated: number;
  let access: AccessControlService;
  let svc: PluginRenameService;

  const write = async (rel: string, text: string) => {
    const abs = path.join(repo, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, text);
  };
  const read = (rel: string) => fs.readFile(path.join(repo, rel), 'utf-8');
  const manifest = async () => JSON.parse(await read('Plugins/GTM/plugin.json'));

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-rename-'));
    repo = path.join(root, wsId, KB_DIR);
    commits = [];
    failNextCommit = null;
    failWriteMatching = null;
    walkMock.holeInTheWalk = false;
    invalidated = 0;
    const workspaceService = {
      getOrCreateForBranch: async () => ({ id: wsId }),
      getWorkspacePath: async (id: string) => path.join(root, id),
      readFile: async (id: string, rel: string) => fs.readFile(path.join(root, id, rel), 'utf-8'),
      writeFile: async (id: string, rel: string, text: string) => {
        if (failWriteMatching && rel.endsWith(failWriteMatching)) {
          failWriteMatching = null;
          throw new Error('disk full');
        }
        const abs = path.join(root, id, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, text);
      },
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    const driver = {
      commitChanges: async (_ws: string, _user: AuthUser, summary: string, paths: string[]) => {
        if (failNextCommit) {
          const err = failNextCommit;
          failNextCommit = null;
          throw err;
        }
        commits.push({ summary, paths });
      },
    };

    await write('roles.yaml', 'roles:\n  Admin:\n    - admin@x.io\n');
    await write('access.md', '---\nwrite:\n  - Admin\n---\n');
    await write('Plugins/GTM/access.md', GTM_RULES);
    await write('Plugins/GTM/plugin.json', GTM_MANIFEST);
    // A scope Mia edits, holding the skill GTM is granted on.
    await write('Skills/Eng/access.md', '---\n---\nwrite:\n  - Mia <mia@x.io>\n');
    await write('Skills/Eng/deploy/access.md', DEPLOY_RULES);
    await write('Skills/Eng/deploy/SKILL.md', '---\ndescription: Ship it.\n---\n');

    access = new AccessControlService(workspaceService, KB_DIR);
    svc = new PluginRenameService(workspaceService, driver, access, new KbPluginSource(), KB_DIR, undefined, () => {
      invalidated += 1;
    });
  });
  afterEach(() => fs.rm(root, { recursive: true, force: true }));

  it('refuses to claim a name against a listing with a hole in it — an unreadable folder may hold that very plugin', async () => {
    // Discovery as the walker reports it when a folder exists but could not
    // be read: the plugins it did see, plus the hole.
    const real = new KbPluginSource();
    const holed = {
      dialect: 'kb',
      discover: async (root: string) => ({ ...(await real.discover(root)), unreadable: ['Plugins/Hidden'] }),
    };
    const svcOverHole = new PluginRenameService(
      { getWorkspacePath: async (id: string) => path.join(root, id) } as unknown as WorkspaceService,
      { commitChanges: async () => { throw new Error('must not commit'); } },
      access,
      holed,
      KB_DIR,
    );
    await expect(svcOverHole.rename(manager, 'gtm', { name: 'go-to-market' })).rejects.toMatchObject({
      status: 503,
      payload: { kind: 'incomplete-discovery', unreadable: ['Plugins/Hidden'] },
    });
    expect(await read('Plugins/GTM/plugin.json')).toBe(GTM_MANIFEST);
    expect(await read('Skills/Eng/deploy/access.md')).toBe(DEPLOY_RULES);
  });

  it('tells a NON-manager nothing about the tree — a holed discovery is still just "unknown plugin" to them', async () => {
    const real = new KbPluginSource();
    const holed = {
      dialect: 'kb',
      discover: async (root: string) => ({ ...(await real.discover(root)), unreadable: ['Plugins/Hidden'] }),
    };
    const svcOverHole = new PluginRenameService(
      { getWorkspacePath: async (id: string) => path.join(root, id) } as unknown as WorkspaceService,
      { commitChanges: async () => { throw new Error('must not commit'); } },
      access,
      holed,
      KB_DIR,
    );
    const refusal = await svcOverHole.rename(member, 'gtm', { name: 'go-to-market' }).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ status: 404, payload: { kind: 'unknown-plugin' } });
    expect(JSON.stringify(refusal)).not.toContain('Hidden');
  });

  it('a grant file it cannot open is the same hole as a folder it cannot list: refused before any write', async () => {
    const tool = 'Plugins/GTM/software.bevel.hexis/tools/web.tool';
    await write(tool, '---\nname: web\nread:\n  - plugin/gtm/read\n---\nbody\n');
    const realReadFile = fs.readFile;
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(((file: string, opts: unknown) =>
      String(file).endsWith('web.tool')
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (realReadFile as (f: string, o: unknown) => Promise<unknown>).call(fs, file, opts)) as never);
    try {
      await expect(svc.rename(manager, 'gtm', { name: 'go-to-market' })).rejects.toMatchObject({
        status: 503,
        payload: { kind: 'incomplete-discovery', unreadable: [tool] },
      });
    } finally {
      spy.mockRestore();
    }
    expect(await read('Plugins/GTM/plugin.json')).toBe(GTM_MANIFEST);
    expect(await read('Skills/Eng/deploy/access.md')).toBe(DEPLOY_RULES);
    expect(commits).toEqual([]);
  });

  it('renames the identifier: the manifest and every grant that spells the old one, in ONE commit', async () => {
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);

    const result = await svc.rename(manager, 'gtm', { name: 'go-to-market' });
    expect(result).toEqual({ name: 'go-to-market', displayName: 'GTM', rewritten: ['Skills/Eng/deploy/access.md'] });

    // The manifest keeps everything else it had.
    expect(await manifest()).toEqual({ name: 'go-to-market', version: '1.0.0' });
    // Both spellings became the one new one; the file's shape is otherwise untouched.
    expect(await read('Skills/Eng/deploy/access.md')).toBe(
      '---\n---\nread:\n  - plugin/go-to-market/read\nwrite:\n  - plugin/go-to-market/write\n',
    );
    expect(commits).toEqual([
      {
        summary: 'Rename plugin gtm to go-to-market',
        paths: [`${KB_DIR}/Plugins/GTM/plugin.json`, `${KB_DIR}/Skills/Eng/deploy/access.md`],
      },
    ]);
    // The point of it all: the same people hold the same verbs through the new spelling.
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);
    expect(await access.canWrite(wsId, manager.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);
    expect(invalidated).toBe(1);
    // The old spelling now names nobody: a stale grant somewhere else grants nothing.
    await write('Skills/Eng/deploy/access.md', DEPLOY_RULES);
    access.invalidate(wsId);
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(false);
  });

  it('changes the display name without touching a single grant, and stores none that equals the folder', async () => {
    await svc.rename(manager, 'gtm', { displayName: '  Go To Market ' });
    expect(await manifest()).toEqual({ name: 'gtm', version: '1.0.0', displayName: 'Go To Market' });
    expect(await read('Skills/Eng/deploy/access.md')).toBe(DEPLOY_RULES);
    expect(commits).toEqual([{ summary: 'Rename plugin gtm: display name', paths: [`${KB_DIR}/Plugins/GTM/plugin.json`] }]);

    // The folder name is the default label — writing it down would only be noise.
    await svc.rename(manager, 'gtm', { displayName: 'GTM' });
    expect(await manifest()).toEqual({ name: 'gtm', version: '1.0.0' });
  });

  it('judges only a NEW identifier: a plugin whose manifest already wears the reserved prefix can still change its display name', async () => {
    // Hand-written before the rule existed; the folder is not a personal shelf.
    await write('Plugins/Legacy/plugin.json', '{"name":"personal-legacy"}');
    await write('Plugins/Legacy/access.md', GTM_RULES);
    await svc.rename(manager, 'personal-legacy', { displayName: 'Legacy Team' });
    expect(JSON.parse(await read('Plugins/Legacy/plugin.json'))).toEqual({ name: 'personal-legacy', displayName: 'Legacy Team' });
    // Moving it to ANOTHER reserved name is still refused; moving it out of the namespace is fine.
    await expect(svc.rename(manager, 'personal-legacy', { name: 'personal-other' })).rejects.toMatchObject({ payload: { kind: 'bad-name' } });
    await svc.rename(manager, 'personal-legacy', { name: 'legacy' });
    expect(JSON.parse(await read('Plugins/Legacy/plugin.json')).name).toBe('legacy');
  });

  it('is fail-closed: a member, an unknown name, and the folder spelled as a name all get the same 404', async () => {
    for (const [user, name] of [
      [member, 'gtm'],
      [manager, 'ghost'],
      [manager, 'GTM'],
    ] as const) {
      await expect(svc.rename(user, name, { name: 'x' })).rejects.toMatchObject({ status: 404, payload: { kind: 'unknown-plugin' } });
    }
    expect(commits).toEqual([]);
  });

  it('refuses an identifier that is not one, a personal one, or one already taken — writing nothing', async () => {
    await write('Plugins/Ops/plugin.json', '{"name":"ops"}');
    await write('Plugins/Ops/access.md', GTM_RULES);
    for (const [name, kind] of [
      ['Sales Team', 'bad-name'],
      ['sales--team', 'bad-name'],
      ['personal-mia', 'bad-name'],
      // Kebab-case but longer than the slug the marketplace keys on: not its own slug.
      [`${'a'.repeat(60)}-${'b'.repeat(10)}`, 'bad-name'],
      ['ops', 'name-taken'],
    ] as const) {
      await expect(svc.rename(manager, 'gtm', { name })).rejects.toMatchObject({ payload: { kind } });
    }
    expect(await read('Plugins/GTM/plugin.json')).toBe(GTM_MANIFEST);
    expect(commits).toEqual([]);
  });

  it('refuses — before writing anything — when a grant sits in a file the caller cannot edit, and names it', async () => {
    // A knowledge page whose own frontmatter names the plugin; only admins write there.
    await write('KnowledgeBase/Notes/access.md', '---\nread:\n  - plugin/gtm/read\n---\n');
    access.invalidate(wsId);

    await expect(svc.rename(manager, 'gtm', { name: 'go-to-market' })).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'needs-write', files: ['KnowledgeBase/Notes/access.md'] },
    });
    expect(await read('Plugins/GTM/plugin.json')).toBe(GTM_MANIFEST);
    expect(await read('Skills/Eng/deploy/access.md')).toBe(DEPLOY_RULES);
    expect(commits).toEqual([]);
  });

  it('puts every file back when the commit is refused, so a retry starts from what origin has', async () => {
    failNextCommit = new Error('push refused');
    await expect(svc.rename(manager, 'gtm', { name: 'go-to-market' })).rejects.toThrow('push refused');
    expect(await read('Plugins/GTM/plugin.json')).toBe(GTM_MANIFEST);
    expect(await read('Skills/Eng/deploy/access.md')).toBe(DEPLOY_RULES);
    expect(invalidated).toBe(0);

    await svc.rename(manager, 'gtm', { name: 'go-to-market' });
    expect((await manifest()).name).toBe('go-to-market');
  });

  it('a name is taken by SLUG: a bundle spelled "Sales Team" already holds sales-team', async () => {
    await write('Plugins/Ext/plugin.bundle.json', '{"name":"Sales Team"}');
    await expect(svc.rename(manager, 'gtm', { name: 'sales-team' })).rejects.toMatchObject({
      status: 409,
      payload: { kind: 'name-taken' },
    });
    expect(commits).toEqual([]);
  });

  it('rewrites the grant in every file kind the resolver reads from — a .tool frontmatter included', async () => {
    const tool = 'Plugins/GTM/software.bevel.hexis/tools/web.tool';
    await write(tool, '---\nname: web\nread:\n  - plugin/gtm/read\n---\nbody\n');
    const result = await svc.rename(manager, 'gtm', { name: 'go-to-market' });
    expect(result.rewritten).toEqual([tool, 'Skills/Eng/deploy/access.md']);
    expect(await read(tool)).toBe('---\nname: web\nread:\n  - plugin/go-to-market/read\n---\nbody\n');
  });

  it('walks exactly what the resolver reads: an unreadable node_modules is no hole, because no grant could live there', async () => {
    await write('node_modules/some-dep/access.md', '---\n---\nread:\n  - plugin/gtm/read\n');
    const realReaddir = fs.readdir;
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(((dir: string, opts: unknown) =>
      String(dir).endsWith('node_modules')
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (realReaddir as (d: string, o: unknown) => Promise<unknown>).call(fs, dir, opts)) as never);
    try {
      const result = await svc.rename(manager, 'gtm', { name: 'go-to-market' });
      // The grant under node_modules is neither rewritten nor a reason to refuse: the resolver never reads it.
      expect(result.rewritten).toEqual(['Skills/Eng/deploy/access.md']);
    } finally {
      spy.mockRestore();
    }
  });

  it('a folder it cannot list stops the rename before a byte is written', async () => {
    walkMock.holeInTheWalk = true;
    // The same refusal as a discovery hole — a 503 naming the folder, never a raw errno.
    await expect(svc.rename(manager, 'gtm', { name: 'go-to-market' })).rejects.toMatchObject({
      status: 503,
      payload: { kind: 'incomplete-discovery', unreadable: ['KnowledgeBase/Notes'] },
    });
    expect(await read('Plugins/GTM/plugin.json')).toBe(GTM_MANIFEST);
    expect(await read('Skills/Eng/deploy/access.md')).toBe(DEPLOY_RULES);
    expect(commits).toEqual([]);
  });

  it('puts every file back when a write in the batch fails — the ones already written included', async () => {
    failWriteMatching = 'Skills/Eng/deploy/access.md';
    await expect(svc.rename(manager, 'gtm', { name: 'go-to-market' })).rejects.toThrow('disk full');
    expect(await read('Plugins/GTM/plugin.json')).toBe(GTM_MANIFEST);
    expect(await read('Skills/Eng/deploy/access.md')).toBe(DEPLOY_RULES);
    expect(commits).toEqual([]);
  });

  it('leaves a rename that COMMITTED but could not push alone — the recovery flow owns that state', async () => {
    failNextCommit = new PushNeedsAgentResolutionError(DEFAULT_BRANCH, 'Plugins/GTM/plugin.json', 'rejected', 'n/a');
    await expect(svc.rename(manager, 'gtm', { name: 'go-to-market' })).rejects.toBeInstanceOf(PushNeedsAgentResolutionError);
    // Restoring the old bytes here would stack an uncommitted inverse on a
    // real commit; the working tree stays as the commit left it — and since
    // it changed, the caches keyed on the old identity are dropped as on success.
    expect((await manifest()).name).toBe('go-to-market');
    expect(await read('Skills/Eng/deploy/access.md')).toContain('plugin/go-to-market/read');
    expect(invalidated).toBe(1);
    expect(await access.canRead(wsId, member.email, 'Skills/Eng/deploy/SKILL.md')).toBe(true);
  });

  it('will not rename a plugin read from an external format — that repository owns its name', async () => {
    await write('Plugins/Ext/plugin.bundle.json', '{"name":"ext"}');
    await write('Plugins/Ext/access.md', GTM_RULES);
    await expect(svc.rename(manager, 'ext', { name: 'ext-2' })).rejects.toBeInstanceOf(PluginRenameError);
    await expect(svc.rename(manager, 'ext', { name: 'ext-2' })).rejects.toMatchObject({ status: 409, payload: { kind: 'read-only' } });
  });
});

describe('renamePluginPrincipalInText', () => {
  it('rewrites every access entry naming the plugin, in any accepted spelling, and nothing else', () => {
    const text = [
      '---',
      'read:',
      '  - plugin/GTM/read',
      '  - deny plugin/gtm/write',
      '---',
      'read:',
      '  - plugin/gtm-x/read',
      '  - Sam <sam@x.io>',
      'Mention plugin/gtm/read in prose, and leave it.',
      '',
    ].join('\n');
    expect(renamePluginPrincipalInText(text, 'gtm', 'go-to-market')).toBe(
      [
        '---',
        'read:',
        '  - plugin/go-to-market/read',
        '  - deny plugin/go-to-market/write',
        '---',
        'read:',
        '  - plugin/gtm-x/read',
        '  - Sam <sam@x.io>',
        'Mention plugin/gtm/read in prose, and leave it.',
        '',
      ].join('\n'),
    );
  });

  it('keeps the line endings it was given', () => {
    expect(renamePluginPrincipalInText('read:\r\n  - plugin/gtm/read\r\n', 'gtm', 'g2')).toBe('read:\r\n  - plugin/g2/read\r\n');
  });
});
