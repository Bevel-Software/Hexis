import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceService } from '../workspace.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';

const execFileAsync = promisify(execFile);

async function mkTmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bevel-ws-'));
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
}

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/**
 * Pre-seed a branch's on-disk workspace so the slow (clone) path isn't
 * exercised in the unit suite. We need the inner `<kbDirName>/.git`
 * directory to exist so `resolveWorkspaceDir` accepts the workspace
 * without trying to clone.
 */
async function seedBranchWorkspace(
  root: string,
  branch: string,
  kbDirName = 'knowledge-base',
): Promise<{ workspaceId: string; workspaceDir: string }> {
  const workspaceId = workspaceIdForBranch(branch);
  const workspaceDir = path.join(root, workspaceId);
  const gitDir = path.join(workspaceDir, kbDirName, '.git');
  await fs.mkdir(gitDir, { recursive: true });
  return { workspaceId, workspaceDir };
}

describe('WorkspaceService — branch-keyed identity', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('workspaceIdForBranch encodes branches with "/" so they fit a single dir segment', () => {
    expect(workspaceIdForBranch('target-company-state')).toBe('target-company-state');
    expect(workspaceIdForBranch('alice/feature')).toBe('alice%2Ffeature');
  });

  it('a malformed workspace id (bad percent-escape) rejects as a 400 BranchNameError, not a 500', async () => {
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    // `%zz` fails decodeURIComponent, falls back to itself, and `%` never
    // passes the branch-name rules — the cold-path bootstrap must surface
    // that as the status-carrying domain error, not a wrapped plain Error.
    await expect(svc.readFile('%zz', 'roles.yaml')).rejects.toMatchObject({
      name: 'BranchNameError',
      status: 400,
    });
  });

  it('returns workspace info derived from the branch — no .workspace.json on disk', async () => {
    const { workspaceId, workspaceDir } = await seedBranchWorkspace(root, 'target-company-state');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    const info = await svc.getOrCreateForBranch('target-company-state');

    expect(info.id).toBe(workspaceId);
    expect(info.name).toBe('target-company-state');
    expect(info.absolutePath).toBe(workspaceDir);
    expect(info.kbDirName).toBe('knowledge-base');
    expect(await svc.getWorkspacePath(workspaceId)).toBe(workspaceDir);
  });

  it('two branches map to distinct directories', async () => {
    const a = await seedBranchWorkspace(root, 'target-company-state');
    const b = await seedBranchWorkspace(root, 'alice/feature');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());

    const infoA = await svc.getOrCreateForBranch('target-company-state');
    const infoB = await svc.getOrCreateForBranch('alice/feature');

    expect(infoA.absolutePath).toBe(a.workspaceDir);
    expect(infoB.absolutePath).toBe(b.workspaceDir);
    expect(infoA.absolutePath).not.toBe(infoB.absolutePath);
    // alice%2Ffeature lands in a single dir segment, not nested.
    expect(infoB.absolutePath).toBe(path.join(root, 'alice%2Ffeature'));
  });

  it('refuses a FILE squatting the clone path instead of wiping it, and leaves the bytes alone', async () => {
    // The bootstrap's recovery — wipe and re-clone — is for a crashed
    // bootstrap's directory shell. A regular file at the clone's name is a
    // state a human put the deployment in, and ENOTDIR from the `.git` probe
    // beneath it is absence like any other, so nothing distinguishes the two
    // unless the clone path itself is checked. It must never be deleted.
    const workspaceDir = path.join(root, workspaceIdForBranch('target-company-state'));
    await fs.mkdir(workspaceDir, { recursive: true });
    const squatter = path.join(workspaceDir, 'knowledge-base');
    await fs.writeFile(squatter, 'not a clone', 'utf8');

    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    await expect(svc.getOrCreateForBranch('target-company-state')).rejects.toThrow(
      /"knowledge-base" in this workspace exists but is not a directory/,
    );
    expect(await fs.readFile(squatter, 'utf8')).toBe('not a clone');
  });

  it('rejects invalid branch names before touching disk', async () => {
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    await expect(svc.getOrCreateForBranch('')).rejects.toThrow();
    await expect(svc.getOrCreateForBranch('-bad-leading-dash')).rejects.toThrow();
  });

  it('getOrCreateForUser falls back to target-company-state when no branch is supplied', async () => {
    await seedBranchWorkspace(root, 'target-company-state');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    const info = await svc.getOrCreateForUser({ id: 'u', email: 'a@b.c', name: 'A' });
    expect(info.id).toBe(workspaceIdForBranch('target-company-state'));
  });

  it('getOrCreateForUser respects an explicit branch override', async () => {
    await seedBranchWorkspace(root, 'alice/feature');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    const info = await svc.getOrCreateForUser({ id: 'u', email: 'a@b.c', name: 'A' }, 'alice/feature');
    expect(info.id).toBe(workspaceIdForBranch('alice/feature'));
  });
});

describe('WorkspaceService.createDirectory', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  /** Where a created folder goes: inside the checkout, whatever the caller spelled. */
  let repoDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    repoDir = path.join(workspaceDir, 'knowledge-base');
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    // Hydrate the in-memory map so subsequent ops resolve fast.
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates a .gitkeep inside a fresh empty folder — in the repository, from an unprefixed path', async () => {
    await svc.createDirectory(workspaceId, 'a');
    const absDir = path.join(repoDir, 'a');
    // …and nothing beside the checkout, which is the whole point of the ticket.
    await expect(fs.stat(path.join(workspaceDir, 'a'))).rejects.toMatchObject({ code: 'ENOENT' });
    const dirStat = await fs.stat(absDir);
    expect(dirStat.isDirectory()).toBe(true);
    const gitkeep = await fs.readFile(path.join(absDir, '.gitkeep'), 'utf-8');
    expect(gitkeep).toBe('');
  });

  it('does not add a .gitkeep when the folder already has content', async () => {
    const absDir = path.join(repoDir, 'has-content');
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(path.join(absDir, 'real.md'), 'hello', 'utf-8');

    await svc.createDirectory(workspaceId, 'has-content');

    const entries = await fs.readdir(absDir);
    expect(entries.sort()).toEqual(['real.md']);
  });

  it('does not duplicate a .gitkeep when one already exists', async () => {
    const absDir = path.join(repoDir, 'kept');
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(path.join(absDir, '.gitkeep'), '', 'utf-8');

    await svc.createDirectory(workspaceId, 'kept');

    const entries = await fs.readdir(absDir);
    expect(entries).toEqual(['.gitkeep']);
  });

  it('only writes a .gitkeep in the leaf for nested paths', async () => {
    await svc.createDirectory(workspaceId, 'a/b/c');

    const aEntries = await fs.readdir(path.join(repoDir, 'a'));
    const bEntries = await fs.readdir(path.join(repoDir, 'a', 'b'));
    const cEntries = await fs.readdir(path.join(repoDir, 'a', 'b', 'c'));

    expect(aEntries).toEqual(['b']);
    expect(bEntries).toEqual(['c']);
    expect(cEntries).toEqual(['.gitkeep']);
  });

  it('hides .gitkeep entries from listFiles', async () => {
    await svc.createDirectory(workspaceId, 'visible-empty');
    await fs.writeFile(path.join(repoDir, 'visible-empty', '.gitkeep'), '', 'utf-8');
    const mixed = path.join(repoDir, 'mixed');
    await fs.mkdir(mixed, { recursive: true });
    await fs.writeFile(path.join(mixed, '.gitkeep'), '', 'utf-8');
    await fs.writeFile(path.join(mixed, 'real.md'), 'hi', 'utf-8');

    const tree = await svc.listFiles(workspaceId);

    const collectNames = (entry: typeof tree): string[] => {
      const own = [entry.name];
      const kids = entry.children?.flatMap(collectNames) ?? [];
      return [...own, ...kids];
    };
    const names = collectNames(tree);
    expect(names).not.toContain('.gitkeep');
    expect(names).toContain('visible-empty');
    expect(names).toContain('real.md');
  });

  it('hides mcp-description.md when the root .bevelignore declares the platform rule', async () => {
    const repoDir = path.join(workspaceDir, 'knowledge-base');
    const nestedDir = path.join(repoDir, 'KnowledgeBase');
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(repoDir, '.bevelignore'), '/mcp-description.md\n', 'utf-8');
    await fs.writeFile(path.join(repoDir, 'mcp-description.md'), 'Private deployment preamble', 'utf-8');
    await fs.writeFile(path.join(nestedDir, 'mcp-description.md'), 'Ordinary nested knowledge', 'utf-8');
    await fs.writeFile(path.join(repoDir, 'visible.md'), 'Visible knowledge', 'utf-8');

    const tree = await svc.listFiles(workspaceId);
    const repo = tree.children?.find((entry) => entry.name === 'knowledge-base');
    const names = repo?.children?.map((entry) => entry.name) ?? [];

    expect(names).toContain('visible.md');
    expect(repo?.children?.find((entry) => entry.name === 'KnowledgeBase')?.children?.map((entry) => entry.name))
      .toContain('mcp-description.md');
    expect(names).not.toContain('mcp-description.md');
  });
});

