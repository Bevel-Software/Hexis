import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { WorkflowService } from '../../workflow/workflow.service.js';
import type { AuthUser } from '@bevel-software/platform-shared';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { PushNeedsAgentResolutionError } from '../../../shared/domain-errors.js';
import type { ITreeWalker } from '../../../shared/fs.contract.js';
import { AccessControlService } from '../access-control.service.js';
import {
  UserAccessRemovalService,
  countUserEntriesInAccessText,
  removeEmailListLines,
  removeUserFromAccessText,
} from '../user-access-removal.service.js';

const KB = 'knowledge-base';
const TEMPLATE_BEVELIGNORE = fileURLToPath(new URL('../../../../kb-template/.bevelignore', import.meta.url));
const ADMIN: AuthUser = { id: 'u-admin', email: 'admin@x.io', name: 'Admin' } as AuthUser;
const LEE = 'lee@x.io';

// The seeded header comments must survive the edit.
const ROLES_HEADER = '# Identity → role mapping for access control.\n# only Admins may edit this file.\n';
const ROLES = `${ROLES_HEADER}roles:\n  Admin:\n    - admin@x.io\n    - lee@x.io\n  Reviewer:\n    - lee@x.io\n    - rev@x.io\n`;
const GROUPS = `groups:\n  Product:\n    - Lee@x.io\n    - felix@x.io\n  GTM Team:\n    - sara@x.io\n`;
const ROOT_ACCESS = '---\nwrite:\n  - Admin\n---\n# The knowledge base\n\n- Lee <lee@x.io> is mentioned in prose\n';
// Body-governed access.md: the frontmatter governs the file, the body the folder.
const SALES_ACCESS =
  '---\nwrite:\n  - Lee <lee@x.io>\n---\nread:\n  - Lee <lee@x.io>  # sales lead\n  - Sara <sara@x.io>\nowner:\n  - deny Lee <lee@x.io>\n';
const NODE = '---\nnodeType: note\nowner: Lee <lee@x.io>\nread:\n  - Product\n---\n# Plan\n\nowner: Lee <lee@x.io>\n';

