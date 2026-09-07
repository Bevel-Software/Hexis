import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceService, type ReadTreeFilter } from '../workspace.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

const KB = 'knowledge-base';

async function mkFile(dir: string, rel: string, body = 'x'): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf-8');
}

/** Flatten a FileTreeEntry into the set of relativePaths it contains. */
function paths(entry: { relativePath: string; children?: { relativePath: string; children?: unknown }[] }): string[] {
  const own = [entry.relativePath];
  const kids = (entry.children ?? []).flatMap((c) => paths(c as never));
  return [...own, ...kids];
}

describe('WorkspaceService.listFiles — read filter', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ws-rf-'));
    workspaceId = workspaceIdForBranch('target-company-state');
    workspaceDir = path.join(root, workspaceId);
    // The inner `<kbDir>/.git` makes resolveWorkspaceDir accept the workspace
    // without cloning.
    await fs.mkdir(path.join(workspaceDir, KB, '.git'), { recursive: true });
    // Fixture (workspace-relative): a readable folder, a denied folder, a
    // readable folder whose only child is denied, and a top-level file.
    await mkFile(workspaceDir, 'Open/a.md');
    await mkFile(workspaceDir, 'Open/b.md');
    await mkFile(workspaceDir, 'Secret/s1.md');
    await mkFile(workspaceDir, 'Secret/Vault/v1.md');
    await mkFile(workspaceDir, 'Mixed/hidden.md');
    await mkFile(workspaceDir, 'top.md');
    // A denied folder with a grant below it: Scopes/ itself is closed, but
    // Scopes/Deploy/ is shared (a linked skill's folder opened to a plugin's
    // readers, say), and its files are readable.
    await mkFile(workspaceDir, 'Scopes/Deploy/SKILL.md');
    await mkFile(workspaceDir, 'Scopes/other.md');
    svc = new WorkspaceService(root, 'https://example.invalid/repo.git', KB);
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('with no filter, returns the full tree (regression-safe)', async () => {
    const all = paths(await svc.listFiles(workspaceId));
    expect(all).toContain('Secret/s1.md');
    expect(all).toContain('Mixed/hidden.md');
    expect(all).toContain('Open/a.md');
  });

  it('CRITICAL regression: an all-permissive filter yields the IDENTICAL tree as no filter', async () => {
    // When access resolution says every path is readable, the tree must be
    // byte-for-byte what the pre-feature code returned.
    const allowAll: ReadTreeFilter = async (ps) => new Map(ps.map((p) => [p, true]));
    const unfiltered = await svc.listFiles(workspaceId);
    const filtered = await svc.listFiles(workspaceId, allowAll);
    expect(filtered).toEqual(unfiltered);
  });

  it('drops denied files, and a denied directory with nothing readable beneath it', async () => {
    const filter: ReadTreeFilter = async (ps) =>
      new Map(ps.map((p) => [p, !(p.includes('Secret') || p.includes('Scopes') || p.endsWith('hidden.md'))]));
    const all = paths(await svc.listFiles(workspaceId, filter));

    // Readable files survive.
    expect(all).toContain('Open/a.md');
    expect(all).toContain('Open/b.md');
    expect(all).toContain('top.md');
    // A denied directory whose whole subtree is denied is gone, with the
    // subtree — including a nested folder the walk did look into.
    expect(all).not.toContain('Secret');
    expect(all).not.toContain('Secret/s1.md');
    expect(all).not.toContain('Secret/Vault');
    expect(all).not.toContain('Scopes');
    // Denied file is gone.
    expect(all).not.toContain('Mixed/hidden.md');
  });

  it('keeps a denied directory as the way to what is readable beneath it', async () => {
    // Scopes/ is closed; Scopes/Deploy/ and its file are shared. The closed
    // folder shows as a container — the reader can reach the skill through
    // the tree — with its own contents still filtered (other.md is gone).
    const filter: ReadTreeFilter = async (ps) =>
      new Map(ps.map((p) => [p, p.startsWith('Scopes/Deploy') || (!p.includes('Secret') && !p.includes('Scopes') && !p.endsWith('hidden.md'))]));
    const all = paths(await svc.listFiles(workspaceId, filter));
    expect(all).toContain('Scopes');
    expect(all).toContain('Scopes/Deploy');
    expect(all).toContain('Scopes/Deploy/SKILL.md');
    expect(all).not.toContain('Scopes/other.md');
    // Unchanged for a subtree with nothing readable in it.
    expect(all).not.toContain('Secret');
  });

  it('keeps a readable directory left empty after filtering (D4)', async () => {
    const filter: ReadTreeFilter = async (ps) =>
      new Map(ps.map((p) => [p, !p.endsWith('hidden.md')]));
    const tree = await svc.listFiles(workspaceId, filter);
    // Find the Mixed directory node.
    const findNode = (
      e: { relativePath: string; type?: string; children?: unknown[] },
    ): { children?: unknown[] } | null => {
      if (e.relativePath === 'Mixed') return e;
      for (const c of (e.children ?? []) as { relativePath: string; children?: unknown[] }[]) {
        const hit = findNode(c);
        if (hit) return hit;
      }
      return null;
    };
    const mixed = findNode(tree as never);
    expect(mixed).not.toBeNull();
    expect((mixed!.children ?? []).length).toBe(0);
  });

  it('fails closed: a path not marked readable is dropped', async () => {
    // Filter returns an empty verdict for everything → nothing readable.
    const filter: ReadTreeFilter = async () => new Map();
    const all = paths(await svc.listFiles(workspaceId, filter));
    // Only the workspace root itself remains; every child was dropped.
    expect(all).toEqual(['.']);
  });
});