/**
 * `writeFile`'s conditional write: the caller states the bytes it last read
 * and the write is refused if the file no longer holds them. The compare and
 * the write are one call so the route's per-path lock covers both.
 */
describe('WorkspaceService.writeFile — expectedContent', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes when the file still holds the expected content', async () => {
    const rel = 'knowledge-base/mcp-description.md';
    await fs.writeFile(path.join(workspaceDir, rel), 'Before.', 'utf-8');

    await svc.writeFile(workspaceId, rel, 'After.', { expectedContent: 'Before.' });

    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe('After.');
  });

  it('refuses with a 409 and leaves the file alone when it changed underneath', async () => {
    const rel = 'knowledge-base/mcp-description.md';
    await fs.writeFile(path.join(workspaceDir, rel), "Another admin's text.", 'utf-8');

    await expect(
      svc.writeFile(workspaceId, rel, 'My stale merge.', { expectedContent: 'What I loaded.' }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe("Another admin's text.");
  });

  it("treats an absent file as the empty string, so expecting '' creates it", async () => {
    const rel = 'knowledge-base/mcp-description.md';

    await svc.writeFile(workspaceId, rel, 'First write.', { expectedContent: '' });

    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe('First write.');
  });

  it('refuses to create over a file the caller believed absent', async () => {
    const rel = 'knowledge-base/mcp-description.md';
    await fs.writeFile(path.join(workspaceDir, rel), 'Seeded since the editor opened.', 'utf-8');

    await expect(
      svc.writeFile(workspaceId, rel, 'From an empty editor.', { expectedContent: '' }),
    ).rejects.toMatchObject({ status: 409 });

    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe('Seeded since the editor opened.');
  });

  it('leaves no directory behind when it refuses', async () => {
    // "A refused save leaves nothing behind" has to include the parent chain.
    const rel = 'knowledge-base/new-folder/note.md';
    await fs.writeFile(path.join(workspaceDir, 'knowledge-base', 'taken.md'), 'x', 'utf-8');

    await expect(
      svc.writeFile(workspaceId, rel, 'mine', { expectedContent: 'not what is there' }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(fs.stat(path.join(workspaceDir, 'knowledge-base', 'new-folder'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('still creates the parent chain for a save that goes ahead', async () => {
    const rel = 'knowledge-base/new-folder/note.md';

    await svc.writeFile(workspaceId, rel, 'mine', { expectedContent: '' });

    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe('mine');
  });

  it('refuses an absolute path rather than writing it inside the workspace', async () => {
    // The property canonicalisation must not erode: `path.resolve` lets an
    // absolute path win over the workspace dir, and the boundary check is what
    // refuses it. A canonicaliser that dropped the empty leading segment would
    // turn this into an ordinary write at `<workspace>/etc/passwd`.
    //
    // THE NORMALISER is what answers here, and its message names the path and
    // a correction. It refuses the absolute path outright rather than placing
    // it under the repository folder: an unprefixed `etc/passwd` is an ordinary
    // page name, `/etc/passwd` is an attempt to leave, and the two must not be
    // read as the same request.
    await expect(
      svc.writeFile(workspaceId, '/etc/passwd', 'pwned', { expectedContent: '' }),
    ).rejects.toThrow('is outside the knowledge base repository');
  });

  it('is not applied at all when the option is absent', async () => {
    const rel = 'knowledge-base/mcp-description.md';
    await fs.writeFile(path.join(workspaceDir, rel), 'Whatever.', 'utf-8');

    await svc.writeFile(workspaceId, rel, 'Replaced.');

    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe('Replaced.');
  });

  it('serializes writes per path, so two concurrent conditional saves cannot both pass', async () => {
    // The compare and the write are two awaits apart. Without a turn per path
    // both saves read the same bytes, both pass, and the loser's text is gone
    // with no 409 to show for it.
    const rel = 'knowledge-base/mcp-description.md';
    await fs.writeFile(path.join(workspaceDir, rel), 'Before.', 'utf-8');

    const [first, second] = await Promise.allSettled([
      svc.writeFile(workspaceId, rel, 'From A.', { expectedContent: 'Before.' }),
      svc.writeFile(workspaceId, rel, 'From B.', { expectedContent: 'Before.' }),
    ]);

    const settled = [first, second];
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 409 });
    // Whichever won, the file holds ITS text whole — never a mix, never the loser's.
    const landed = await fs.readFile(path.join(workspaceDir, rel), 'utf-8');
    expect(landed).toBe(first.status === 'fulfilled' ? 'From A.' : 'From B.');
  });

  it('refuses a conditional write against a directory as a client error, not a raw failure', async () => {
    // `GET /file` counts EISDIR as "no file at this path" and the editor opens
    // empty on that 404, so the save that follows must say what is wrong.
    await fs.mkdir(path.join(workspaceDir, 'knowledge-base', 'a-folder'), { recursive: true });

    await expect(
      svc.writeFile(workspaceId, 'knowledge-base/a-folder', 'text', { expectedContent: '' }),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('is a directory') });
  });
});

/**
 * The per-path turn the conditional write rests on: what queues behind what,
 * that two spellings of one file are one queue, and that a caller holding a
 * turn can still call the ordinary write inside it.
 */
describe('WorkspaceService.withPathTurn', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Yield to the microtask queue enough times that an unserialized body interleaves. */
  const yieldTwice = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  /**
   * A turn whose body records when it runs — and, for the FIRST one, tells
   * the test when it HOLDS the turn, so the next can be issued behind it.
   *
   * What the queue guarantees is one body at a time per file. It does NOT
   * guarantee that turns issued together chain in the order they were
   * issued: before a turn joins the queue its spelling is resolved and judged
   * against the git folder on disk, and those probes finish in whatever order
   * the disk answers, so a later call can join first. Asserting on names in a
   * fixed order therefore needs the earlier turn to be HELD before the later
   * one is issued; interleaving is then the only thing that could reorder.
   */
  const recorder = (order: string[]) => {
    let holding: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { holding = resolve; });
    const body = (name: string) => async (): Promise<void> => {
      order.push(`${name}:enter`);
      holding?.();
      await yieldTwice();
      order.push(`${name}:exit`);
    };
    return { body, held };
  };

  /** Each name's exit follows its own enter at once: no body ran inside another. */
  const expectNoInterleaving = (order: string[], names: string[]): void => {
    for (const name of names) {
      const enter = order.indexOf(`${name}:enter`);
      expect(enter).toBeGreaterThanOrEqual(0);
      expect(order[enter + 1]).toBe(`${name}:exit`);
    }
  };

  it('runs one turn at a time, so two bodies never interleave', async () => {
    const order: string[] = [];
    const { body, held } = recorder(order);

    const a = svc.withPathTurn(workspaceId, 'knowledge-base/mcp-description.md', body('a'));
    await held;
    const b = svc.withPathTurn(workspaceId, 'knowledge-base/mcp-description.md', body('b'));
    await Promise.all([a, b]);

    expect(order).toEqual(['a:enter', 'a:exit', 'b:enter', 'b:exit']);
  });

  it('treats two spellings of one file as one queue', async () => {
    const order: string[] = [];
    const { body, held } = recorder(order);

    const plain = svc.withPathTurn(workspaceId, 'knowledge-base/mcp-description.md', body('plain'));
    await held;
    // Issued together: they may join in either order, but each waits for
    // `plain` and for each other, because all three name one file.
    await Promise.all([
      plain,
      svc.withPathTurn(workspaceId, './knowledge-base/mcp-description.md', body('dotted')),
      svc.withPathTurn(workspaceId, 'knowledge-base//mcp-description.md', body('doubled')),
    ]);

    expect(order.slice(0, 2)).toEqual(['plain:enter', 'plain:exit']);
    expect(order).toHaveLength(6);
    expectNoInterleaving(order, ['plain', 'dotted', 'doubled']);
  });

  it('lets another file run while one path is held: a turn is per file', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = svc.withPathTurn(workspaceId, 'knowledge-base/one.md', () => held);

    // Would hang if one file's turn queued another's.
    await expect(
      svc.withPathTurn(workspaceId, 'knowledge-base/two.md', async () => 'ran'),
    ).resolves.toBe('ran');

    release();
    await holder;
  });

  it('is re-entrant: the write inside a held turn does not wait for itself', async () => {
    const rel = 'knowledge-base/mcp-description.md';
    await fs.writeFile(path.join(workspaceDir, rel), 'Before.', 'utf-8');

    await svc.withPathTurn(workspaceId, rel, async () => {
      // The same compare-and-write the route makes inside its own turn.
      await svc.writeFile(workspaceId, rel, 'After.', { expectedContent: 'Before.' });
    });

    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe('After.');
  });

  it('serializes two writes launched side by side INSIDE a held turn: one lands, the other is refused', async () => {
    // Both inherit the held turn, so neither waits for it — but they must
    // still take turns with each other, or both compare the same old
    // content and the second silently overwrites the first.
    const rel = 'knowledge-base/mcp-description.md';
    const results = await svc.withPathTurn(workspaceId, rel, () =>
      Promise.allSettled([
        svc.writeFile(workspaceId, rel, 'From A.', { expectedContent: '' }),
        svc.writeFile(workspaceId, rel, 'From B.', { expectedContent: '' }),
      ]),
    );
    const [a] = results;
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ status: 409 });
    // Which of the two goes first is not promised (each resolves its path
    // before it chains onto the held turn's tail); what is, is that the file
    // holds the winner's text whole and the loser was refused.
    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe(
      a.status === 'fulfilled' ? 'From A.' : 'From B.',
    );
  });

  it('updates the diff baseline inside the turn, in the order the mutations landed', async () => {
    const rel = 'knowledge-base/notes.md';
    await fs.writeFile(path.join(workspaceDir, rel), 'Old.', 'utf-8');
    const absolute = path.join(workspaceDir, rel);
    const onDisk = async () => fs.readFile(absolute, 'utf-8').catch(() => null);
    // Each baseline update records what the file held when it ran. The
    // property under test is that an update runs INSIDE its mutation's turn —
    // after that mutation's disk effect and before the next mutation's — so
    // the sequence of updates is the sequence of disk states.
    const calls: Array<{ call: string; disk: string | null }> = [];
    svc.setDiffService({
      markUserDeleted: async () => {
        calls.push({ call: 'deleted', disk: await onDisk() });
      },
      syncFromDisk: async () => {
        calls.push({ call: 'synced', disk: await onDisk() });
      },
    } as never);
    // A delete and a write launched together. Which takes the turn first is
    // not promised (each resolves the workspace before acquiring), so the
    // assertions hold for either order: every update saw its own mutation's
    // effect, and the last update matches what is left on disk.
    await Promise.all([svc.deleteFile(workspaceId, rel), svc.writeFile(workspaceId, rel, 'New.')]);
    expect(calls.map((c) => c.call).sort()).toEqual(['deleted', 'synced']);
    expect(calls.find((c) => c.call === 'deleted')?.disk).toBeNull();
    expect(calls.find((c) => c.call === 'synced')?.disk).toBe('New.');
    expect(await onDisk()).toBe(calls[1].disk);
  });

  it('a throwing turn does not wedge the ones queued behind it', async () => {
    const rel = 'knowledge-base/mcp-description.md';

    const failed = svc.withPathTurn(workspaceId, rel, async () => {
      throw new Error('boom');
    });
    const after = svc.withPathTurn(workspaceId, rel, async () => 'ran');

    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ran');
  });

  it('holds a delete and an upload of the same path until the turn ends', async () => {
    // The mutators cubic named: neither goes through writeFile, and either
    // landing inside a conditional write's compare-then-write would defeat it.
    const rel = 'knowledge-base/mcp-description.md';
    const absolute = path.join(workspaceDir, rel);
    await fs.writeFile(absolute, 'Held.', 'utf-8');
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The turn is taken only after `withPathTurn` has resolved the workspace
    // directory, and so are the contenders' — so calling first does not mean
    // acquiring first. What the service promises is that whoever holds the
    // turn holds it alone; the test must therefore wait until the holder
    // actually HOLDS it before launching the delete and the upload, or one of
    // them can win the acquisition and land first (a real 1-in-5 flake).
    let holding: () => void = () => {};
    const acquired = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = svc.withPathTurn(workspaceId, rel, () => {
      holding();
      return held;
    });
    await acquired;

    let deleted = false;
    let uploaded = false;
    const del = svc.deleteFile(workspaceId, rel).then(() => {
      deleted = true;
    });
    const up = svc.writeFileBinary(workspaceId, rel, new Uint8Array([1, 2, 3])).then(() => {
      uploaded = true;
    });
    // Real filesystem round trips, not setImmediate: an fs completion runs in
    // the poll phase, which a check-phase callback can jump ahead of, so
    // yielding by microtask would prove nothing about a free `fs.rm`.
    for (let i = 0; i < 5; i += 1) await fs.stat(workspaceDir);

    expect({ deleted, uploaded }).toEqual({ deleted: false, uploaded: false });
    expect(await fs.readFile(absolute, 'utf-8')).toBe('Held.');

    release();
    await Promise.all([holder, del, up]);
    expect({ deleted, uploaded }).toEqual({ deleted: true, uploaded: true });
  });
});

