import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

const PROCESS_MAP_DIR = 'knowledge-base';

async function writeFile(repo: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(repo, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contents);
}

function stubWorkspaceService(workspaceId: string, workspaceDir: string): WorkspaceService {
  return {
    getWorkspacePath: async (id: string) => {
      if (id !== workspaceId) throw new Error(`unexpected workspace ${id}`);
      return workspaceDir;
    },
  } as unknown as WorkspaceService;
}

const ROLES_YAML = `roles:
  Admin:
    - razvan@bevel.software
  Product Manager:
    - felix@example.com
`;

/**
 * canReadBatch = the read check behind BOTH the content routes and the
 * file-explorer tree. It must honour the FULL rule set — the folder
 * `access.md` chain AND each node's own frontmatter — so a file the caller
 * can't open never appears in the tree, and a frontmatter-only grant is
 * discoverable. (This replaced the dir-chain-only `canReadBatchShallow`,
 * whose frontmatter blindness let a frontmatter-denied file show in the
 * sidebar and then 403 on open.)
 */
describe('AccessControlService.canReadBatch — tree/content parity', () => {
  let root: string;
  const workspaceId = 'ws-read-batch-1';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-read-batch-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seed() {
    const workspaceDir = path.join(root, workspaceId);
    const repo = path.join(workspaceDir, PROCESS_MAP_DIR);
    await fs.mkdir(repo, { recursive: true });
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    // Folder-level read restriction (dir-chain rule). Product Manager = felix; ali has no role.
    await writeFile(repo, 'Knowledge/Secret/access.md', '---\nread:\n  - Product Manager\n---\n');
    await writeFile(repo, 'Knowledge/Secret/Foo.md', '# secret\n');
    // Public folder via the built-in everyone role.
    await writeFile(repo, 'Knowledge/Open/access.md', '---\nread:\n  - everyone\n---\n');
    // Node restricted ONLY by its own frontmatter — the batch must see it.
    await writeFile(
      repo,
      'Knowledge/Open/SelfRestricted.md',
      '---\nread:\n  - deny everyone\n  - Product Manager\n---\n# self\n',
    );
    // Public via folder access.md.
    await writeFile(repo, 'Knowledge/Open/Normal.md', '# normal\n');
    // Node granted ONLY by its own frontmatter — the batch must discover it.
    await writeFile(
      repo,
      'Knowledge/Closed/SelfGranted.md',
      '---\nread:\n  - Product Manager\n---\n# self\n',
    );
    const svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
    return { svc, repo };
  }

  const ali = 'ali@bevel.software'; // not in any read: list, not admin
  const felix = 'felix@example.com'; // listed

  it('honours folder-level read rules (denies non-listed, allows listed)', async () => {
    const { svc } = await seed();
    const m = await svc.canReadBatch(workspaceId, ali, ['Knowledge/Secret/Foo.md']);
    expect(m.get('Knowledge/Secret/Foo.md')).toBe(false);
    const mf = await svc.canReadBatch(workspaceId, felix, ['Knowledge/Secret/Foo.md']);
    expect(mf.get('Knowledge/Secret/Foo.md')).toBe(true);
  });

  it('honours a node-only frontmatter DENY (batch verdict matches the content route)', async () => {
    const { svc } = await seed();
    const p = 'Knowledge/Open/SelfRestricted.md';
    // Full single-file canRead denies ali…
    expect(await svc.canRead(workspaceId, ali, p)).toBe(false);
    // …and the batch (tree) agrees, so the file never shows in the sidebar.
    const batch = await svc.canReadBatch(workspaceId, ali, [p]);
    expect(batch.get(p)).toBe(false);
    // The frontmatter grant still lets felix through.
    const felixBatch = await svc.canReadBatch(workspaceId, felix, [p]);
    expect(felixBatch.get(p)).toBe(true);
  });

  it('discovers a node whose ONLY read grant is in node frontmatter', async () => {
    const { svc } = await seed();
    const p = 'Knowledge/Closed/SelfGranted.md';
    expect(await svc.canRead(workspaceId, felix, p)).toBe(true);
    const batch = await svc.canReadBatch(workspaceId, felix, [p]);
    expect(batch.get(p)).toBe(true);
  });

  it('allows a public node via read: everyone', async () => {
    const { svc } = await seed();
    const m = await svc.canReadBatch(workspaceId, ali, ['Knowledge/Open/Normal.md']);
    expect(m.get('Knowledge/Open/Normal.md')).toBe(true);
  });

  it('memoizes frontmatter reads per workspace and re-reads after invalidate()', async () => {
    const { svc, repo } = await seed();
    const p = 'Knowledge/Open/SelfRestricted.md';
    // Warm the cache with the deny in place.
    expect((await svc.canReadBatch(workspaceId, ali, [p])).get(p)).toBe(false);
    // Remove the deny on disk. The memo may still serve the old verdict…
    await writeFile(repo, p, '# self, unrestricted\n');
    // …but after invalidate() (fired on every commit/pull/switch) the fresh
    // frontmatter is read and the folder's `read: everyone` applies.
    svc.invalidate(workspaceId);
    expect((await svc.canReadBatch(workspaceId, ali, [p])).get(p)).toBe(true);
  });
});
