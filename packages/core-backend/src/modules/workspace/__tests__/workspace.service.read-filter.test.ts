import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  WorkspaceService,
  workspaceIdForBranch,
  type ReadTreeFilter,
} from '../workspace.service.js';

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
    await mkFile(workspaceDir, 'Mixed/hidden.md');
    await mkFile(workspaceDir, 'top.md');
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

  it('drops denied files and denied directories (subtree skipped)', async () => {
    const asked: string[] = [];
    const filter: ReadTreeFilter = async (ps) => {
      asked.push(...ps);
      return new Map(ps.map((p) => [p, !(p.includes('Secret') || p.endsWith('hidden.md'))]));
    };
    const tree = await svc.listFiles(workspaceId, filter);
    const all = paths(tree);

    // Readable files survive.
    expect(all).toContain('Open/a.md');
    expect(all).toContain('Open/b.md');
    expect(all).toContain('top.md');
    // Denied directory and its whole subtree are gone.
    expect(all).not.toContain('Secret');
    expect(all).not.toContain('Secret/s1.md');
    // Denied file is gone.
    expect(all).not.toContain('Mixed/hidden.md');
    // The denied directory's subtree is never walked — the filter is never
    // asked about a path inside Secret/.
    expect(asked.some((p) => p.startsWith('Secret/'))).toBe(false);
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