describe('WorkspaceService.assertContentMatches', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('passes silently when the file still holds the expected content', async () => {
    const rel = 'knowledge-base/mcp-description.md';
    await fs.writeFile(path.join(workspaceDir, rel), 'Before.', 'utf-8');

    await expect(svc.assertContentMatches(workspaceId, rel, 'Before.')).resolves.toBeUndefined();
  });

  it('refuses a stale precondition with the write path\'s own 409, and writes nothing', async () => {
    const rel = 'knowledge-base/mcp-description.md';
    await fs.writeFile(path.join(workspaceDir, rel), "Another admin's text.", 'utf-8');

    await expect(svc.assertContentMatches(workspaceId, rel, 'What I loaded.')).rejects.toMatchObject({
      status: 409,
    });
    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe("Another admin's text.");
  });

  it('reads an absent file as the empty string', async () => {
    await expect(
      svc.assertContentMatches(workspaceId, 'knowledge-base/mcp-description.md', ''),
    ).resolves.toBeUndefined();
  });
});

describe('WorkspaceService.createFolderZip', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;
  /** The folder a zip request names resolves inside the checkout. */
  let repoDir: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    repoDir = path.join(workspaceDir, 'knowledge-base');
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function unzipEntries(buffer: Buffer): Promise<{ name: string; data: Buffer }[]> {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip(buffer);
    return zip.getEntries().map((e) => ({
      name: e.entryName,
      data: e.getData(),
    }));
  }

  it('zips a folder prefixing entries with the folder name', async () => {
    const dir = path.join(repoDir, 'docs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.md'), 'alpha');
    await fs.writeFile(path.join(dir, 'b.md'), 'beta');

    const buf = await svc.createFolderZip(workspaceId, 'docs');
    const entries = await unzipEntries(buf);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['docs/a.md', 'docs/b.md']);
    const a = entries.find((e) => e.name === 'docs/a.md')!;
    expect(a.data.toString()).toBe('alpha');
  });

  it('preserves nested directory structure', async () => {
    const dir = path.join(repoDir, 'tree');
    await fs.mkdir(path.join(dir, 'nested', 'deep'), { recursive: true });
    await fs.writeFile(path.join(dir, 'top.md'), 'top');
    await fs.writeFile(path.join(dir, 'nested', 'mid.md'), 'mid');
    await fs.writeFile(path.join(dir, 'nested', 'deep', 'leaf.md'), 'leaf');

    const buf = await svc.createFolderZip(workspaceId, 'tree');
    const names = (await unzipEntries(buf)).map((e) => e.name).sort();
    expect(names).toEqual([
      'tree/nested/deep/leaf.md',
      'tree/nested/mid.md',
      'tree/top.md',
    ]);
  });

  it('omits .git directories and .gitkeep files', async () => {
    const dir = path.join(repoDir, 'mixed');
    await fs.mkdir(path.join(dir, '.git', 'objects'), { recursive: true });
    await fs.writeFile(path.join(dir, '.git', 'config'), 'should-not-ship');
    await fs.writeFile(path.join(dir, '.git', 'objects', 'pack'), 'binary');
    await fs.writeFile(path.join(dir, '.gitkeep'), '');
    await fs.writeFile(path.join(dir, 'real.md'), 'real');

    const buf = await svc.createFolderZip(workspaceId, 'mixed');
    const names = (await unzipEntries(buf)).map((e) => e.name).sort();
    expect(names).toEqual(['mixed/real.md']);
  });

  it('honors .bevelignore rules from inside the folder', async () => {
    const dir = path.join(repoDir, 'with-ignore');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.bevelignore'), 'secret.md\n');
    await fs.writeFile(path.join(dir, 'public.md'), 'pub');
    await fs.writeFile(path.join(dir, 'secret.md'), 'shh');

    const buf = await svc.createFolderZip(workspaceId, 'with-ignore');
    const names = (await unzipEntries(buf)).map((e) => e.name).sort();
    expect(names).toContain('with-ignore/public.md');
    expect(names).not.toContain('with-ignore/secret.md');
  });

  it('refuses to zip a file (not a directory)', async () => {
    await fs.writeFile(path.join(repoDir, 'lone.md'), 'one');
    await expect(svc.createFolderZip(workspaceId, 'lone.md')).rejects.toThrow('Not a directory');
  });

  it('refuses a traversing path, and reads an unprefixed one as the repository folder', async () => {
    await expect(svc.createFolderZip(workspaceId, '../escape')).rejects.toThrow(
      'is outside the knowledge base repository',
    );
    // The unprefixed spelling is the repository's own folder, so it zips.
    await fs.mkdir(path.join(repoDir, 'unprefixed'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'unprefixed', 'a.md'), 'a');
    const buf = await svc.createFolderZip(workspaceId, 'unprefixed');
    expect((await unzipEntries(buf)).map((e) => e.name)).toEqual(['unprefixed/a.md']);
  });

  it('throws FolderTooLargeError when contents exceed the size cap', async () => {
    // The real cap is 500 MB — too big to allocate in a unit test. Spy
    // on `fs.stat` to report a fake oversized file size; createFolderZip
    // checks `stat.size + totalBytes > cap` BEFORE reading the file, so
    // the guard fires without ever allocating the buffer.
    //
    // Spy on the top-level `fs` default import — same pattern that works
    // in diff.service.seed-atomicity.test.ts. A re-imported namespace via
    // `await import('node:fs/promises')` is sealed and `vi.spyOn` can't
    // redefine its properties.
    const dir = path.join(repoDir, 'too-big');
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'huge.bin');
    await fs.writeFile(filePath, 'x'); // 1 byte real; stat will lie below.

    const { FolderTooLargeError } = await import('../workspace.service.js');
    const realStat = fs.stat;
    const statSpy = vi.spyOn(fs, 'stat').mockImplementation(async (p, opts) => {
      const result = await realStat(p as string, opts);
      if (typeof p === 'string' && p === filePath) {
        // Pretend the file is 600 MB — well over the 500 MB cap.
        return { ...result, size: 600 * 1024 * 1024 } as typeof result;
      }
      return result;
    });
    try {
      await expect(svc.createFolderZip(workspaceId, 'too-big'))
        .rejects.toBeInstanceOf(FolderTooLargeError);
    } finally {
      statSpy.mockRestore();
    }
  });
});

