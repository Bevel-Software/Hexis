import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import type { ITreeWalker, TreeWalkOptions, WalkListener, WalkResult } from '../../../shared/fs.contract.js';
import { WorkspaceService, type ReadTreeFilter } from '../workspace.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { newWorkspaceService } from '../../../__tests__/workspace-service.js';

/**
 * The listing of PART of a workspace's tree: one folder's subtree
 * (`listFilesUnder`).
 *
 * Two promises are held here. What it answers is what the whole tree holds
 * for the same folder, read filter and `.bevelignore` rules included. And
 * it walks only what it returns: a caller that needs one folder of a
 * knowledge base of thousands does not pay for the rest.
 */

const KB = 'knowledge-base';

/**
 * The real disk (from the fixture that stands in for the composition root),
 * recording which folders a walk listed, workspace-relative.
 */
function countingDisk(base: () => string): ITreeWalker & { listed: string[] } {
  const disk = Object.assign(realDisk(), { listed: [] as string[] });
  const walk = disk.walk.bind(disk);
  disk.walk = (root: string, options: TreeWalkOptions, listeners: readonly WalkListener[]): Promise<WalkResult> => {
    const rel = (dir: string) => path.relative(base(), path.join(root, dir)).replace(/\\/g, '/');
    return walk(root, options, [...listeners, { onDir: (dir) => void disk.listed.push(rel(dir)) }]);
  };
  return disk;
}

async function mkFile(dir: string, rel: string, body = 'x'): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf-8');
}

function at(tree: FileTreeEntry, wsPath: string): FileTreeEntry | null {
  return wsPath
    .split('/')
    .filter(Boolean)
    .reduce<FileTreeEntry | null>((node, segment) => node?.children?.find((c) => c.name === segment) ?? null, tree);
}

function paths(entry: FileTreeEntry): string[] {
  return [entry.relativePath, ...(entry.children ?? []).flatMap(paths)];
}

describe('WorkspaceService — listings of part of the tree', () => {
  let root: string;
  let svc: WorkspaceService;
  let disk: ReturnType<typeof countingDisk>;
  let workspaceDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ws-under-'));
    workspaceId = workspaceIdForBranch('target-company-state');
    workspaceDir = path.join(root, workspaceId);
    await fs.mkdir(path.join(workspaceDir, KB, '.git'), { recursive: true });
    await mkFile(workspaceDir, `${KB}/top.md`);
    await mkFile(workspaceDir, `${KB}/Data/Sales/Customers/acme.md`);
    await mkFile(workspaceDir, `${KB}/Data/Sales/Customers/globex.md`);
    await mkFile(workspaceDir, `${KB}/Data/Sales/Deals/Q1/big.md`);
    await mkFile(workspaceDir, `${KB}/Data/Sales/pricing.md`);
    await mkFile(workspaceDir, `${KB}/Data/Sales/Empty/.gitkeep`, '');
    await mkFile(workspaceDir, `${KB}/Data/Finance/ledger.md`);
    await mkFile(workspaceDir, `${KB}/Data/Finance/Payroll/march.md`);
    await mkFile(workspaceDir, `${KB}/Plugins/sales/plugin.json`, '{}');
    // Rules at two heights: the root hides every `*.tmp`, Data hides a folder
    // of its own and a file by name.
    await mkFile(workspaceDir, `${KB}/.bevelignore`, '*.tmp\n');
    await mkFile(workspaceDir, `${KB}/Data/.bevelignore`, 'Archive/\nscratch.md\n');
    await mkFile(workspaceDir, `${KB}/Data/Sales/notes.tmp`);
    await mkFile(workspaceDir, `${KB}/Data/Sales/scratch.md`);
    await mkFile(workspaceDir, `${KB}/Data/Archive/old.md`);
    await mkFile(workspaceDir, `${KB}/Data/Archive/Deep/older.md`);
    disk = countingDisk(() => workspaceDir);
    svc = newWorkspaceService(root, 'https://example.invalid/repo.git', testKbContext({ kbDirName: KB }), disk);
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const FOLDERS = [KB, `${KB}/Data`, `${KB}/Data/Sales`, `${KB}/Data/Sales/Customers`, `${KB}/Data/Sales/Deals/Q1`, `${KB}/Data/Sales/Empty`, `${KB}/Plugins/sales`];

  describe('one folder', () => {
    it.each(FOLDERS)('%s: is what the whole tree holds for it', async (folder) => {
      const whole = at(await svc.listFiles(workspaceId), folder);
      expect(whole).not.toBeNull();
      expect(await svc.listFilesUnder(workspaceId, folder)).toEqual(whole);
    });

    it.each(FOLDERS)('%s: is what the whole tree holds for it under a read filter', async (folder) => {
      // Finance is closed apart from Payroll beneath it; one customer is closed.
      const filter: ReadTreeFilter = async (ps) =>
        new Map(ps.map((p) => [p, !(p.endsWith('/Finance') || p.endsWith('ledger.md') || p.endsWith('globex.md'))]));
      const whole = at(await svc.listFiles(workspaceId, filter), folder);
      expect(await svc.listFilesUnder(workspaceId, folder, { readFilter: filter })).toEqual(whole);
    });

    it('walks the folder and nothing beside or above it', async () => {
      disk.listed = [];
      await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales`);
      expect(disk.listed.sort()).toEqual([
        `${KB}/Data/Sales`,
        `${KB}/Data/Sales/Customers`,
        `${KB}/Data/Sales/Deals`,
        `${KB}/Data/Sales/Deals/Q1`,
        `${KB}/Data/Sales/Empty`,
      ]);
    });

    it('applies the .bevelignore rules of the folders above it', async () => {
      const listed = paths((await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales`))!);
      expect(listed).toContain(`${KB}/Data/Sales/pricing.md`);
      expect(listed).not.toContain(`${KB}/Data/Sales/notes.tmp`);
      expect(listed).not.toContain(`${KB}/Data/Sales/scratch.md`);
    });

    it('answers null for a folder a rule above hides, and for one inside it', async () => {
      expect(await svc.listFilesUnder(workspaceId, `${KB}/Data/Archive`)).toBeNull();
      expect(await svc.listFilesUnder(workspaceId, `${KB}/Data/Archive/Deep`)).toBeNull();
    });

    it('answers null where nothing is', async () => {
      expect(await svc.listFilesUnder(workspaceId, `${KB}/Data/Nowhere`)).toBeNull();
      expect(await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales/pricing.md/x`)).toBeNull();
    });

    it('answers a file with its own entry, as the tree holds it', async () => {
      const file = `${KB}/Data/Sales/pricing.md`;
      expect(await svc.listFilesUnder(workspaceId, file)).toEqual(at(await svc.listFiles(workspaceId), file));
    });

    it('answers null for a file a rule hides, one the filter withholds, and the folder placeholder', async () => {
      expect(await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales/notes.tmp`)).toBeNull();
      expect(await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales/scratch.md`)).toBeNull();
      expect(await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales/Empty/.gitkeep`)).toBeNull();
      const none: ReadTreeFilter = async (ps) => new Map(ps.map((p) => [p, false]));
      expect(await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales/pricing.md`, { readFilter: none })).toBeNull();
    });

    it('refuses a path that leaves the repository, and the git folder', async () => {
      await expect(svc.listFilesUnder(workspaceId, `${KB}/../..`)).rejects.toThrow();
      await expect(svc.listFilesUnder(workspaceId, `${KB}/.git`)).rejects.toThrow();
    });
  });
});
