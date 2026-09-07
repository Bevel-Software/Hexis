import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { readAgentPreamble, type PreambleWorkspace } from '../read-preamble.js';

/**
 * The reader against a real directory: a regular file is read, an absent one
 * is `null`, and anything that is not a regular file (a symlink above all,
 * since this file is read as the platform and broadcast to every agent) is
 * refused with an error rather than followed or reported as absent.
 */

const KB = 'knowledge-base';
let root: string;
let wsDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-preamble-'));
  wsDir = path.join(root, workspaceIdForBranch(DEFAULT_BRANCH));
  await fs.mkdir(path.join(wsDir, KB), { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function workspace(): PreambleWorkspace & { getOrCreateForBranch: ReturnType<typeof vi.fn>; getWorkspacePath: ReturnType<typeof vi.fn> } {
  return {
    getOrCreateForBranch: vi.fn(async () => ({ id: workspaceIdForBranch(DEFAULT_BRANCH) })) as never,
    getWorkspacePath: vi.fn(async () => wsDir) as never,
  };
}

describe('readAgentPreamble', () => {
  it('reads the default branch copy at <kbDirName>/mcp-description.md, creating the workspace first', async () => {
    await fs.writeFile(path.join(wsDir, KB, 'mcp-description.md'), 'Acme.\n', 'utf8');
    const ws = workspace();
    expect(await readAgentPreamble(ws, KB)).toBe('Acme.\n');
    expect(ws.getOrCreateForBranch).toHaveBeenCalledWith(DEFAULT_BRANCH);
    expect(ws.getWorkspacePath).toHaveBeenCalledWith(workspaceIdForBranch(DEFAULT_BRANCH));
  });

  it("spells the path with the deployment's own KB dir name", async () => {
    await fs.mkdir(path.join(wsDir, 'kb'), { recursive: true });
    await fs.writeFile(path.join(wsDir, 'kb', 'mcp-description.md'), 'Renamed root.', 'utf8');
    expect(await readAgentPreamble(workspace(), 'kb')).toBe('Renamed root.');
    expect(await readAgentPreamble(workspace(), KB)).toBeNull(); // the default-named root has none
  });

  it('only ENOENT is an absence', async () => {
    expect(await readAgentPreamble(workspace(), KB)).toBeNull();
  });

  it('refuses a symlink: the secret it points at is never read, and it is not an absence either', async () => {
    const secret = path.join(root, 'secret.txt');
    await fs.writeFile(secret, 'DATABASE_URL=postgres://…', 'utf8');
    await fs.symlink(secret, path.join(wsDir, KB, 'mcp-description.md'));
    await expect(readAgentPreamble(workspace(), KB)).rejects.toThrow(/symlink, not a regular file/);
  });

  it('refuses a directory squatting the name', async () => {
    await fs.mkdir(path.join(wsDir, KB, 'mcp-description.md'));
    await expect(readAgentPreamble(workspace(), KB)).rejects.toThrow(/directory, not a regular file/);
  });

  it('any other read error throws, never an empty preamble', async () => {
    const eio = Object.assign(new Error('disk'), { code: 'EIO' });
    const ws = workspace();
    ws.getWorkspacePath.mockImplementation(async () => {
      throw eio;
    });
    await expect(readAgentPreamble(ws, KB)).rejects.toBe(eio);
  });
});