describe('WorkspaceService — clone bootstrap & sibling reference', () => {
  let root: string;
  let workspacesRoot: string;
  let upstream: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    // Keep the bare upstream + seed clone OUTSIDE workspacesRoot so the
    // sibling scan only ever sees real workspace clones.
    workspacesRoot = path.join(root, 'workspaces');
    await fs.mkdir(workspacesRoot, { recursive: true });

    upstream = path.join(root, 'upstream.git');
    await runGit(root, ['init', '--bare', '-b', 'target-company-state', upstream]);

    const seed = path.join(root, '.seed');
    await fs.mkdir(seed);
    await runGit(seed, ['init', '-b', 'target-company-state']);
    await runGit(seed, ['remote', 'add', 'origin', upstream]);
    await fs.writeFile(path.join(seed, 'marker.txt'), 'on-target', 'utf-8');
    await runGit(seed, ['add', '.']);
    await runGit(seed, ['commit', '-m', 'init target']);
    await runGit(seed, ['checkout', '-b', 'alice/draft']);
    await fs.writeFile(path.join(seed, 'marker.txt'), 'on-draft', 'utf-8');
    await runGit(seed, ['commit', '-am', 'draft change']);
    await runGit(seed, ['push', 'origin', 'target-company-state', 'alice/draft']);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('clones a branch on first bootstrap and checks out the right ref', async () => {
    const svc = new WorkspaceService(workspacesRoot, upstream, testKbContext(), new NodeFs());
    const info = await svc.getOrCreateForBranch('target-company-state');

    const repo = path.join(info.absolutePath, 'knowledge-base');
    expect(await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('target-company-state');
    expect(await fs.readFile(path.join(repo, 'marker.txt'), 'utf-8')).toBe('on-target');
  });

  it('uses an existing sibling clone as a --reference and stays dissociated', async () => {
    const svc = new WorkspaceService(workspacesRoot, upstream, testKbContext(), new NodeFs());
    // First branch: plain clone — becomes the sibling for the next bootstrap.
    await svc.getOrCreateForBranch('target-company-state');
    // Second branch: should borrow the first clone's objects, then dissociate.
    const info = await svc.getOrCreateForBranch('alice/draft');
    const repo = path.join(info.absolutePath, 'knowledge-base');

    expect(await gitOut(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('alice/draft');
    expect(await fs.readFile(path.join(repo, 'marker.txt'), 'utf-8')).toBe('on-draft');
    // --dissociate must have dropped the alternates link — the clone is
    // fully independent of the sibling it borrowed objects from.
    await expect(
      fs.access(path.join(repo, '.git', 'objects', 'info', 'alternates')),
    ).rejects.toThrow();
    // Still a real clone of the real remote — every origin ref is present.
    const refs = await gitOut(repo, [
      'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin',
    ]);
    expect(refs).toContain('origin/target-company-state');
    expect(refs).toContain('origin/alice/draft');
  });

  // A clone whose config carries a second `remote.origin.fetch` refspec or a
  // second `branch.<name>.merge` value can no longer be refreshed — git dies
  // with "Cannot rebase onto multiple branches", which is what strands the
  // post-merge pull of a target branch. Every clone this service hands out must
  // therefore track exactly one upstream ref through exactly one refspec.
  it('stamps a single fetch refspec and upstream ref on a fresh clone', async () => {
    const svc = new WorkspaceService(workspacesRoot, upstream, testKbContext(), new NodeFs());
    const info = await svc.getOrCreateForBranch('target-company-state');
    const repo = path.join(info.absolutePath, 'knowledge-base');

    expect(await gitOut(repo, ['config', '--get-all', 'remote.origin.fetch']))
      .toBe('+refs/heads/*:refs/remotes/origin/*');
    expect(await gitOut(repo, ['config', '--get-all', 'branch.target-company-state.merge']))
      .toBe('refs/heads/target-company-state');
    expect(await gitOut(repo, ['config', '--get-all', 'branch.target-company-state.remote']))
      .toBe('origin');
  });

  // Migration for the clones already on disk: they were created before the
  // stamp above existed and may have drifted since, so opening the branch
  // repairs them rather than waiting for a failed pull.
  it('repairs a drifted config on a clone that already exists on disk', async () => {
    // A clone that survived a process restart, laid out like prod.
    const workspaceDir = path.join(workspacesRoot, workspaceIdForBranch('alice/draft'));
    const repo = path.join(workspaceDir, 'knowledge-base');
    await fs.mkdir(workspaceDir, { recursive: true });
    await runGit(workspacesRoot, ['clone', '-b', 'alice/draft', upstream, repo]);
    await runGit(repo, ['config', '--add', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    await runGit(repo, ['config', '--add', 'branch.alice/draft.merge', 'refs/heads/target-company-state']);

    const svc = new WorkspaceService(workspacesRoot, upstream, testKbContext(), new NodeFs());
    await svc.getOrCreateForBranch('alice/draft');

    expect(await gitOut(repo, ['config', '--get-all', 'remote.origin.fetch']))
      .toBe('+refs/heads/*:refs/remotes/origin/*');
    expect(await gitOut(repo, ['config', '--get-all', 'branch.alice/draft.merge']))
      .toBe('refs/heads/alice/draft');
    // The working tree is untouched — repairing config never re-checks-out.
    expect(await fs.readFile(path.join(repo, 'marker.txt'), 'utf-8')).toBe('on-draft');
  });

  it('notifies the cloned-workspace listener with the workspace id after a clone', async () => {
    const svc = new WorkspaceService(workspacesRoot, upstream, testKbContext(), new NodeFs());
    const cloned: string[] = [];
    svc.setWorkspaceClonedListener((id) => cloned.push(id));

    await svc.getOrCreateForBranch('alice/draft');
    expect(cloned).toEqual([workspaceIdForBranch('alice/draft')]);
  });
});

/**
 * Reads and writes never follow a symbolic link — as the file itself, or as
 * a directory on the way to it. A link only reaches a repository by direct
 * git push, and following one would hand out (or overwrite) whatever the
 * server process can reach. The workspace root behind a link of the
 * operator's is the one link that is fine.
 */
describe('WorkspaceService — symbolic links', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let workspaceId: string;
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'main');
    workspaceDir = seeded.workspaceDir;
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses to read or write a file that is a link, and leaves the target untouched', async () => {
    const secret = path.join(root, 'secret.txt');
    await fs.writeFile(secret, 'DATABASE_URL=postgres://…', 'utf-8');
    const rel = 'knowledge-base/mcp-description.md';
    await fs.symlink(secret, path.join(workspaceDir, rel));

    await expect(svc.readFile(workspaceId, rel)).rejects.toThrow('Path traversal detected');
    await expect(svc.readFileBinary(workspaceId, rel)).rejects.toThrow('Path traversal detected');
    await expect(svc.writeFile(workspaceId, rel, 'Public text.')).rejects.toThrow('Path traversal detected');
    await expect(svc.writeFileBinary(workspaceId, rel, Buffer.from('x'))).rejects.toThrow('Path traversal detected');
    expect(await fs.readFile(secret, 'utf-8')).toBe('DATABASE_URL=postgres://…');
  });

  it('refuses a file reached through a linked directory, existing or yet to be created', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.writeFile(path.join(elsewhere, 'note.md'), 'outside', 'utf-8');
    await fs.symlink(elsewhere, path.join(workspaceDir, 'knowledge-base', 'linked'), linkType);

    await expect(svc.readFile(workspaceId, 'knowledge-base/linked/note.md')).rejects.toThrow('Path traversal detected');
    await expect(svc.writeFile(workspaceId, 'knowledge-base/linked/new/deeper.md', 'x')).rejects.toThrow(
      'Path traversal detected',
    );
    expect(await fs.readdir(elsewhere)).toEqual(['note.md']);
  });

  it('refuses a path through a DANGLING link — its absence is not leave to climb past it', async () => {
    // A link to nothing resolves to nothing, like a missing folder would; a
    // guard that then climbed to the parent would pass, and the write would
    // land wherever the link is pointed at by the time it runs.
    // A junction needs an existing target, so on Windows the dangling link is
    // a file link — it may point at nothing, and lstat still reports a link.
    await fs.symlink(
      path.join(root, 'nowhere'),
      path.join(workspaceDir, 'knowledge-base', 'dangling'),
      process.platform === 'win32' ? 'file' : 'dir',
    );
    await expect(svc.writeFile(workspaceId, 'knowledge-base/dangling/note.md', 'x')).rejects.toThrow(
      'Path traversal detected',
    );
    await expect(fs.access(path.join(root, 'nowhere'))).rejects.toThrow();
  });

  it('refuses a directory, a move and an extraction that would go through a link', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere, { recursive: true });
    await fs.symlink(elsewhere, path.join(workspaceDir, 'knowledge-base', 'linked'), linkType);
    await svc.writeFile(workspaceId, 'knowledge-base/real.md', 'real');

    await expect(svc.createDirectory(workspaceId, 'knowledge-base/linked/new-folder')).rejects.toThrow(
      'Path traversal detected',
    );
    await expect(svc.moveEntry(workspaceId, 'knowledge-base/real.md', 'knowledge-base/linked/real.md')).rejects.toThrow(
      'Path traversal detected',
    );
    expect(await fs.readFile(path.join(workspaceDir, 'knowledge-base', 'real.md'), 'utf-8')).toBe('real');

    // An archive whose entry lands under the link: that entry is skipped and
    // reported; the rest extracts.
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    zip.addFile('linked/escaped.md', Buffer.from('out'));
    zip.addFile('kept.md', Buffer.from('in'));
    await fs.writeFile(path.join(workspaceDir, 'knowledge-base', 'a.zip'), zip.toBuffer());
    const res = await svc.unzipFile(workspaceId, 'knowledge-base/a.zip', 'knowledge-base');
    expect(res.extracted).toEqual(['knowledge-base/kept.md']);
    expect(res.skipped).toContainEqual({ path: 'linked/escaped.md', reason: 'Path traversal detected' });
    expect(await fs.readdir(elsewhere)).toEqual([]);
  });

  it('reads and writes as before when nothing on the path is a link, the workspace root behind one included', async () => {
    const rel = 'knowledge-base/Folder/new/page.md';
    await svc.writeFile(workspaceId, rel, 'Hello.');
    expect(await svc.readFile(workspaceId, rel)).toBe('Hello.');

    // A mounted-volume shape: the whole workspaces root reached through a link.
    const mount = path.join(root, 'mount');
    await fs.symlink(root, mount, linkType);
    const viaMount = new WorkspaceService(mount, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    expect(await viaMount.readFile(workspaceId, rel)).toBe('Hello.');
    await viaMount.writeFile(workspaceId, rel, 'Hello again.');
    expect(await fs.readFile(path.join(workspaceDir, rel), 'utf-8')).toBe('Hello again.');

    // One workspace directory mounted elsewhere: the directory itself is a
    // link of the operator's, and everything beneath it is its own.
    const elsewhere = path.join(root, 'elsewhere-ws');
    await fs.rename(workspaceDir, elsewhere);
    await fs.symlink(elsewhere, workspaceDir, linkType);
    expect(await svc.readFile(workspaceId, rel)).toBe('Hello again.');
    await svc.writeFile(workspaceId, rel, 'Third.');
    expect(await fs.readFile(path.join(elsewhere, rel), 'utf-8')).toBe('Third.');
  });
});