async function write(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

function stubWorkspace(workspaceDir: string): WorkspaceService {
  const resolve = (wsRel: string) => path.join(workspaceDir, wsRel);
  return {
    getWorkspacePath: async () => workspaceDir,
    getOrCreateForBranch: async () => ({}) as unknown,
    // The real listFiles honours .bevelignore, and the seeded template hides
    // every access.md and roles.yaml — a scan built on it finds no rule at
    // all. The service must walk the disk instead, so this stub refuses.
    listFiles: async () => {
      throw new Error('listFiles honours .bevelignore and must not drive the scan');
    },
    readFile: async (_id: string, wsRel: string) => fs.readFile(resolve(wsRel), 'utf-8'),
    writeFile: async (_id: string, wsRel: string, content: string) => {
      await fs.mkdir(path.dirname(resolve(wsRel)), { recursive: true });
      await fs.writeFile(resolve(wsRel), content);
    },
    deleteFile: async (_id: string, wsRel: string) => {
      await fs.rm(resolve(wsRel));
    },
  } as unknown as WorkspaceService;
}

function stubWorkflow(opts: { failCommit?: boolean; pushNeedsResolution?: boolean } = {}) {
  const commits: { summary: string; paths: string[]; author: string }[] = [];
  const locks = new Map<string, AuthUser>();
  const lockRow = (h: AuthUser) => ({ holderUserId: h.id, holderName: h.name });
  const svc = {
    getLock: async (_w: string, _b: string, p: string) => {
      const h = locks.get(p);
      return h ? lockRow(h) : null;
    },
    acquireLock: async (_w: string, _b: string, p: string, user: AuthUser) => {
      const h = locks.get(p);
      if (h) return { acquired: false, lock: lockRow(h) };
      locks.set(p, user);
      return { acquired: true, lock: lockRow(user) };
    },
    releaseLock: async (_w: string, _b: string, p: string) => {
      locks.delete(p);
    },
    releaseLockNoCommit: async (_w: string, _b: string, p: string) => {
      locks.delete(p);
    },
    commitChanges: async (_ws: string, user: AuthUser, summary: string, paths: string[]) => {
      if (opts.failCommit) throw new Error('push rejected: remote unreachable');
      commits.push({ summary, paths, author: user.email });
      if (opts.pushNeedsResolution) throw new PushNeedsAgentResolutionError(DEFAULT_BRANCH, paths[0], 'diverged', 'rebase failed');
      return {} as unknown;
    },
  } as unknown as WorkflowService;
  return { svc, commits, locks };
}

describe('access-file text helpers', () => {
  it('counts entries in frontmatter and in a body-governed access.md body', () => {
    expect(countUserEntriesInAccessText(SALES_ACCESS, 'Sales/access.md', LEE)).toBe(3);
    // A node file's body is prose, never a rule source.
    expect(countUserEntriesInAccessText(NODE, 'Plan.md', 'LEE@x.io')).toBe(1);
    // A legacy access.md's body is prose too.
    expect(countUserEntriesInAccessText(ROOT_ACCESS, 'access.md', LEE)).toBe(0);
  });

  it('removes every entry under every verb, keeping comments, other people and prose', () => {
    const sales = removeUserFromAccessText(SALES_ACCESS, 'Sales/access.md', LEE);
    expect(countUserEntriesInAccessText(sales, 'Sales/access.md', LEE)).toBe(0);
    expect(sales).toContain('- Sara <sara@x.io>');
    expect(sales).toContain('write: []');
    expect(sales).toContain('owner: []');

    const node = removeUserFromAccessText(NODE, 'Plan.md', LEE);
    expect(node).toBe('---\nnodeType: note\nowner: []\nread:\n  - Product\n---\n# Plan\n\nowner: Lee <lee@x.io>\n');
  });

  it('removes grants written as quoted scalars, flow lists and quoted list items', () => {
    const cases: [string, string][] = [
      ['---\nowner: "Lee <lee@x.io>"\n---\n', '---\nowner: []\n---\n'],
      ["---\nowner: 'Lee <lee@x.io>'\n---\n", '---\nowner: []\n---\n'],
      ['---\nread: [Lee <lee@x.io>, "Sara <sara@x.io>"]  # team\n---\n', '---\nread: ["Sara <sara@x.io>"]\n---\n'],
      ['---\nread: ["deny Lee <LEE@x.io>"]\n---\n', '---\nread: []\n---\n'],
      ['---\nread:\n  - "Lee <lee@x.io>"  # lead\n  - Sara <sara@x.io>\n---\n', '---\nread:\n  - Sara <sara@x.io>\n---\n'],
      ["---\nwrite:\n  - 'Lee <lee@x.io>'\n  - Lee <lee@x.io>\nread:\n  - Product\n---\n", '---\nwrite: []\nread:\n  - Product\n---\n'],
    ];
    for (const [text, expected] of cases) {
      expect(countUserEntriesInAccessText(text, 'Plan.md', LEE)).toBeGreaterThan(0);
      const out = removeUserFromAccessText(text, 'Plan.md', LEE);
      expect(out).toBe(expected);
      expect(countUserEntriesInAccessText(out, 'Plan.md', LEE)).toBe(0);
    }
  });
});

describe('removeEmailListLines', () => {
  it('drops the list lines in place and empties a key it leaves bare', () => {
    const text = '# header\nroles:\n  Admin:\n    - admin@x.io  # owner\n  Ops:\n    - LEE@x.io # temp\n  Empty: []\n';
    expect(removeEmailListLines(text, LEE)).toBe('# header\nroles:\n  Admin:\n    - admin@x.io  # owner\n  Ops: []\n  Empty: []\n');
    expect(removeEmailListLines(text, 'nobody@x.io')).toBe(text);
  });
});

describe('UserAccessRemovalService', () => {
  let root: string;
  let repo: string;
  let workspace: WorkspaceService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-user-access-removal-'));
    repo = path.join(root, KB);
    await write(repo, 'roles.yaml', ROLES);
    await write(repo, 'groups.yaml', GROUPS);
    await write(repo, 'access.md', ROOT_ACCESS);
    await write(repo, 'Sales/access.md', SALES_ACCESS);
    await write(repo, 'Sales/Plan.md', NODE);
    // The seeded template's ignore file, verbatim — it hides **/access.md.
    await write(
      repo,
      '.bevelignore',
      await fs.readFile(TEMPLATE_BEVELIGNORE, 'utf-8'),
    );
    workspace = stubWorkspace(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const read = (rel: string) => fs.readFile(path.join(repo, rel), 'utf-8');

  function build(workflow = stubWorkflow(), owners: string[] = ['owner@x.io'], disk: ITreeWalker = new NodeFs()) {
    const access = new AccessControlService(workspace as never, KB, new NodeFs());
    return {
      workflow,
      service: new UserAccessRemovalService(workspace, workflow.svc, access, disk, KB, () => DEFAULT_BRANCH, undefined, owners),
    };
  }

  it('reports how many places name the address, by kind', async () => {
    const { service } = build();
    const report = await service.report('LEE@x.io');
    expect(report).toEqual({
      roles: 2,
      groups: 1,
      accessRules: 3,
      fileGrants: 1,
      total: 7,
      files: ['Sales/Plan.md', 'Sales/access.md', 'groups.yaml', 'roles.yaml'],
      removable: true,
      blockedReason: null,
      unwritable: [],
    });
  });

  it('reads the candidate files through a bounded pool, not all at once', async () => {
    // 200 nodes, only one of which names the user. The old unbounded
    // Promise.all opened every one of them simultaneously — EMFILE on a real
    // knowledge base, three times per deletion.
    for (let i = 0; i < 200; i++) {
      await write(repo, `Bulk/Note-${i}.md`, `---\nnodeType: note\nread:\n  - Product\n---\n# Note ${i}\n`);
    }
    await write(repo, 'Bulk/Note-7.md', '---\nnodeType: note\nread:\n  - Lee <lee@x.io>\n---\n# Note 7\n');
    let inFlight = 0;
    let peak = 0;
    const plain = workspace.readFile.bind(workspace);
    workspace.readFile = async (id: string, wsRel: string) => {
      peak = Math.max(peak, ++inFlight);
      try {
        return await plain(id, wsRel);
      } finally {
        inFlight--;
      }
    };

    const report = await build().service.report(LEE);

    expect(peak).toBeLessThanOrEqual(16);
    // Bounding the reads did not lose a file: the one bulk note that names
    // them is counted, the 199 that do not are not.
    expect(report.files).toEqual(['Bulk/Note-7.md', 'Sales/Plan.md', 'Sales/access.md', 'groups.yaml', 'roles.yaml']);
    expect(report.fileGrants).toBe(2);
  });

  it('names the files the acting admin cannot write, before the delete', async () => {
    const canWrite = vi
      .spyOn(AccessControlService.prototype, 'canWriteBatchAtRef')
      .mockImplementation(async (_ws, _ref, _email, paths) => new Map(paths.map((p) => [p, p !== 'Sales/Plan.md'])));
    try {
      const { service } = build();
      const report = await service.report('LEE@x.io', 'admin@x.io');
      expect(report.unwritable).toEqual(['Sales/Plan.md']);
      // Judged for the ACTING admin, against every file that names the target.
      expect(canWrite).toHaveBeenCalledWith(expect.any(String), 'HEAD', 'admin@x.io', report.files);
    } finally {
      canWrite.mockRestore();
    }
  });

  it('removes the address from all four kinds of file in ONE commit named by the anonymised id', async () => {
    const { service, workflow } = build();
    const before = await read('access.md');
    const result = await service.remove(ADMIN, LEE, 'deleted-1234');

    expect(workflow.commits).toHaveLength(1);
    const [commit] = workflow.commits;
    expect(commit.summary).toBe('Remove erased account deleted-1234 from roles, groups and access rules');
    expect(commit.summary).not.toContain('lee');
    expect(commit.author).toBe('admin@x.io');
    expect(commit.paths.sort()).toEqual(
      ['Sales/Plan.md', 'Sales/access.md', 'groups.yaml', 'roles.yaml'].map((p) => `${KB}/${p}`).sort(),
    );
    expect(result.removedFrom.sort()).toEqual(['Sales/Plan.md', 'Sales/access.md', 'groups.yaml', 'roles.yaml']);
    expect(result.stillNamedIn).toEqual([]);

    expect(await read('roles.yaml')).toBe(`${ROLES_HEADER}roles:\n  Admin:\n    - admin@x.io\n  Reviewer:\n    - rev@x.io\n`);
    expect(await read('groups.yaml')).toBe('groups:\n  Product:\n    - felix@x.io\n  GTM Team:\n    - sara@x.io\n');
    expect(await read('access.md')).toBe(before);
    // The nested access.md the template's .bevelignore hides is really edited.
    expect(await read('Sales/access.md')).not.toContain('lee@x.io');
    expect((await service.report(LEE)).total).toBe(0);
    // No locks left behind.
    expect(workflow.locks.size).toBe(0);
  });

  it('counts synced groups but never writes them, reporting the file as still naming the user', async () => {
    await write(repo, 'synced-groups.yaml', 'groups:\n  Engineering:\n    - lee@x.io\n');
    const { service, workflow } = build();
    expect((await service.report(LEE)).groups).toBe(2);
    const result = await service.remove(ADMIN, LEE, 'deleted-1');
    expect(workflow.commits[0].paths).not.toContain(`${KB}/synced-groups.yaml`);
    expect(result.stillNamedIn).toEqual(['synced-groups.yaml']);
  });

  it('cleans every writable file in ONE commit and reports the one it may not write', async () => {
    // A grant in a folder that excludes Admin (see #210): the lock gate would
    // refuse that ONE file, and the cleanup used to abort entirely — leaving
    // roles.yaml, groups.yaml and the other access.md naming the user too.
    const canWrite = vi
      .spyOn(AccessControlService.prototype, 'canWriteBatchAtRef')
      .mockImplementation(async (_ws, _ref, _email, paths) => new Map(paths.map((p) => [p, p !== 'Sales/Plan.md'])));
    try {
      const { service, workflow } = build();
      const result = await service.remove(ADMIN, LEE, 'deleted-1');

      expect(workflow.commits).toHaveLength(1);
      expect(workflow.commits[0].paths.sort()).toEqual(
        ['Sales/access.md', 'groups.yaml', 'roles.yaml'].map((p) => `${KB}/${p}`).sort(),
      );
      expect(result.removedFrom.sort()).toEqual(['Sales/access.md', 'groups.yaml', 'roles.yaml']);
      expect(result.stillNamedIn).toEqual(['Sales/Plan.md']);
      // The unwritable file is untouched; the rest really were cleaned.
      expect(await read('Sales/Plan.md')).toBe(NODE);
      expect(await read('roles.yaml')).not.toContain('lee@x.io');
      expect(await read('Sales/access.md')).not.toContain('lee@x.io');
      expect(workflow.locks.size).toBe(0);
    } finally {
      canWrite.mockRestore();
    }
  });

  it('a write check that cannot run reports unknown, and still attempts every file', async () => {
    const canWrite = vi
      .spyOn(AccessControlService.prototype, 'canWriteBatchAtRef')
      .mockRejectedValue(new Error('access tree unreadable'));
    try {
      // The dialog must not be told "no unwritable files" when the question
      // could not be asked at all.
      expect((await build().service.report(LEE, 'admin@x.io')).unwritable).toBeNull();

      // The pre-check only ever narrows the set; with nothing known, attempt
      // them all — the lock gate remains the authority.
      const { service, workflow } = build();
      const result = await service.remove(ADMIN, LEE, 'deleted-1');
      expect(workflow.commits).toHaveLength(1);
      expect(result.removedFrom.sort()).toEqual(['Sales/Plan.md', 'Sales/access.md', 'groups.yaml', 'roles.yaml']);
      expect(result.stillNamedIn).toEqual([]);
    } finally {
      canWrite.mockRestore();
    }
  });

  it('a null verdict is bootstrap default-allow, not uncertainty', async () => {
    // GitService.assertCanWriteAtRef default-ALLOWS on the same signal, so
    // "no file is unwritable" is the answer that matches the gate.
    const canWrite = vi.spyOn(AccessControlService.prototype, 'canWriteBatchAtRef').mockResolvedValue(null);
    try {
      expect((await build().service.report(LEE, 'admin@x.io')).unwritable).toEqual([]);
    } finally {
      canWrite.mockRestore();
    }
  });

  it('refuses the deployment owner and the last Admin, writing nothing', async () => {
    const { service, workflow } = build(stubWorkflow(), ['Lee@x.io']);
    const report = await service.report(LEE);
    expect(report.removable).toBe(false);
    expect(report.blockedReason).toMatch(/deployment owner/);
    await expect(service.remove(ADMIN, LEE, 'deleted-1')).rejects.toMatchObject({ status: 409 });

    const other = build(stubWorkflow(), []);
    expect((await other.service.report('admin@x.io')).removable).toBe(true);
    await write(repo, 'roles.yaml', 'roles:\n  Admin:\n    - lee@x.io\n');
    expect((await other.service.report(LEE)).blockedReason).toMatch(/last Admin/);
    await expect(other.service.remove(ADMIN, LEE, 'deleted-1')).rejects.toMatchObject({ status: 409 });

    expect(workflow.commits).toHaveLength(0);
    expect(other.workflow.commits).toHaveLength(0);
    expect(await read('groups.yaml')).toBe(GROUPS);
  });

  it('a failed commit restores every file and leaves them naming the user', async () => {
    const { service } = build(stubWorkflow({ failCommit: true }));
    await expect(service.remove(ADMIN, LEE, 'deleted-1')).rejects.toThrow(/push rejected/);
    expect(await read('roles.yaml')).toBe(ROLES);
    expect(await read('Sales/access.md')).toBe(SALES_ACCESS);
    expect(await service.filesNaming(LEE)).toEqual(['Sales/Plan.md', 'Sales/access.md', 'groups.yaml', 'roles.yaml']);
  });

  it('refuses to commit a partial cleanup when a folder cannot be listed', async () => {
    const real = new NodeFs();
    const holey = {
      walkKb: async (...args: Parameters<ITreeWalker['walkKb']>) => {
        const result = await real.walkKb(...args);
        return { ...result, holes: [...result.holes, 'Secret'] };
      },
    } as unknown as ITreeWalker;
    const { service, workflow } = build(stubWorkflow(), ['owner@x.io'], holey);
    await expect(service.remove(ADMIN, LEE, 'deleted-1')).rejects.toMatchObject({
      status: 422,
      message: expect.stringMatching(/could not be read \(Secret\)/),
    });
    expect(workflow.commits).toHaveLength(0);
    expect(await read('roles.yaml')).toBe(ROLES);
  });

  it('a failure refreshing access after the commit still reports the removal as done', async () => {
    const invalidate = vi.spyOn(AccessControlService.prototype, 'invalidate').mockImplementation(() => {
      throw new Error('cache gone');
    });
    try {
      const { service, workflow } = build();
      const result = await service.remove(ADMIN, LEE, 'deleted-1');
      expect(workflow.commits).toHaveLength(1);
      expect(result.removedFrom.sort()).toEqual(['Sales/Plan.md', 'Sales/access.md', 'groups.yaml', 'roles.yaml']);
      expect(result.stillNamedIn).toEqual([]);
      // The refresh really ran after the commit and really threw.
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(invalidate.mock.results[0].type).toBe('throw');
    } finally {
      invalidate.mockRestore();
    }
  });

  it('a commit whose push needs resolution is reported as removed, publishing pending', async () => {
    const { service, workflow } = build(stubWorkflow({ pushNeedsResolution: true }));
    const result = await service.remove(ADMIN, LEE, 'deleted-1');
    expect(workflow.commits).toHaveLength(1);
    expect(result.publishPending).toBe(true);
    expect(result.removedFrom.sort()).toEqual(['Sales/Plan.md', 'Sales/access.md', 'groups.yaml', 'roles.yaml']);
    expect(result.stillNamedIn).toEqual([]);
    expect(await read('roles.yaml')).not.toContain('lee@x.io');
  });
});
