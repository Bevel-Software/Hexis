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
 * The listings of PART of a workspace's tree: one folder's subtree
 * (`listFilesUnder`) and a tree cut at a depth (`listFilesToDepth`, and
 * `depth` on the folder listing).
 *
 * Two promises are held here. What they answer is what the whole tree holds
 * for the same folder, read filter and `.bevelignore` rules included. And
 * they walk only what they return: a caller that needs one folder of a
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

  describe('cut at a depth', () => {
    it('depth 1 is the folder\'s own entries, with its folders not looked into', async () => {
      const cut = (await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales`, { depth: 1 }))!;
      expect(cut.children!.map((c) => [c.name, c.type, 'children' in c])).toEqual([
        ['Customers', 'directory', false],
        ['Deals', 'directory', false],
        ['Empty', 'directory', false],
        ['pricing.md', 'file', false],
      ]);
    });

    it('depth 1 lists the one folder and no other', async () => {
      disk.listed = [];
      await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales`, { depth: 1 });
      expect(disk.listed).toEqual([`${KB}/Data/Sales`]);
    });

    it('depth 2 holds two levels, the same entries the whole tree has there', async () => {
      const cut = (await svc.listFilesUnder(workspaceId, `${KB}/Data/Sales`, { depth: 2 }))!;
      const whole = at(await svc.listFiles(workspaceId), `${KB}/Data/Sales`)!;
      expect(at(cut, 'Customers')).toEqual(at(whole, 'Customers'));
      expect(at(cut, 'Empty')).toEqual(at(whole, 'Empty'));
      // Deals is listed, Q1 beneath it is at the cut.
      expect(at(cut, 'Deals')!.children).toEqual([{ name: 'Q1', relativePath: `${KB}/Data/Sales/Deals/Q1`, type: 'directory' }]);
    });

    it('a depth past the bottom is the whole subtree', async () => {
      const whole = at(await svc.listFiles(workspaceId), `${KB}/Data`);
      expect(await svc.listFilesUnder(workspaceId, `${KB}/Data`, { depth: 50 })).toEqual(whole);
    });

    it('the whole workspace cut at a depth walks no folder below the cut', async () => {
      disk.listed = [];
      const cut = await svc.listFilesToDepth(workspaceId, 2);
      expect(disk.listed.sort()).toEqual(['', KB]);
      expect(at(cut, KB)!.children!.map((c) => c.name)).toEqual(['Data', 'Plugins', '.bevelignore', 'top.md']);
      expect('children' in at(cut, `${KB}/Data`)!).toBe(false);
    });

    it('a folder at the cut the caller may not read is left out and counted, not shown as a way further', async () => {
      const filter: ReadTreeFilter = async (ps) => new Map(ps.map((p) => [p, !p.endsWith('/Finance')]));
      const cut = (await svc.listFilesUnder(workspaceId, `${KB}/Data`, { depth: 1, readFilter: filter }))!;
      expect(cut.children!.map((c) => c.name)).toEqual(['Sales', '.bevelignore']);
      expect(cut.withheld).toBe(1);
      // With the depth to see beneath it, the folder is the way to Payroll.
      const deeper = (await svc.listFilesUnder(workspaceId, `${KB}/Data`, { depth: 3, readFilter: filter }))!;
      expect(paths(deeper)).toContain(`${KB}/Data/Finance/Payroll/march.md`);
    });
  });
});
