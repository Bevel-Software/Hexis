import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

/**
 * `previewAccessAfterRelocation`: the caller's OWN verbs at a destination as
 * they will be once a move or a copy has landed there.
 *
 * The question the four gates cannot answer, because the `access.md` files a
 * folder carries are not at the destination yet — which is how a rename came
 * to warn about losing owner access the folder's own rules were about to hand
 * straight back. Driven over a real on-disk tree, and every answer checked
 * against the ordinary gates once the tree really says what the preview said
 * it would.
 */

const KB_DIR = 'knowledge-base';
const MOVER = 'mover@x.io';

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

describe('AccessControlService.previewAccessAfterRelocation', () => {
  let root: string;
  let repo: string;
  const workspaceId = 'ws-preview-relocation';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-preview-reloc-'));
    repo = path.join(root, workspaceId, KB_DIR);
  });
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  async function write(files: Record<string, string>): Promise<void> {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, contents);
    }
  }

  /**
   * A service reading the tree as it is NOW. Built fresh after every change
   * on purpose: in production the file-change notifier invalidates the model,
   * and a test that leaned on the five-second cache would be asserting the
   * cache rather than the resolver.
   */
  const service = () =>
    new AccessControlService(
      stubWorkspaceService(workspaceId, path.join(root, workspaceId)),
      KB_DIR,
      new NodeFs(),
    );

  /** The caller's four verbs at a path, through the ordinary gates. */
  async function verbsAt(svc: AccessControlService, rel: string) {
    const [read, write, download, owner] = await Promise.all([
      svc.canRead(workspaceId, MOVER, rel),
      svc.canWrite(workspaceId, MOVER, rel),
      svc.canDownload(workspaceId, MOVER, rel),
      svc.canOwner(workspaceId, MOVER, rel),
    ]);
    return { read, write, download, owner };
  }

  /** Move `from` to `to` on disk, as the move itself does. */
  async function reallyMove(from: string, to: string): Promise<void> {
    const dest = path.join(repo, to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.rename(path.join(repo, from), dest);
  }

  const BASE = {
    'roles.yaml': 'roles:\n  Admin:\n    - admin@x.io\n',
    'access.md': rules('read:\n  - everyone\n'),
  };

  it('a folder keeps the access its own access.md gives it when it is renamed', async () => {
    await write({
      ...BASE,
      'Sales/access.md': rules(`write:\n  - Mover <${MOVER}>\nowner:\n  - Mover <${MOVER}>\n`),
      'Sales/deal.md': '# Deal\n',
    });

    const svc = service();
    const before = await verbsAt(svc, 'Sales');
    const after = await svc.previewAccessAfterRelocation(workspaceId, MOVER, 'Sales', 'Revenue');

    expect(before.owner).toBe(true);
    expect(after).toEqual(before);

    // The root grants read and nothing else, so the destination AS IT STANDS
    // says the opposite — which is the warning people were shown.
    expect(await verbsAt(svc, 'Revenue')).toMatchObject({ write: false, owner: false });

    await reallyMove('Sales', 'Revenue');
    expect(await verbsAt(service(), 'Revenue')).toEqual(after);
  });

  it('a folder with no access.md of its own takes the new parent\'s rules, as it always did', async () => {
    await write({
      ...BASE,
      'Work/access.md': rules(`write:\n  - Mover <${MOVER}>\n`),
      'Work/Notes/note.md': '# Note\n',
      'Legal/access.md': rules('read:\n  - everyone\n'),
    });

    const svc = service();
    const before = await verbsAt(svc, 'Work/Notes');
    const after = await svc.previewAccessAfterRelocation(workspaceId, MOVER, 'Work/Notes', 'Legal/Notes');

    expect(before.write).toBe(true);
    expect(after.write).toBe(false);
    // Nothing travels, so the preview is exactly what the gates say today.
    expect(after).toEqual(await verbsAt(svc, 'Legal/Notes'));

    await reallyMove('Work/Notes', 'Legal/Notes');
    expect(await verbsAt(service(), 'Legal/Notes')).toEqual(after);
  });

  it('what the folder inherited is left behind; what it carries comes along', async () => {
    await write({
      ...BASE,
      'Work/access.md': rules(`write:\n  - Mover <${MOVER}>\nowner:\n  - Mover <${MOVER}>\n`),
      'Work/Team/access.md': rules(`write:\n  - Mover <${MOVER}>\n`),
      'Work/Team/plan.md': '# Plan\n',
      'Legal/access.md': rules('read:\n  - everyone\n'),
    });

    const svc = service();
    expect(await verbsAt(svc, 'Work/Team')).toMatchObject({ write: true, owner: true });

    const after = await svc.previewAccessAfterRelocation(workspaceId, MOVER, 'Work/Team', 'Legal/Team');

    // Write is the folder's own and travels; owner came from `Work/` and
    // does not.
    expect(after).toMatchObject({ write: true, owner: false });

    await reallyMove('Work/Team', 'Legal/Team');
    expect(await verbsAt(service(), 'Legal/Team')).toEqual(after);
  });

  it('a nested access.md does not change the answer at the folder itself', async () => {
    const tree = {
      ...BASE,
      'Work/access.md': rules(`write:\n  - Mover <${MOVER}>\nowner:\n  - Mover <${MOVER}>\n`),
      'Work/Team/access.md': rules(`write:\n  - Mover <${MOVER}>\n`),
      'Work/Team/plan.md': '# Plan\n',
      'Legal/access.md': rules('read:\n  - everyone\n'),
    };
    await write(tree);
    const withoutNested = await service().previewAccessAfterRelocation(
      workspaceId, MOVER, 'Work/Team', 'Legal/Team',
    );

    // `Sub/` shuts the caller out entirely, and it moves too — but it governs
    // `Legal/Team/Sub`, not `Legal/Team`.
    await write({ 'Work/Team/Sub/access.md': rules(`read:\n  - deny Mover <${MOVER}>\n`) });
    const svc = service();
    expect(await svc.previewAccessAfterRelocation(workspaceId, MOVER, 'Work/Team', 'Legal/Team'))
      .toEqual(withoutNested);
    // It is counted, though — at the path it lands on.
    expect(
      await svc.previewAccessAfterRelocation(workspaceId, MOVER, 'Work/Team', 'Legal/Team'),
    ).not.toEqual(
      await svc.previewAccessAfterRelocation(workspaceId, MOVER, 'Work/Team/Sub', 'Legal/Team/Sub'),
    );

    await reallyMove('Work/Team', 'Legal/Team');
    const after = service();
    expect(await verbsAt(after, 'Legal/Team')).toEqual(withoutNested);
    expect(await verbsAt(after, 'Legal/Team/Sub')).toMatchObject({ read: false });
  });

  it('a copy leaves the source rules where they are and lands a second set', async () => {
    await write({
      ...BASE,
      'Sales/access.md': rules(`write:\n  - Mover <${MOVER}>\nowner:\n  - Mover <${MOVER}>\n`),
      'Sales/deal.md': '# Deal\n',
    });

    const svc = service();
    const after = await svc.previewAccessAfterRelocation(
      workspaceId, MOVER, 'Sales', 'Sales-Copy', { sourceRemains: true },
    );

    expect(after).toEqual(await verbsAt(svc, 'Sales'));
    // The source is untouched by the question.
    expect(await verbsAt(svc, 'Sales')).toMatchObject({ owner: true });
  });

  it('a single file answers exactly as the gates at the destination do', async () => {
    await write({
      ...BASE,
      'Work/access.md': rules(`write:\n  - Mover <${MOVER}>\n`),
      'Work/note.md': '# Note\n',
      'Legal/access.md': rules('read:\n  - everyone\n'),
    });

    const svc = service();
    const after = await svc.previewAccessAfterRelocation(workspaceId, MOVER, 'Work/note.md', 'Legal/note.md');

    expect(after).toEqual(await verbsAt(svc, 'Legal/note.md'));

    await reallyMove('Work/note.md', 'Legal/note.md');
    expect(await verbsAt(service(), 'Legal/note.md')).toEqual(after);
  });

  it('answers the caller\'s own verbs and nothing else, and writes nothing', async () => {
    await write({
      ...BASE,
      'Sales/access.md': rules(`read:\n  - deny everyone\n  - Mover <${MOVER}>\nowner:\n  - Mover <${MOVER}>\n`),
      'Sales/deal.md': '# Deal\n',
    });

    const svc = service();
    const after = await svc.previewAccessAfterRelocation(workspaceId, MOVER, 'Sales', 'Revenue');

    // Four booleans. Nothing about who else holds what, and nothing out of
    // an `access.md` the caller may not read.
    expect(Object.keys(after).sort()).toEqual(['download', 'owner', 'read', 'write']);
    for (const v of Object.values(after)) expect(typeof v).toBe('boolean');

    // A stranger gets their own answer, not the caller's.
    expect(await svc.previewAccessAfterRelocation(workspaceId, 'stranger@x.io', 'Sales', 'Revenue'))
      .toMatchObject({ read: false, owner: false });

    expect(await fs.readFile(path.join(repo, 'Sales/access.md'), 'utf-8')).toContain('owner:');
    await expect(fs.access(path.join(repo, 'Revenue'))).rejects.toThrow();
  });
});
