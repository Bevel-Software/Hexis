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

  /** Copy `from` to `to` on disk, leaving the source where it is. */
  async function reallyCopy(from: string, to: string): Promise<void> {
    const dest = path.join(repo, to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.cp(path.join(repo, from), dest, { recursive: true });
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
      // A destination governed DIFFERENTLY from the source, so the answer can
      // only come from the rules the copy carries: Legal grants read and
      // nothing else, as the root does.
      'Legal/access.md': rules('read:\n  - everyone\n'),
    });

    const svc = service();
    const after = await svc.previewAccessAfterRelocation(
      workspaceId, MOVER, 'Sales', 'Legal/Sales-Copy', { sourceRemains: true },
    );

    // The copied `access.md` governs the copy, which is the opposite of what
    // the destination says today.
    expect(after).toMatchObject({ write: true, owner: true });
    expect(await verbsAt(svc, 'Legal')).toMatchObject({ write: false, owner: false });

    await reallyCopy('Sales', 'Legal/Sales-Copy');
    const done = service();
    expect(await verbsAt(done, 'Legal/Sales-Copy')).toEqual(after);
    // `sourceRemains`: both sets of rules are real afterwards, and the source
    // keeps the access it always had.
    expect(await verbsAt(done, 'Sales')).toMatchObject({ owner: true });
  });

  /**
   * A lone `access.md` is a single FILE whose rules are a whole folder's.
   * Keyed by the directory it sits in, it is not a path "under" the source,
   * so the folder walk cannot see it — and `copy_file` will copy one, which
   * is how a preview came to answer the destination's old rules about a
   * directory that was about to be governed by the file landing in it.
   */
  it('a lone access.md governs the folder it is copied into', async () => {
    await write({
      ...BASE,
      'Sales/access.md': rules(`write:\n  - Mover <${MOVER}>\nowner:\n  - Mover <${MOVER}>\n`),
      'Legal/note.md': '# Note\n',
    });

    const svc = service();
    // `Legal/` has no rules of its own; the root grants read and nothing else.
    expect(await verbsAt(svc, 'Legal')).toMatchObject({ write: false, owner: false });

    const after = await svc.previewAccessAfterRelocation(
      workspaceId, MOVER, 'Sales/access.md', 'Legal/access.md', { sourceRemains: true },
    );
    expect(after).toMatchObject({ write: true, owner: true });

    await fs.copyFile(path.join(repo, 'Sales/access.md'), path.join(repo, 'Legal/access.md'));
    const done = service();
    expect(await verbsAt(done, 'Legal/access.md')).toEqual(after);
    // What landed governs the folder, not only itself.
    expect(await verbsAt(done, 'Legal')).toMatchObject({ write: true, owner: true });
  });

  it('a file copied under any other name carries no folder rules with it', async () => {
    await write({
      ...BASE,
      'Sales/access.md': rules(`write:\n  - Mover <${MOVER}>\nowner:\n  - Mover <${MOVER}>\n`),
      'Legal/note.md': '# Note\n',
    });

    const svc = service();
    // The same bytes, landing as an ordinary note: they govern nothing there,
    // so the answer is the destination's own, exactly as the gates say.
    const after = await svc.previewAccessAfterRelocation(
      workspaceId, MOVER, 'Sales/access.md', 'Legal/rules-copy.md', { sourceRemains: true },
    );
    expect(after).toEqual(await verbsAt(svc, 'Legal/rules-copy.md'));
    expect(after).toMatchObject({ write: false, owner: false });
  });

  /**
   * The same rule for the other thing that travels with a file: its own
   * frontmatter. Asking the DESTINATION for it always answered null — nothing
   * is there yet — so a rename of a self-governing file previewed a loss the
   * move hands straight back, and the preview contradicted the access the
   * caller really has afterwards (Specification requirement 6).
   */
  it("a file's own frontmatter travels with its bytes, so a rename costs nothing", async () => {
    await write({
      ...BASE,
      'Work/access.md': rules('read:\n  - everyone\n'),
      'Work/plan.md': rules(`owner:\n  - Mover <${MOVER}>\n`) + '# Plan\n',
    });

    const svc = service();
    const before = await verbsAt(svc, 'Work/plan.md');
    expect(before.owner).toBe(true);

    const after = await svc.previewAccessAfterRelocation(
      workspaceId, MOVER, 'Work/plan.md', 'Work/roadmap.md',
    );
    expect(after).toEqual(before);

    await reallyMove('Work/plan.md', 'Work/roadmap.md');
    expect(await verbsAt(service(), 'Work/roadmap.md')).toEqual(after);
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
