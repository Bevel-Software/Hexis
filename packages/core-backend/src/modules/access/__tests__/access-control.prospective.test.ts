import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NodeFs } from '../../kb-fs/node-fs.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';
import { holderPrincipals } from '../access-view.js';

/**
 * `prospectiveHolders`: who can open and edit a file or folder where it
 * sits, and who could once a move puts it somewhere else. Driven over a real
 * on-disk tree through the public resolver, because the whole point is that
 * the "after" side must be the SAME resolution as a real one — the
 * destination's folder chain with whatever travels laid over it, a file's own
 * frontmatter or a folder's `access.md` files — for a path that does not
 * exist yet and therefore cannot be asked for in the ordinary way.
 */

const KB_DIR = 'knowledge-base';

function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
    ensureRemotesFetched: async () => undefined,
  } as unknown as WorkspaceService;
}

const rules = (body: string) => `---\n${body}---\n`;

const GROUPS_YAML = `groups:
  Engineering:
    - eng@x.io
  Product:
    - pm@x.io
`;

describe('AccessControlService.prospectiveHolders', () => {
  let root: string;
  const workspaceId = 'ws-prospective-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-prospective-'));
  });
  afterEach(async () => {
    // A `mkdtemp` that threw leaves `root` unassigned; removing it would throw
    // over the top of the setup failure and hide it.
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function makeService(files: Record<string, string>) {
    const workspaceDir = path.join(root, workspaceId);
    const repo = path.join(workspaceDir, KB_DIR);
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
    return new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), KB_DIR, new NodeFs());
  }

  /** The principal NAMES holding a verb on one side, for readable assertions. */
  const names = (list: Parameters<typeof holderPrincipals>[0]) =>
    holderPrincipals(list).map((p) => p.name);

  const TREE = {
    'roles.yaml': 'roles:\n  Admin:\n    - admin@x.io\n',
    'groups.yaml': GROUPS_YAML,
    'Knowledge/Legal/access.md': rules('read:\n  - Engineering\nwrite:\n  - Engineering\n'),
    'Knowledge/Legal/contract.md': '# Contract\n',
    'Knowledge/Sales/access.md': rules('read:\n  - Product\n'),
  };

  it('resolves the destination folder rules for a path the file has not reached', async () => {
    const svc = await makeService(TREE);

    const { before, after } = await svc.prospectiveHolders(
      workspaceId,
      'Knowledge/Legal/contract.md',
      'Knowledge/Sales/contract.md',
    );

    expect(names(before.read)).toContain('Engineering');
    expect(names(before.write)).toContain('Engineering');
    expect(names(after.read)).toContain('Product');
    expect(names(after.read)).not.toContain('Engineering');
    // Sales grants read only, so nobody carries the file's write across.
    expect(names(after.write)).not.toContain('Engineering');
  });

  it("carries the file's own frontmatter to the destination — it moves with the bytes", async () => {
    const svc = await makeService({
      ...TREE,
      // Ali is granted on the FILE, not the folder, so the move keeps him.
      'Knowledge/Legal/contract.md': rules('read:\n  - Ali Raza <ali@x.io>\n') + '# Contract\n',
    });

    const { before, after } = await svc.prospectiveHolders(
      workspaceId,
      'Knowledge/Legal/contract.md',
      'Knowledge/Sales/contract.md',
    );

    expect(holderPrincipals(before.read).map((p) => p.email)).toContain('ali@x.io');
    expect(holderPrincipals(after.read).map((p) => p.email)).toContain('ali@x.io');
  });

  it('answers identically on both sides for a destination in the same folder', async () => {
    const svc = await makeService(TREE);

    // A DIFFERENT destination path, resolved on its own, that happens to fall
    // under the same rules — the "Nobody's access changes." case. Handing the
    // source path back as the destination would assert nothing at all.
    const { before, after } = await svc.prospectiveHolders(
      workspaceId,
      'Knowledge/Legal/contract.md',
      'Knowledge/Legal/draft.md',
    );

    expect(names(after.read)).toEqual(names(before.read));
    expect(names(after.write)).toEqual(names(before.write));
  });

  it('kinds a group as a group, so the dialog can name it as its grant does', async () => {
    const svc = await makeService(TREE);

    const { before } = await svc.prospectiveHolders(
      workspaceId,
      'Knowledge/Legal/contract.md',
      'Knowledge/Sales/contract.md',
    );

    expect(holderPrincipals(before.read)).toContainEqual({ kind: 'group', name: 'Engineering' });
  });

  /**
   * A folder carries its own `access.md`, and that file MOVES WITH IT. The
   * resolver used to refuse the question rather than answer it as if the
   * folder were a file — the right refusal for the wrong reason, since the
   * answer it could not give is the one a folder move actually needs.
   */
  it('answers a folder source with the rules it carries, at the path they land on', async () => {
    const svc = await makeService(TREE);

    const { before, after } = await svc.prospectiveHolders(
      workspaceId,
      'Knowledge/Legal',
      'Knowledge/Sales/Legal',
    );

    // `Knowledge/Legal/access.md` travels, so Engineering keeps both verbs at
    // the new path — the rules the folder brings, not the ones it is landing
    // among. Read as a FILE the answer would have been Product's, from
    // `Knowledge/Sales/access.md` alone.
    expect(names(before.read)).toContain('Engineering');
    expect(names(before.write)).toContain('Engineering');
    expect(names(after.read)).toContain('Engineering');
    expect(names(after.write)).toContain('Engineering');
  });

  it('leaves the old parent behind and picks the new one up', async () => {
    const svc = await makeService({
      ...TREE,
      // Engineering's write on Team comes from Legal above it, not from Team.
      'Knowledge/Legal/Team/access.md': rules('read:\n  - Product\n'),
      'Knowledge/Legal/Team/plan.md': '# Plan\n',
    });

    const { before, after } = await svc.prospectiveHolders(
      workspaceId,
      'Knowledge/Legal/Team',
      'Knowledge/Sales/Team',
    );

    expect(names(before.write)).toContain('Engineering');
    // Sales grants nobody write, and Team's own file grants only read — so
    // the write Team held by inheritance does not come along.
    expect(names(after.write)).not.toContain('Engineering');
    expect(names(after.read)).toContain('Product');
  });

  it('a rename of a folder that grants its own access changes nothing', async () => {
    const svc = await makeService(TREE);

    const { before, after } = await svc.prospectiveHolders(
      workspaceId,
      'Knowledge/Legal',
      'Knowledge/Revenue',
    );

    expect(names(after.read)).toEqual(names(before.read));
    expect(names(after.write)).toEqual(names(before.write));
  });

  /**
   * A SYMLINK is neither of the two shapes the preview knows. `move_file`
   * refuses a symlink source outright (`assertNoSymlinkOnPath`), so a link to
   * a directory must not be described as a folder taking its `access.md`
   * files along — that would promise the target's rules at a path nothing is
   * ever going to arrive at. Nothing is read through the link either.
   */
  it('a symlink to a folder is not previewed as the folder it points at', async () => {
    const svc = await makeService(TREE);
    const repo = path.join(root, workspaceId, KB_DIR);
    await fs.symlink(path.join(repo, 'Knowledge/Legal'), path.join(repo, 'Knowledge/Sales/alias'));

    const { after } = await svc.prospectiveHolders(
      workspaceId,
      'Knowledge/Sales/alias',
      'Knowledge/alias',
    );

    // Legal's own rules stayed behind the link: `Knowledge/` has no
    // `access.md`, so nobody holds anything at the destination.
    expect(names(after.read)).not.toContain('Engineering');
    expect(names(after.write)).not.toContain('Engineering');
  });

  it('a probe that fails for any reason but absence throws, never a silent "file"', async () => {
    const svc = await makeService(TREE);
    // A disk fault (EACCES here) must never read as "not a directory": the
    // probe is what chooses between the two resolutions, so a folder read as
    // a file would be answered with frontmatter it does not have and without
    // the `access.md` files it carries — the wrong principals, named with
    // the same confidence as the right ones. Spied rather than staged with
    // mode bits, so the property holds as root and on Windows too. `lstat`,
    // because that is the probe: a symlink is classified by what it IS.
    const real = fs.lstat;
    const spy = vi.spyOn(fs, 'lstat').mockImplementation(((p: string) =>
      String(p).endsWith('contract.md')
        ? Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }))
        : (real as (p: string) => Promise<unknown>).call(fs, p)) as never);
    try {
      await expect(
        svc.prospectiveHolders(
          workspaceId,
          'Knowledge/Legal/contract.md',
          'Knowledge/Sales/contract.md',
        ),
      ).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      spy.mockRestore();
    }
  });

  it('moves nothing and writes nothing', async () => {
    const svc = await makeService(TREE);
    const source = path.join(root, workspaceId, KB_DIR, 'Knowledge/Legal/contract.md');

    await svc.prospectiveHolders(
      workspaceId,
      'Knowledge/Legal/contract.md',
      'Knowledge/Sales/contract.md',
    );

    expect(await fs.readFile(source, 'utf-8')).toBe('# Contract\n');
    await expect(
      fs.access(path.join(root, workspaceId, KB_DIR, 'Knowledge/Sales/contract.md')),
    ).rejects.toThrow();
  });
});
