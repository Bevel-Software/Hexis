import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { AccessControlService } from '../access-control.service.js';

const PROCESS_MAP_DIR = 'knowledge-base';

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-grantsrc-'));
}

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
  Engineer:
    - ali@bevel.software
`;

const FELIX = { kind: 'user' as const, email: 'felix@example.com' };
const ALI = { kind: 'user' as const, email: 'ali@bevel.software' };
const RAZVAN = { kind: 'user' as const, email: 'razvan@bevel.software' };

describe('AccessControlService.grantSources', () => {
  let root: string;
  let repo: string;
  let svc: AccessControlService;
  const workspaceId = 'ws-gs';

  beforeEach(async () => {
    root = await mkTmpRoot();
    const workspaceDir = path.join(root, workspaceId);
    repo = path.join(workspaceDir, PROCESS_MAP_DIR);
    await fs.mkdir(repo, { recursive: true });
    await writeFile(repo, 'roles.yaml', ROLES_YAML);
    svc = new AccessControlService(stubWorkspaceService(workspaceId, workspaceDir), PROCESS_MAP_DIR);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a direct folder grant resolves to [{ kind: direct }]', async () => {
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(repo, 'Knowledge/access.md', '---\nwrite:\n  - Felix <felix@example.com>\n---\n');
    const src = await svc.grantSources(workspaceId, 'folder', 'Knowledge', FELIX);
    expect(src.write).toEqual([{ kind: 'direct' }]);
  });

  it('an inherited grant resolves to [{ kind: ancestor, path }] (repo-relative)', async () => {
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(repo, 'Knowledge/access.md', '---\nwrite:\n  - Felix <felix@example.com>\n---\n');
    // Resolve for a file UNDER Knowledge — the write grant is inherited from Knowledge/access.md.
    const src = await svc.grantSources(workspaceId, 'file', 'Knowledge/Deal.md', FELIX);
    expect(src.write).toEqual([{ kind: 'ancestor', path: 'Knowledge/access.md' }]);
    // The path is repo-relative — no `knowledge-base/` workspace prefix.
    const first = src.write![0] as { path: string };
    expect(first.path.startsWith(`${PROCESS_MAP_DIR}/`)).toBe(false);
  });

  it('a closer direct grant shadows the ancestor but BOTH scopes are reported (winner first)', async () => {
    // h3xxit's case: granted on the target AND on an ancestor. The winner is
    // direct (closest), but the ancestor must ALSO appear so callers can tell
    // "direct only" apart from "direct + also inherited".
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Felix <felix@example.com>\n---\n');
    await writeFile(repo, 'Knowledge/access.md', '---\nwrite:\n  - Felix <felix@example.com>\n---\n');
    const src = await svc.grantSources(workspaceId, 'folder', 'Knowledge', FELIX);
    // Closest-first: Knowledge/access.md (direct) then the root access.md (ancestor).
    expect(src.write).toEqual([{ kind: 'direct' }, { kind: 'ancestor', path: 'access.md' }]);
    expect(src.write![0]).toEqual({ kind: 'direct' }); // the effective/winning source
  });

  it('direct-only is distinguishable from direct+ancestor (just [direct], no tail)', async () => {
    // Same person, granted ONLY on the target (root grants Admin, not Felix).
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(repo, 'Knowledge/access.md', '---\nwrite:\n  - Felix <felix@example.com>\n---\n');
    const src = await svc.grantSources(workspaceId, 'folder', 'Knowledge', FELIX);
    expect(src.write).toEqual([{ kind: 'direct' }]); // no ancestor tail — direct ONLY
  });

  it('reports per-verb sources: direct on one verb, ancestor on another', async () => {
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(repo, 'Knowledge/access.md', '---\nwrite:\n  - Felix <felix@example.com>\n---\n');
    // download granted directly on the file's own frontmatter; write inherited from Knowledge.
    await writeFile(
      repo,
      'Knowledge/Deal.md',
      '---\nnodeType: process\ndownload:\n  - Felix <felix@example.com>\n---\n# body\n',
    );
    const src = await svc.grantSources(workspaceId, 'file', 'Knowledge/Deal.md', FELIX);
    expect(src.download).toEqual([{ kind: 'direct' }]);
    expect(src.write).toEqual([{ kind: 'ancestor', path: 'Knowledge/access.md' }]);
  });

  it('a USER who holds a verb only via a plugin they belong to has NO source (the plugin row carries it)', async () => {
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Engineer\n---\n');
    // Ali is an Engineer (per roles.yaml) — his write flows through the PLUGIN, not
    // a per-user file entry. He isn't named in any file, so there's nothing to
    // remove for HIM here; the Engineering plugin is the removable principal.
    const src = await svc.grantSources(workspaceId, 'folder', 'Knowledge', ALI);
    expect(src.write).toBeUndefined();
    expect(src).toEqual({}); // no verb resolves to a per-user file entry
  });

  it('the PLUGIN principal itself resolves to its own file scope (direct/ancestor)', async () => {
    // The same Engineer grant, asked about as the ROLE principal, IS a removable
    // file entry — the plugin is named directly on Knowledge/access.md.
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(repo, 'Knowledge/access.md', '---\nwrite:\n  - Engineer\n---\n');
    const src = await svc.grantSources(workspaceId, 'folder', 'Knowledge', {
      kind: 'role',
      role: 'Engineer',
    });
    expect(src.write).toEqual([{ kind: 'direct' }]);
  });

  it('a verb a user holds only via everyone has NO source (not a per-user file entry)', async () => {
    await writeFile(repo, 'access.md', '---\nread:\n  - everyone\nwrite:\n  - Admin\n---\n');
    const src = await svc.grantSources(workspaceId, 'file', 'Knowledge/Deal.md', FELIX);
    expect(src.read).toBeUndefined(); // resolves via everyone, but not removable as Felix
    expect(src.write).toBeUndefined(); // Felix is not an admin and has no write
    expect(src).toEqual({});
  });

  it('an admin on an access.md target has NO source (rescue is not a removable file entry)', async () => {
    // No write entry names Razvan on this access.md; he holds write on it ONLY
    // via the admin rescue. That isn't a per-target file entry, so grantSources
    // reports no source — there's nothing to remove for him here. (The share
    // dialog never targets an access.md directly; this is the defensive path.)
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Engineer\n---\n');
    const src = await svc.grantSources(workspaceId, 'file', 'access.md', RAZVAN);
    expect(src.write).toBeUndefined();
    expect(src).toEqual({});
  });

  it("a folder-target admin whose access is via the Admin PLUGIN has NO per-user source", async () => {
    // Razvan's effective write comes from the `Admin` plugin grant, not a per-user
    // entry — so as a USER principal he has no removable source here (the Admin
    // plugin row carries it, exactly like any other plugin).
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    const src = await svc.grantSources(workspaceId, 'folder', 'Knowledge', RAZVAN);
    expect(src.write).toBeUndefined();
    expect(src).toEqual({});
  });

  it("a user named DIRECTLY in a file keeps a source even if they're also in a plugin", async () => {
    // Razvan is in the Admin plugin AND named inline on Knowledge — the inline
    // entry is a removable file grant, so his source is direct (tier-1 email
    // beats the plugin at the same scope).
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(
      repo,
      'Knowledge/access.md',
      '---\nwrite:\n  - Razvan <razvan@bevel.software>\n---\n',
    );
    const src = await svc.grantSources(workspaceId, 'folder', 'Knowledge', RAZVAN);
    expect(src.write).toEqual([{ kind: 'direct' }]);
  });

  it('a role principal is matched by its own scope entry, not a role indirection', async () => {
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(repo, 'Knowledge/access.md', '---\nwrite:\n  - Engineer\n---\n');
    // The Engineer PLUGIN itself is granted on Knowledge — for the role principal that's a direct grant.
    const src = await svc.grantSources(workspaceId, 'folder', 'Knowledge', {
      kind: 'role',
      role: 'Engineer',
    });
    expect(src.write).toEqual([{ kind: 'direct' }]);
  });

  it('a principal with no effective access yields an empty map', async () => {
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    const src = await svc.grantSources(workspaceId, 'file', 'Knowledge/Deal.md', FELIX);
    expect(src).toEqual({});
  });

  it('owner folds in the lower verbs, all sourced from the owner grant', async () => {
    await writeFile(repo, 'access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile(repo, 'Knowledge/access.md', '---\nowner:\n  - Felix <felix@example.com>\n---\n');
    const src = await svc.grantSources(workspaceId, 'folder', 'Knowledge', FELIX);
    // owner is direct; the implied read/write/download also resolve to the same direct scope.
    expect(src.owner).toEqual([{ kind: 'direct' }]);
    expect(src.write).toEqual([{ kind: 'direct' }]);
    expect(src.read).toEqual([{ kind: 'direct' }]);
    expect(src.download).toEqual([{ kind: 'direct' }]);
  });
});
