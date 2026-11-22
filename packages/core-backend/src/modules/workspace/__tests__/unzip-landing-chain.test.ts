/**
 * `unzip`'s landing, end to end through the real pieces: the service's
 * extraction (`WorkspaceService.unzipFile`), the file lock and the gate asked
 * before it and again under it (`LockingFilesystem.landUnderLock`), and a
 * bot's real access guard (`makeBotAccessWriteValidator`), whose verdict
 * depends on what the file holds now. Only the lock store is a stand-in.
 *
 * The contract under test: an explicit policy refusal (the guard saying no, a
 * lock somebody else keeps) skips the file and the rest is extracted; a
 * FAILURE (the guard cannot read the file it judges, before the lock or under
 * it; the lock store fails; the write fails on disk) fails the request, leaves
 * no lock held and lands nothing at that file's name, while the files
 * extracted before it stay on disk, uncommitted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AuthUser, IVersionControlService } from '@bevel-software/platform-shared';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { newWorkspaceService } from '../../../__tests__/workspace-service.js';
import { realDisk } from '../../../__tests__/real-disk.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { LockingFilesystem } from '../../kb-fs/index.js';
import { makeBotAccessWriteValidator } from '../../access-model/index.js';
import type { WorkspaceService } from '../workspace.service.js';

const KB = 'knowledge-base';
const BOT: AuthUser = { id: 'bot-1', email: 'helper@agent.hexis', name: 'Helper' } as AuthUser;
const FIRST = `${KB}/out/a-first.md`;
const TARGET = `${KB}/out/b-target.md`;

describe('unzip landing — the real chain: extraction, file lock, bot guard asked before the lock and under it', () => {
  let root: string;
  let workspaceDir: string;
  let workspaceId: string;
  let svc: WorkspaceService;
  let held: Set<string>;
  let versionControl: IVersionControlService;
  let acquireFor: (p: string) => Promise<{ acquired: boolean; lock: { holderName: string } }>;
  /** How the guard's read of the current file answers, per look. */
  let readFails: { before?: unknown; under?: unknown };
  /** Paths the guard's read treats as absent whatever is on disk. */
  let absent: Set<string>;

  const disk = (wsPath: string) => path.join(workspaceDir, wsPath);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-unzip-chain-'));
    workspaceId = workspaceIdForBranch('feat');
    workspaceDir = path.join(root, workspaceId);
    await fs.mkdir(path.join(workspaceDir, KB, '.git'), { recursive: true });
    svc = newWorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), realDisk());
    await svc.getWorkspacePath(workspaceId);
    held = new Set();
    readFails = {};
    absent = new Set();
    acquireFor = async (p) => {
      held.add(p);
      return { acquired: true, lock: { holderName: 'Helper' } };
    };
    versionControl = {
      acquireLock: vi.fn(async (_w: string, _b: string, p: string) => acquireFor(p)),
      releaseLockUntouched: vi.fn(async (_w: string, _b: string, p: string) => {
        held.delete(p);
      }),
      releaseLock: vi.fn(),
      releaseLockNoCommit: vi.fn(),
    } as unknown as IVersionControlService;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeZip(files: Record<string, string>): Promise<void> {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
    await fs.writeFile(disk(`${KB}/a.zip`), zip.toBuffer());
  }

  /** The bot's unzip of `a.zip` into `out`, landed as the unzip tool lands it. */
  function unzip() {
    const readCurrent = async (wsPath: string): Promise<string | null> => {
      if (wsPath === TARGET) {
        const failure = held.has(wsPath) ? readFails.under : readFails.before;
        if (failure !== undefined) throw failure;
      }
      if (absent.has(wsPath)) return null;
      try {
        return await fs.readFile(disk(wsPath), 'utf-8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    };
    const lfs = new LockingFilesystem(
      { basePath: workspaceDir, contained: true },
      {
        versionControl,
        workspaceId,
        branch: 'feat',
        user: BOT,
        kbDirName: KB,
        validateWrite: makeBotAccessWriteValidator(KB, readCurrent),
      },
    );
    return svc.unzipFile(workspaceId, `${KB}/a.zip`, `${KB}/out`, async () => {}, (p, c, write) => lfs.landUnderLock(p, c, write));
  }

  const unreadable = () => Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });

  it('extracts what the guard allows and skips what it refuses: an access file, a page whose access lines would change', async () => {
    await fs.mkdir(disk(`${KB}/out`), { recursive: true });
    await fs.writeFile(disk(TARGET), '---\nread:\n  - Eng\n---\n# old\n');
    await writeZip({ 'a-first.md': '# first\n', 'b-target.md': '# new, open to all\n', 'access.md': 'read:\n  - everyone\n' });
    const res = await unzip();
    expect(res.extracted).toEqual([FIRST]);
    expect([...res.skipped].sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'access.md', reason: expect.stringContaining('A bot cannot change access') },
      { path: 'b-target.md', reason: expect.stringContaining('A bot cannot change access') },
    ]);
    expect(await fs.readFile(disk(TARGET), 'utf-8')).toContain('- Eng');
    await expect(fs.stat(disk(`${KB}/out/access.md`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(held.size).toBe(0);
  });

  it('a failed read of the current file BEFORE the lock fails the request: no lock is taken for it, the earlier file stays', async () => {
    const failure = unreadable();
    readFails.before = failure;
    await writeZip({ 'a-first.md': '# first\n', 'b-target.md': '# target\n' });
    await expect(unzip()).rejects.toBe(failure);
    expect(versionControl.acquireLock).not.toHaveBeenCalledWith(workspaceId, 'feat', TARGET, BOT);
    await expect(fs.stat(disk(TARGET))).rejects.toMatchObject({ code: 'ENOENT' });
    // Partial extraction: the file landed before the failure stays on disk, uncommitted.
    expect(await fs.readFile(disk(FIRST), 'utf-8')).toBe('# first\n');
    expect(held.size).toBe(0);
  });

  // The regression test for the under-lock revalidation: remove the second
  // look in `landUnderLock` and both cases below pass the file through.
  it('the guard is asked again UNDER the lock: a read that fails there fails the request, and a page that gained access lines meanwhile is refused', async () => {
    // A read that fails under the lock: a failure, the lock released untouched.
    const failure = unreadable();
    readFails.under = failure;
    await writeZip({ 'a-first.md': '# first\n', 'b-target.md': '# target\n' });
    await expect(unzip()).rejects.toBe(failure);
    await expect(fs.stat(disk(TARGET))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(disk(FIRST), 'utf-8')).toBe('# first\n');
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith(workspaceId, 'feat', TARGET, BOT);
    expect(held.size).toBe(0);

    // A save that lands between the first look and the lock: the page gains
    // access lines the bot's bytes would drop. The look under the lock sees
    // it and refuses; the page keeps its lines.
    readFails = {};
    await fs.writeFile(disk(TARGET), '# plain\n');
    acquireFor = async (p) => {
      if (p === TARGET) await fs.writeFile(disk(TARGET), '---\nread:\n  - Eng\n---\n# plain\n');
      held.add(p);
      return { acquired: true, lock: { holderName: 'Helper' } };
    };
    const res = await unzip();
    expect(res.skipped).toEqual([{ path: 'b-target.md', reason: expect.stringContaining('A bot cannot change access') }]);
    expect(await fs.readFile(disk(TARGET), 'utf-8')).toContain('- Eng');
    expect(held.size).toBe(0);
  });

  it('a lock somebody else keeps skips the file and the rest is extracted', async () => {
    acquireFor = async (p) => {
      if (p === TARGET) return { acquired: false, lock: { holderName: 'Bob' } };
      held.add(p);
      return { acquired: true, lock: { holderName: 'Helper' } };
    };
    await writeZip({ 'a-first.md': '# first\n', 'b-target.md': '# target\n' });
    const res = await unzip();
    expect(res.extracted).toEqual([FIRST]);
    expect(res.skipped).toEqual([{ path: 'b-target.md', reason: expect.stringMatching(/locked by Bob/) }]);
    await expect(fs.stat(disk(TARGET))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('the lock store failing fails the request, and the earlier file stays', async () => {
    const down = new Error('connection terminated');
    acquireFor = async (p) => {
      if (p === TARGET) throw down;
      held.add(p);
      return { acquired: true, lock: { holderName: 'Helper' } };
    };
    await writeZip({ 'a-first.md': '# first\n', 'b-target.md': '# target\n' });
    await expect(unzip()).rejects.toBe(down);
    await expect(fs.stat(disk(TARGET))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(disk(FIRST), 'utf-8')).toBe('# first\n');
    expect(held.size).toBe(0);
  });

  it('a write that fails on disk fails the request and releases the lock untouched', async () => {
    // A folder holds the file's name; the guard reads it as a new file, so
    // the failure is the landing's own.
    await fs.mkdir(disk(TARGET), { recursive: true });
    absent.add(TARGET);
    await writeZip({ 'a-first.md': '# first\n', 'b-target.md': '# target\n' });
    await expect(unzip()).rejects.toMatchObject({ code: 'EISDIR' });
    expect(versionControl.releaseLockUntouched).toHaveBeenCalledWith(workspaceId, 'feat', TARGET, BOT);
    expect(held.size).toBe(0);
    expect(await fs.readFile(disk(FIRST), 'utf-8')).toBe('# first\n');
  });
});
