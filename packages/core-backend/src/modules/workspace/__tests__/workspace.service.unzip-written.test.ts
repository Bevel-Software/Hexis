import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../index.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { newWorkspaceService } from '../../../__tests__/workspace-service.js';

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ws-'));
}

/**
 * Pre-seed a branch's on-disk workspace so the slow (clone) path isn't
 * exercised: the inner `<kbDirName>/.git` directory is what lets
 * `resolveWorkspaceDir` accept the workspace without cloning.
 */
async function seedBranchWorkspace(
  root: string,
  branch: string,
  kbDirName = 'knowledge-base',
): Promise<{ workspaceId: string; workspaceDir: string }> {
  const workspaceId = workspaceIdForBranch(branch);
  const workspaceDir = path.join(root, workspaceId);
  await fs.mkdir(path.join(workspaceDir, kbDirName, '.git'), { recursive: true });
  return { workspaceId, workspaceDir };
}

/**
 * What `unzipFile` tells its caller through `onWritten`: the files whose bytes
 * are on disk, the only paths the agent `unzip` tool may commit, even when the
 * extraction fails after them.
 */
describe('WorkspaceService.unzipFile — onWritten', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    workspaceId = seeded.workspaceId;
    svc = newWorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), realDisk());
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports each file once its bytes are on disk, and never a directory entry the guard was asked about', async () => {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    zip.addFile('folder/', Buffer.alloc(0)); // bare directory entry: guarded, then created, never written
    zip.addFile('folder/page.md', Buffer.from('ok'));
    await fs.writeFile(path.join(workspaceDir, 'knowledge-base', 'd.zip'), zip.toBuffer());

    const guarded: string[] = [];
    const written: string[] = [];
    const res = await svc.unzipFile(
      workspaceId,
      'd.zip',
      'out',
      async (wsPath) => {
        guarded.push(wsPath);
      },
      (wsPath) => {
        // Reported after the write, so the bytes are already there.
        written.push(wsPath);
        expect(existsSync(path.join(workspaceDir, wsPath))).toBe(true);
      },
    );

    expect(guarded).toContain('knowledge-base/out/folder');
    expect(written).toEqual(['knowledge-base/out/folder/page.md']);
    expect(res.extracted).toEqual(written);
  });
});