describe('WorkspaceService.sweepOrphanedWorkspaces', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    // The fake `.git` in seedBranchWorkspace makes normalizeCloneConfig's
    // git calls fail; that path only warns, which is noise here.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('removes the clone of a branch that is not in the known set', async () => {
    const { workspaceId, workspaceDir } = await seedBranchWorkspace(root, 'target-company-state');
    const svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    await svc.getOrCreateForBranch('target-company-state');

    // The branch vanishes from the known set; the sweep reclaims its clone.
    const { removed } = await svc.sweepOrphanedWorkspaces([]);
    expect(removed).toContain(workspaceId);
    await expect(fs.stat(workspaceDir)).rejects.toThrow();
  });
});

describe('WorkspaceService.readAllKbFiles', () => {
  let root: string;
  let svc: WorkspaceService;
  let repoRoot: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    repoRoot = path.join(seeded.workspaceDir, 'knowledge-base');
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeRepoFile(rel: string, content: string): Promise<void> {
    const abs = path.join(repoRoot, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf-8');
  }

  it('returns every .md keyed by repo-root path, skipping non-.md and .git', async () => {
    await writeRepoFile('Product/NodeTypes/ServiceCommitment.md', '# SC');
    await writeRepoFile('Product/Knowledge/Foo.md', '# Foo');
    await writeRepoFile('README.md', 'readme');
    await writeRepoFile('Product/Knowledge/data.json', '{}');
    // a stray .md under the seeded .git dir must never be returned
    await fs.writeFile(path.join(repoRoot, '.git', 'note.md'), 'gitnote', 'utf-8');

    const files = await svc.readAllKbFiles(workspaceId);

    expect(Object.keys(files).sort()).toEqual([
      'Product/Knowledge/Foo.md',
      'Product/NodeTypes/ServiceCommitment.md',
      'README.md',
    ]);
    expect(files['Product/Knowledge/Foo.md']).toBe('# Foo');
    expect(Object.keys(files).some((k) => k.startsWith('.git/'))).toBe(false);
  });

  it('honors .bevelignore', async () => {
    await writeRepoFile('Product/Knowledge/Public.md', 'pub');
    await writeRepoFile('Product/Knowledge/Secret.md', 'shh');
    await writeRepoFile('Product/Knowledge/.bevelignore', 'Secret.md\n');

    const files = await svc.readAllKbFiles(workspaceId);

    expect(files['Product/Knowledge/Public.md']).toBe('pub');
    expect(files['Product/Knowledge/Secret.md']).toBeUndefined();
  });
});

describe('WorkspaceService.unzipFile — ontology-session write guard', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  /** Archive and destination alike resolve inside the checkout. */
  let repoDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    repoDir = path.join(workspaceDir, 'knowledge-base');
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://github.com/Bevel-Software/knowledge-base.git', testKbContext(), new NodeFs());
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function writeZip(rel: string, files: Record<string, string>): Promise<void> {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
    await fs.writeFile(path.join(repoDir, rel), zip.toBuffer());
  }

  it('skips entries the write guard rejects and never writes them to disk', async () => {
    await writeZip('a.zip', { 'keep.md': 'ok', 'blocked.md': 'no' });
    const res = await svc.unzipFile(workspaceId, 'a.zip', 'out', async (wsPath) => {
      if (wsPath.endsWith('blocked.md')) throw new Error('Blocked by the ontology-session boundary');
    });
    // An unprefixed destination is the repository's own `out/`, and the
    // extracted paths are reported workspace-relative, so prefixed.
    expect(res.extracted).toEqual(['knowledge-base/out/keep.md']);
    expect(res.skipped).toContainEqual({ path: 'blocked.md', reason: 'Blocked by the ontology-session boundary' });
    expect((await fs.readFile(path.join(repoDir, 'out', 'keep.md'))).toString()).toBe('ok');
    await expect(fs.readFile(path.join(repoDir, 'out', 'blocked.md'))).rejects.toThrow();
    await expect(fs.stat(path.join(workspaceDir, 'out'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('skips a guard-rejected directory entry without creating it on disk', async () => {
    const { default: AdmZip } = await import('adm-zip');
    const zip = new AdmZip();
    zip.addFile('blocked-dir/', Buffer.alloc(0)); // bare directory entry
    zip.addFile('keep.md', Buffer.from('ok'));
    await fs.writeFile(path.join(repoDir, 'c.zip'), zip.toBuffer());

    const res = await svc.unzipFile(workspaceId, 'c.zip', 'out', async (wsPath) => {
      if (wsPath.includes('blocked-dir')) throw new Error('Blocked by the ontology-session boundary');
    });

    expect(res.extracted).toEqual(['knowledge-base/out/keep.md']);
    expect(res.skipped).toContainEqual({ path: 'blocked-dir/', reason: 'Blocked by the ontology-session boundary' });
    await expect(fs.stat(path.join(repoDir, 'out', 'blocked-dir'))).rejects.toThrow();
  });

  it('does not create the destination directory when every entry is blocked', async () => {
    await writeZip('d.zip', { 'a.md': '1', 'b.md': '2' });
    const res = await svc.unzipFile(workspaceId, 'd.zip', 'out', async () => {
      throw new Error('Blocked by the ontology-session boundary');
    });
    expect(res.extracted).toEqual([]);
    expect(res.skipped).toHaveLength(2);
    await expect(fs.stat(path.join(repoDir, 'out'))).rejects.toThrow();
  });

  // The zip reader cannot tell a missing file from a corrupt one: it answers
  // "ADM-ZIP: Invalid filename" for both, and unzip used to dress that up as a
  // 422 unreadable archive — blaming bytes that were never there. Absence is
  // asked first, so the tool can give it the one 404 every file tool gives.
  it('a .zip that is not there is a 404 not_found, not an unreadable archive', async () => {
    await expect(svc.unzipFile(workspaceId, 'nope.zip')).rejects.toMatchObject({
      name: 'PathNotFoundError',
      status: 404,
      payload: { kind: 'not_found', path: 'knowledge-base/nope.zip' },
    });
  });

  // The error carries the WHOLE answer — sanitized path, kind AND the next
  // step — because not every surface re-renders it. `POST /workspace/:id/unzip`
  // hands this straight to `domainErrorBody`, so whatever is missing here is
  // missing from the HTTP 404 that the tools' 404 is supposed to match.
  it('the missing-archive 404 carries the next step and a one-line path, on any surface', async () => {
    await expect(svc.unzipFile(workspaceId, 'nope.zip')).rejects.toMatchObject({
      message:
        'There is no file or directory at "knowledge-base/nope.zip" in this workspace. Check the path with list_files.',
    });
    // A name carrying a line break cannot forge a second line of the answer,
    // in the message or in the `path` a JSON consumer reads.
    const forged = 'a\nb\u2028c.zip';
    await expect(svc.unzipFile(workspaceId, forged)).rejects.toMatchObject({
      status: 404,
      payload: { kind: 'not_found', path: 'knowledge-base/a\\nb\\u2028c.zip' },
    });
  });

  // The archive is read ONCE and the reader is handed those bytes. With a
  // `stat` probe followed by `new AdmZip(path)` there were two moments: an
  // archive that vanished in between passed the probe and then failed the
  // open, and the caller got back the 422 the probe existed to prevent.
  it('an archive that vanishes as it is opened still answers 404, never the 422', async () => {
    await writeZip('racy.zip', { 'x.md': '1' });
    const gone = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    const readSpy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(gone);
    try {
      await expect(svc.unzipFile(workspaceId, 'racy.zip')).rejects.toMatchObject({
        name: 'PathNotFoundError',
        status: 404,
        payload: { kind: 'not_found', path: 'knowledge-base/racy.zip' },
      });
    } finally {
      readSpy.mockRestore();
    }
  });

  // The other half of that single read: bytes that ARE there but are not a zip
  // are still the archive's problem, not the path's.
  it('a file that is not a zip is still the 422, read from its bytes', async () => {
    await fs.writeFile(path.join(repoDir, 'junk.zip'), 'not really a zip');
    await expect(svc.unzipFile(workspaceId, 'junk.zip')).rejects.toMatchObject({
      status: 422,
      payload: { kind: 'unreadable-archive' },
    });
  });

  it('extracts everything when no guard is supplied (human / non-agent path)', async () => {
    await writeZip('b.zip', { 'x.md': '1', 'y.md': '2' });
    const res = await svc.unzipFile(workspaceId, 'b.zip', 'out');
    expect(res.extracted.sort()).toEqual(['knowledge-base/out/x.md', 'knowledge-base/out/y.md']);
    expect(res.skipped).toEqual([]);
  });
});

/**
 * The service resolves a workspace path in ONE place, and that place does two
 * things: it places the path inside the repository, and it checks the RESOLVED
 * location against `<workspaceDir>/<kbDirName>`. Nine inline
 * `path.resolve(workspaceDir, …)` calls used to do the first half only — which
 * is how an unprefixed path written by a staging test ended up beside the
 * checkout, never committed and never pushed.
 */
describe('WorkspaceService — every operation resolves inside the repository', () => {
  let root: string;
  let svc: WorkspaceService;
  let workspaceDir: string;
  let repoDir: string;
  let workspaceId: string;

  beforeEach(async () => {
    root = await mkTmpRoot();
    const seeded = await seedBranchWorkspace(root, 'target-company-state');
    workspaceDir = seeded.workspaceDir;
    repoDir = path.join(workspaceDir, 'knowledge-base');
    workspaceId = seeded.workspaceId;
    svc = new WorkspaceService(root, 'https://example.invalid/kb.git', testKbContext(), new NodeFs());
    await svc.getWorkspacePath(workspaceId);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Whatever sits in the workspace directory other than the checkout. */
  const besideCheckout = async () => (await fs.readdir(workspaceDir)).filter((n) => n !== 'knowledge-base').sort();

  it('puts every write an unprefixed path names inside the checkout', async () => {
    await svc.writeFile(workspaceId, 'KnowledgeBase/Report.md', 'body');
    await svc.writeFileBinary(workspaceId, 'Uploads/TestDocx.docx', Buffer.from('bytes'));
    await svc.createDirectory(workspaceId, 'Plugins/GTM');

    expect(await fs.readFile(path.join(repoDir, 'KnowledgeBase', 'Report.md'), 'utf-8')).toBe('body');
    expect(await fs.readFile(path.join(repoDir, 'Uploads', 'TestDocx.docx'), 'utf-8')).toBe('bytes');
    expect((await fs.stat(path.join(repoDir, 'Plugins', 'GTM'))).isDirectory()).toBe(true);
    expect(await besideCheckout()).toEqual([]);
  });

  it('reads, moves and deletes the repository file an unprefixed path names', async () => {
    await svc.writeFile(workspaceId, 'a.md', 'one');

    expect(await svc.readFile(workspaceId, 'a.md')).toBe('one');
    expect((await svc.readFileBinary(workspaceId, 'a.md')).toString()).toBe('one');
    // Both spellings are the same file.
    expect(await svc.readFile(workspaceId, 'knowledge-base/a.md')).toBe('one');

    await svc.moveEntry(workspaceId, 'a.md', 'Moved/a.md');
    expect(await fs.readFile(path.join(repoDir, 'Moved', 'a.md'), 'utf-8')).toBe('one');

    await svc.deleteFile(workspaceId, 'Moved/a.md');
    await expect(fs.stat(path.join(repoDir, 'Moved', 'a.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await besideCheckout()).toEqual([]);
  });

  it('takes its path and folder turns on the repository path, so two spellings are one queue', async () => {
    // The second spelling is issued only once the first HOLDS its turn. What
    // is asserted is the queue — the second waits for the first to finish —
    // not the order two calls enter it: before the queue each spelling is
    // judged against the git folder on disk, and those probes take as long as
    // the spelling makes them, so two calls issued together can chain in
    // either order (the FIFO case is pinned above, on warmed equal spellings).
    const order: string[] = [];
    let holding!: () => void;
    const held = new Promise<void>((r) => { holding = r; });
    const slow = svc.withPathTurn(workspaceId, 'contended.md', async () => {
      holding();
      await new Promise((r) => setTimeout(r, 20));
      order.push('first');
    });
    await held;
    const fast = svc.withPathTurn(workspaceId, 'knowledge-base/contended.md', async () => {
      order.push('second');
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(['first', 'second']);

    await svc.withFolderTurn(workspaceId, 'Folder', async () => undefined);
  });

  it('refuses a path that resolves outside the checkout after normalisation', async () => {
    // The spelling is contained and normalises into the repository, so the
    // LEXICAL root check in `resolveInsideRepo` passes it — `knowledge-base/
    // Escape/x.md` stays under the repository however `Escape` resolves. What
    // refuses it is `assertNotThroughLink`, which follows the link. Both run
    // after normalisation, and this pins the one that can actually fire on a
    // spelling the normaliser accepts.
    const outside = path.join(workspaceDir, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(repoDir, 'Escape'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(svc.writeFile(workspaceId, 'Escape/x.md', 'x')).rejects.toThrow('Path traversal detected');
    await expect(svc.readFile(workspaceId, 'Escape/x.md')).rejects.toThrow('Path traversal detected');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('cannot be asked for the workspace directory itself, or anything beside the checkout', async () => {
    // The workspace directory has no spelling left: every path names something
    // under the checkout, and the ones that used to reach up are refused.
    for (const dir of ['', '.', '..', '/', 'knowledge-base/..']) {
      await expect(svc.readFile(workspaceId, dir)).rejects.toThrow(
        'is outside the knowledge base repository',
      );
    }
    await fs.writeFile(path.join(workspaceDir, 'stray.md'), 'already there', 'utf-8');
    // `stray.md` names the REPOSITORY's `stray.md` now — the one beside the
    // checkout has no path that reaches it, which is the point.
    await expect(svc.readFile(workspaceId, 'stray.md')).rejects.toMatchObject({ code: 'ENOENT' });
    await svc.writeFile(workspaceId, 'stray.md', 'in the repository');
    expect(await fs.readFile(path.join(workspaceDir, 'stray.md'), 'utf-8')).toBe('already there');
    expect(await fs.readFile(path.join(repoDir, 'stray.md'), 'utf-8')).toBe('in the repository');
  });

  it('reserves the checkout folder name at the repository root on create, move and write', async () => {
    const reserved = /"knowledge-base" is reserved/;
    await expect(svc.createDirectory(workspaceId, 'knowledge-base/knowledge-base')).rejects.toThrow(reserved);
    await expect(svc.writeFile(workspaceId, 'knowledge-base/knowledge-base/x.md', 'x')).rejects.toThrow(reserved);
    await expect(
      svc.writeFileBinary(workspaceId, 'knowledge-base/knowledge-base/x.bin', Buffer.from('x')),
    ).rejects.toThrow(reserved);

    await svc.writeFile(workspaceId, 'movable.md', 'm');
    await expect(svc.moveEntry(workspaceId, 'movable.md', 'knowledge-base/knowledge-base/movable.md')).rejects.toThrow(
      reserved,
    );
    await expect(fs.stat(path.join(repoDir, 'knowledge-base'))).rejects.toMatchObject({ code: 'ENOENT' });

    // The refusal says why, so nobody has to guess.
    await expect(svc.createDirectory(workspaceId, 'knowledge-base/knowledge-base')).rejects.toThrow(
      /it is the checkout folder's name/,
    );
    // A case variant is the same folder wherever the repository is cloned onto
    // a case-insensitive filesystem, so it is reserved in every spelling.
    await expect(svc.createDirectory(workspaceId, 'Knowledge-Base')).rejects.toThrow(/"Knowledge-Base" is reserved/);
    await expect(svc.writeFile(workspaceId, 'KNOWLEDGE-BASE/x.md', 'x')).rejects.toThrow(
      /refused in every spelling/,
    );

    // A namesake deeper in the tree is ordinary content.
    await svc.createDirectory(workspaceId, 'KnowledgeBase/knowledge-base');
    expect((await fs.stat(path.join(repoDir, 'KnowledgeBase', 'knowledge-base'))).isDirectory()).toBe(true);
  });
});
