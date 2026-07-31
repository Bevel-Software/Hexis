import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

const execFileAsync = promisify(execFile);
const PROCESS_MAP_DIR = 'knowledge-base';

/**
 * `canWriteBatchAtRef` / the batched at-ref own-entries read — backed by ONE
 * `git cat-file --batch` process whose length-prefixed output we parse by
 * hand, so exercise it against a REAL git repo: found blobs, a path missing
 * at the ref (the `<spec> missing` line), a path with spaces, and frontmatter
 * deny resolution — all in one batch, order-aligned.
 */
describe('AccessControlService — at-ref batch reads (git cat-file --batch)', () => {
  let root: string;
  let repo: string;
  let svc: AccessControlService;
  const workspaceId = 'ws-atref-1';
  const admin = 'razvan@bevel.software';

  async function git(...args: string[]): Promise<void> {
    await execFileAsync('git', ['-C', repo, ...args]);
  }

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-atref-'));
    const workspaceDir = path.join(root, workspaceId);
    repo = path.join(workspaceDir, PROCESS_MAP_DIR);
    await fs.mkdir(path.join(repo, 'Knowledge'), { recursive: true });

    await fs.writeFile(path.join(repo, 'roles.yaml'), 'roles:\n  Admin:\n    - razvan@bevel.software\n');
    await fs.writeFile(path.join(repo, 'access.md'), '---\nwrite:\n  - Admin\n---\n');
    await fs.writeFile(path.join(repo, 'Knowledge/plain.md'), '# plain\n');
    await fs.writeFile(
      path.join(repo, 'Knowledge/denied.md'),
      '---\nwrite:\n  - deny razvan <razvan@bevel.software>\n---\n# denied\n',
    );
    await fs.writeFile(path.join(repo, 'Knowledge/with space.md'), '# spaced\n');

    await execFileAsync('git', ['init', '-b', 'main', repo]);
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('add', '-A');
    await git('commit', '-m', 'seed');

    const stub = {
      getWorkspacePath: async () => workspaceDir,
      // Fixture repo has no remote; at-ref model loading fetches best-effort.
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    svc = new AccessControlService(stub, PROCESS_MAP_DIR);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves a mixed batch in one pass: grants, frontmatter deny, spaces, and a missing path', async () => {
    const paths = [
      'Knowledge/plain.md', // dir-chain Admin grant → true
      'Knowledge/denied.md', // own frontmatter deny → false
      'Knowledge/with space.md', // found blob whose SPEC contains spaces → true
      'Knowledge/not-there.md', // missing at the ref (`<spec> missing` line) → dir-chain verdict
    ];
    const map = await svc.canWriteBatchAtRef(workspaceId, 'main', admin, paths);
    expect(map).not.toBeNull();
    expect(map!.get('Knowledge/plain.md')).toBe(true);
    expect(map!.get('Knowledge/denied.md')).toBe(false);
    expect(map!.get('Knowledge/with space.md')).toBe(true);
    expect(map!.get('Knowledge/not-there.md')).toBe(true);
  });

  it('matches the single-path at-ref resolution exactly', async () => {
    // The batch is a pure performance change — verdicts must be identical to
    // the per-path `git show` route the single-path helper still uses.
    expect(await svc.canWriteAtRef(workspaceId, 'main', admin, 'Knowledge/denied.md')).toBe(false);
    expect(await svc.canWriteAtRef(workspaceId, 'main', admin, 'Knowledge/plain.md')).toBe(true);
  });

  it('eligibleWritersForPathsAtRef honours the same batched own-entries', async () => {
    const map = await svc.eligibleWritersForPathsAtRef(workspaceId, 'main', [
      'Knowledge/plain.md',
      'Knowledge/denied.md',
    ]);
    expect(map).not.toBeNull();
    expect(map!.get('Knowledge/plain.md')!.roles).toContain('Admin');
    // The per-user deny strips razvan from the expanded email set.
    expect(map!.get('Knowledge/denied.md')!.emails.has(admin)).toBe(false);
    expect(map!.get('Knowledge/plain.md')!.emails.has(admin)).toBe(true);
  });
});
