import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';

// The real disk, from the fixture that stands in for the composition root:
// the memo's model load walks the working tree with it.
import { realDisk } from '../../../__tests__/real-disk.js';
import type { WorkspaceService } from '../../workspace/index.js';
import { NO_GIT_CREDENTIALS, type IGitRunner } from '../../../shared/git.contract.js';
import { AccessControlService } from '../access-control.service.js';
import {
  OwnEntriesMemo,
  OWN_ENTRIES_LIMITS,
  type IOwnEntriesMemo,
  type OwnEntriesLimits,
} from '../own-entries-memo.js';
import { TreeIndexer, type CommitPaths, type ITreeIndexer } from '../tree-index.js';

/**
 * What the access caches HOLD, measured on the heap. Each case drives the
 * service through its public gates, with an injected git runner (the at-ref
 * models) or an injected clock (the own-entries memo), and reads the heap
 * after a full collection: the property is what stays reachable, so that is
 * what is asserted.
 */

const KB = 'knowledge-base';
const ADMIN = 'razvan@bevel.software';

let collect: () => void;
beforeAll(() => {
  v8.setFlagsFromString('--expose-gc');
  collect = vm.runInNewContext('gc') as () => void;
});

/** Heap in use after a full collection. */
function heapAfterGc(): number {
  collect();
  collect();
  return v8.getHeapStatistics().used_heap_size;
}

// ---------------------------------------------------------------------------
// At-ref models
// ---------------------------------------------------------------------------

const ROLES = 'roles:\n  Admin:\n    - razvan@bevel.software\n';
const ROOT_ACCESS = '---\nwrite:\n  - Admin\n---\n';
const DENIES_ADMIN = '---\nwrite:\n  - deny Admin\n---\n# mine\n';
const DENIES_ADMIN_PAGE = 'Team/Added-Page-That-Denies.md';
const REMOVED_PAGE = 'Team/Removed-Page-That-Denies.md';

/**
 * A repository that exists only as answers to the git calls a model build
 * makes: `rev-parse` (a commit is its own sha), `ls-tree -r -z` (the commit's
 * paths, printed afresh on every call, as text or bytes as asked) and
 * `cat-file --batch` (the blobs below, whatever the commit; anything else
 * is missing).
 */
function fakeRepository(commits: Map<string, () => string[]>): IGitRunner {
  const blobs = new Map([
    ['roles.yaml', ROLES],
    ['access.md', ROOT_ACCESS],
    ['KnowledgeBase/Engineering/access.md', ROOT_ACCESS],
    ['Plugins/Demo-Plugin/plugin.json', '{ "name": "Demo-Plugin" }\n'],
    [DENIES_ADMIN_PAGE, DENIES_ADMIN],
    [REMOVED_PAGE, DENIES_ADMIN],
  ]);
  const run = async (_cwd: string, args: string[], opts: { input?: string; encoding?: 'utf8' | 'buffer' } = {}) => {
    const answer = (bytes: Buffer) => ({
      stdout: opts.encoding === 'buffer' ? bytes : bytes.toString('utf8'),
      stderr: '',
    });
    if (args[0] === 'rev-parse') {
      const sha = args[args.length - 1]!.replace('^{commit}', '');
      if (!commits.has(sha)) throw Object.assign(new Error('unknown revision'), { stderr: 'unknown revision' });
      return answer(Buffer.from(`${sha}\n`));
    }
    if (args[0] === 'ls-tree') {
      const paths = commits.get(args[args.length - 1]!)!();
      return answer(Buffer.from(`${paths.join('\u0000')}\u0000`, 'utf8'));
    }
    if (args[0] === 'cat-file') {
      const out: Buffer[] = [];
      for (const spec of (opts.input ?? '').split('\n').filter(Boolean)) {
        const text = blobs.get(spec.slice(spec.indexOf(':') + 1));
        if (text === undefined) {
          out.push(Buffer.from(`${spec} missing\n`));
          continue;
        }
        const body = Buffer.from(text);
        out.push(Buffer.from(`${'0'.repeat(40)} blob ${body.length}\n`), body, Buffer.from('\n'));
      }
      return answer(Buffer.concat(out));
    }
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { defaultTimeoutMs: 10_000, credentials: NO_GIT_CREDENTIALS, run: run as IGitRunner['run'] };
}

function sha(i: number): string {
  return i.toString(16).padStart(40, 'a');
}

/** A path as long as a knowledge base's usually are. */
function pagePath(folder: string, i: number): string {
  return `KnowledgeBase/Engineering/Knowledge/${folder}/Tickets/A-Ticket-About-Something-${i}.md`;
}

describe('AccessControlService — what a cached at-ref model holds', () => {
  const workspaceId = 'ws-cache-memory';
  /** At least 20,000 paths per commit: the size the pull request measures. */
  const TREE = 20_000;
  const COMMITS = 30;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-cache-memory-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function service(commits: Map<string, () => string[]>, limits: { treeIndexBudget?: number } = {}) {
    const stub = {
      getWorkspacePath: async () => path.join(root, workspaceId),
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    return new AccessControlService(stub, KB, realDisk(), [], fakeRepository(commits), undefined, limits);
  }

  /** Bytes git prints for one commit's listing. */
  function listingBytes(paths: string[]): number {
    return Buffer.byteLength(`${paths.join('\u0000')}\u0000`);
  }

  /**
   * Heap held per cached commit: the first model is built before the
   * baseline (whatever every model shares, the service itself included),
   * then COMMITS more, each a gate call that misses the cache.
   */
  async function heapPerCommit(svc: AccessControlService, shas: string[]): Promise<number> {
    expect(await svc.canWriteAtRef(workspaceId, shas[0]!, ADMIN, 'Team/New.md')).toBe(true);
    const before = heapAfterGc();
    for (const s of shas.slice(1)) {
      expect(await svc.canWriteAtRef(workspaceId, s, ADMIN, 'Team/New.md')).toBe(true);
    }
    const after = heapAfterGc();
    // Every model is still cached and still answers.
    expect(await svc.canWriteAtRef(workspaceId, shas[1]!, ADMIN, 'Team/New.md')).toBe(true);
    return (after - before) / (shas.length - 1);
  }

  it('holds a small fraction of the listing per commit when commits share most of their paths', async () => {
    // The usual history: every commit carries the same tree but for one page.
    const shared = Array.from({ length: TREE - 3 }, (_, i) => pagePath('Shared', i));
    const commits = new Map<string, () => string[]>();
    const shas: string[] = [];
    for (let c = 0; c <= COMMITS; c++) {
      shas.push(sha(c));
      commits.set(sha(c), () => ['roles.yaml', 'access.md', ...shared, pagePath('Changed', c)]);
    }
    const listing = listingBytes(commits.get(shas[0]!)!());
    const perCommit = await heapPerCommit(service(commits), shas);
    console.info(`[cache-memory] shared tree of ${TREE} paths: listing ${listing} bytes, heap per cached commit ${Math.round(perCommit)} bytes`);
    expect(perCommit).toBeLessThan(listing / 20);
  }, 120_000);

  it('holds a small fraction of the listing per commit when two workspaces on diverging branches build in turn', async () => {
    // Two workspaces, each on its own line of history: the lines share most
    // of the tree but differ by more than a commit's delta may be, and their
    // builds alternate, as the service caches every workspace's commits in
    // one place. Each commit must still find its own line's base.
    const OWN = 1_500;
    const shared = Array.from({ length: TREE - 3 - OWN }, (_, i) => pagePath('Shared', i));
    const ownA = Array.from({ length: OWN }, (_, i) => pagePath('Line-A', i));
    const ownB = Array.from({ length: OWN }, (_, i) => pagePath('Line-B', i));
    const commits = new Map<string, () => string[]>();
    const builds: Array<[workspace: string, commit: string]> = [];
    for (let c = 0; c <= COMMITS; c++) {
      const a = sha(2 * c);
      const b = sha(2 * c + 1);
      commits.set(a, () => ['roles.yaml', 'access.md', ...shared, ...ownA, pagePath('Changed', c)]);
      commits.set(b, () => ['roles.yaml', 'access.md', ...shared, ...ownB, pagePath('Changed', c)]);
      builds.push(['ws-line-a', a], ['ws-line-b', b]);
    }
    const svc = service(commits);
    const listing = listingBytes(commits.get(sha(0))!());
    // One commit of each line before the baseline: the two bases.
    for (const [ws, commit] of builds.slice(0, 2)) {
      expect(await svc.canWriteAtRef(ws, commit, ADMIN, 'Team/New.md')).toBe(true);
    }
    const before = heapAfterGc();
    for (const [ws, commit] of builds.slice(2)) {
      expect(await svc.canWriteAtRef(ws, commit, ADMIN, 'Team/New.md')).toBe(true);
    }
    const perCommit = (heapAfterGc() - before) / (builds.length - 2);
    // A path on the other line is absent here, and is not read as a lost blob.
    expect(await svc.canWriteAtRef('ws-line-a', sha(2), ADMIN, pagePath('Line-B', 3))).toBe(true);
    console.info(`[cache-memory] two diverging lines of ${TREE} paths, built in turn: listing ${listing} bytes, heap per cached commit ${Math.round(perCommit)} bytes`);
    expect(perCommit).toBeLessThan(listing / 20);
  }, 120_000);

  it("answers from each commit's own paths when commits share a base: an added page's denial holds, a removed page is absent", async () => {
    // A page the tree names is read for what it declares; one it does not
    // name is absent and not read. Built one after the other, the second
    // commit's index shares the first one's base: what it added and what it
    // took away must still be its own.
    const shared = Array.from({ length: 200 }, (_, i) => pagePath('Shared', i));
    const first = sha(1);
    const second = sha(2);
    const commits = new Map<string, () => string[]>([
      [first, () => ['roles.yaml', 'access.md', ...shared, REMOVED_PAGE]],
      [second, () => ['roles.yaml', 'access.md', ...shared, DENIES_ADMIN_PAGE]],
    ]);
    const svc = service(commits);
    for (const [commit, added, removed] of [
      [first, false, true],
      [second, true, false],
    ] as const) {
      expect(await svc.canWriteAtRef(workspaceId, commit, ADMIN, DENIES_ADMIN_PAGE)).toBe(!added);
      expect(await svc.canWriteAtRef(workspaceId, commit, ADMIN, REMOVED_PAGE)).toBe(!removed);
      expect(await svc.canWriteAtRef(workspaceId, commit, ADMIN, pagePath('Shared', 7))).toBe(true);
    }
    // And again in the other order, once both are cached.
    expect(await svc.canWriteAtRef(workspaceId, second, ADMIN, REMOVED_PAGE)).toBe(true);
    expect(await svc.canWriteAtRef(workspaceId, first, ADMIN, DENIES_ADMIN_PAGE)).toBe(true);
    expect(await svc.canWriteAtRef(workspaceId, first, ADMIN, REMOVED_PAGE)).toBe(false);
    expect(await svc.canWriteAtRef(workspaceId, second, ADMIN, DENIES_ADMIN_PAGE)).toBe(false);
  });

  it('releases a tree let go under the budget: what the model keeps holds no listing', async () => {
    // Every commit's tree is new, so no base is shared, and a budget of zero
    // makes every model let its tree go: what is left is what the model keeps.
    const commits = new Map<string, () => string[]>();
    const shas: string[] = [];
    for (let c = 0; c <= COMMITS; c++) {
      shas.push(sha(c));
      const own = Array.from({ length: TREE - 4 }, (_, i) => pagePath(`Tree-${c}`, i));
      // Long enough that a piece cut from the listing would be a view onto it.
      commits.set(sha(c), () => [
        'roles.yaml',
        'access.md',
        'KnowledgeBase/Engineering/access.md',
        'Plugins/Demo-Plugin/plugin.json',
        ...own,
      ]);
    }
    const listing = listingBytes(commits.get(shas[0]!)!());
    const perCommit = await heapPerCommit(service(commits, { treeIndexBudget: 0 }), shas);
    console.info(`[cache-memory] distinct trees of ${TREE} paths, trees let go: listing ${listing} bytes, heap per cached commit ${Math.round(perCommit)} bytes`);
    expect(perCommit).toBeLessThan(listing / 20);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Own-entries memo
// ---------------------------------------------------------------------------

const TTL_MS = OWN_ENTRIES_LIMITS.ttlMs;
const ROLES_YAML = 'roles:\n  Admin:\n    - razvan@bevel.software\n  Product Manager:\n    - felix@example.com\n';

describe('AccessControlService — what the own-entries memo holds', () => {
  let root: string;
  let workspaceDir: string;
  let repo: string;
  let clock: number;
  const ali = 'ali@bevel.software';

  async function writeFile(rel: string, contents: string): Promise<void> {
    const abs = path.join(repo, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-memo-memory-'));
    workspaceDir = path.join(root, 'ws');
    repo = path.join(workspaceDir, KB);
    clock = 1_000_000;
    await writeFile('roles.yaml', ROLES_YAML);
    await writeFile('access.md', '---\nwrite:\n  - Admin\n---\n');
    await writeFile('Knowledge/Open/access.md', '---\nread:\n  - everyone\n---\n');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * Every workspace id is a clone of the same tree here. The memo is injected
   * as the composition root injects it, on the deployment's limits unless a
   * case lowers one, and on the same moved clock as the service.
   */
  function service(limits: Partial<OwnEntriesLimits> = {}) {
    const stub = { getWorkspacePath: async () => workspaceDir } as unknown as WorkspaceService;
    const now = () => clock;
    const memo = new OwnEntriesMemo(now, { ...OWN_ENTRIES_LIMITS, ...limits });
    return new AccessControlService(stub, KB, realDisk(), [], undefined, undefined, { now }, undefined, memo);
  }

  const DENIED = '---\nread:\n  - deny everyone\n---\n# denied\n';
  const PLAIN = '# plain\n';

  async function readable(svc: AccessControlService, ws: string, p: string): Promise<boolean | undefined> {
    return (await svc.canReadBatch(ws, ali, [p])).get(p);
  }

  it("drops the memos of workspaces nobody asks again once they are past their age, and keeps the heap they held", async () => {
    const FILES = 1_500;
    const WORKSPACES = 40;
    for (let i = 0; i < FILES; i++) {
      await writeFile(`Knowledge/Open/Page-${i}.md`, i % 3 === 0 ? `---\nread:\n  - deny everyone\n---\n# ${i}\n` : `# ${i}\n`);
    }
    // The file tree hands the batch paths cut from absolute ones.
    const absolute = Array.from({ length: FILES }, (_, i) => path.join(repo, `Knowledge/Open/Page-${i}.md`));
    const relative = absolute.map((a) => a.slice(repo.length + 1));
    const svc = service();
    // A first workspace before the baseline: whatever every batch shares.
    await svc.canReadBatch('ws-warm', ali, relative);
    const before = heapAfterGc();
    for (let w = 0; w < WORKSPACES; w++) {
      const m = await svc.canReadBatch(`ws-${w}`, ali, relative);
      expect(m.get(relative[1]!)).toBe(true);
      expect(m.get(relative[0]!)).toBe(false);
    }
    const held = heapAfterGc() - before;
    console.info(`[cache-memory] ${FILES} paths: heap per workspace memo ${Math.round(held / WORKSPACES)} bytes`);
    // Past their age, and NONE of them asked again: one batch on another
    // workspace is all that runs.
    clock += TTL_MS + 1;
    await svc.canReadBatch('ws-other', ali, [relative[1]!]);
    const left = heapAfterGc() - before;
    expect(left).toBeLessThan(held / 10);
  }, 120_000);

  it('holds no entry for a path outside the access-frontmatter extension set, and answers it as before', async () => {
    const NOTE = 'Knowledge/Open/notes.txt';
    const PAGE = 'Knowledge/Open/Page.md';
    await writeFile(NOTE, DENIED);
    await writeFile(PAGE, DENIED);
    const svc = service();
    // What the file says is read, for either kind of path.
    expect(await readable(svc, 'ws-1', NOTE)).toBe(false);
    expect(await readable(svc, 'ws-1', PAGE)).toBe(false);
    await writeFile(NOTE, PLAIN);
    await writeFile(PAGE, PLAIN);
    // The page is memoized until an invalidation; the note is never held.
    expect(await readable(svc, 'ws-1', PAGE)).toBe(false);
    expect(await readable(svc, 'ws-1', NOTE)).toBe(true);
  });

  it('drops the oldest workspace first past the workspace bound', async () => {
    const PAGE = 'Knowledge/Open/Page.md';
    await writeFile(PAGE, DENIED);
    const svc = service({ maxWorkspaces: 2 });
    expect(await readable(svc, 'ws-a', PAGE)).toBe(false);
    expect(await readable(svc, 'ws-b', PAGE)).toBe(false);
    expect(await readable(svc, 'ws-c', PAGE)).toBe(false);
    await writeFile(PAGE, PLAIN);
    // b and c are held, and still answer from the memo...
    expect(await readable(svc, 'ws-b', PAGE)).toBe(false);
    expect(await readable(svc, 'ws-c', PAGE)).toBe(false);
    // ...a was the oldest, so it was dropped and reads the disk again.
    expect(await readable(svc, 'ws-a', PAGE)).toBe(true);
  });

  it('drops the oldest workspace first past the entry bound, and a lone memo stops growing instead', async () => {
    const ONE = 'Knowledge/Open/One.md';
    const TWO = 'Knowledge/Open/Two.md';
    await writeFile(ONE, DENIED);
    await writeFile(TWO, DENIED);
    const svc = service({ maxEntries: 1 });
    // ws-a holds ONE; ws-b's entry needs the room, so ws-a goes.
    expect(await readable(svc, 'ws-a', ONE)).toBe(false);
    expect(await readable(svc, 'ws-b', ONE)).toBe(false);
    // ws-b is the only memo left: it keeps ONE and does not take TWO.
    expect(await readable(svc, 'ws-b', TWO)).toBe(false);
    await writeFile(ONE, PLAIN);
    await writeFile(TWO, PLAIN);
    expect(await readable(svc, 'ws-b', ONE)).toBe(false);
    expect(await readable(svc, 'ws-b', TWO)).toBe(true);
    expect(await readable(svc, 'ws-a', ONE)).toBe(true);
  });

  it('expires a memo by the injected clock, and keeps it until then', async () => {
    const PAGE = 'Knowledge/Open/Page.md';
    await writeFile(PAGE, DENIED);
    const svc = service();
    expect(await readable(svc, 'ws-1', PAGE)).toBe(false);
    await writeFile(PAGE, PLAIN);
    clock += TTL_MS;
    expect(await readable(svc, 'ws-1', PAGE)).toBe(false);
    clock += 1;
    expect(await readable(svc, 'ws-1', PAGE)).toBe(true);
  });

  it('keeps a read that straddles invalidate() out of the memo', async () => {
    const PAGE = 'Knowledge/Open/Page.md';
    await writeFile(PAGE, DENIED);
    const svc = service();
    // The invalidation lands after the batch opened the memo and while its
    // read is in flight: what that read finds must not be kept.
    const realOpen = fs.open.bind(fs);
    let fired = false;
    vi.spyOn(fs, 'open').mockImplementation((async (...args: Parameters<typeof fs.open>) => {
      if (!fired && String(args[0]).endsWith(PAGE)) {
        fired = true;
        svc.invalidate('ws-1');
      }
      return realOpen(...args);
    }) as typeof fs.open);
    expect(await readable(svc, 'ws-1', PAGE)).toBe(false);
    expect(fired).toBe(true);
    vi.restoreAllMocks();
    await writeFile(PAGE, PLAIN);
    expect(await readable(svc, 'ws-1', PAGE)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two caches are contracts: the service holds them through interfaces
// ---------------------------------------------------------------------------

describe('AccessControlService — its cache collaborators are substitutable behind their contracts', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-cache-contracts-'));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('builds, holds and releases at-ref trees through any ITreeIndexer', async () => {
    const commits = new Map<string, () => string[]>();
    for (let c = 0; c < 3; c++) commits.set(sha(c), () => ['roles.yaml', 'access.md', pagePath('Team', c)]);
    const built: CommitPaths[] = [];
    const sizes = new Map<CommitPaths, number>();
    const held = new Set<CommitPaths>();
    // A structural substitute: a plain Set is a commit's paths.
    const indexer: ITreeIndexer = {
      index: (paths) => {
        const tree = new Set(paths);
        built.push(tree);
        sizes.set(tree, tree.size);
        return tree;
      },
      hold: (tree) => void held.add(tree),
      release: (tree) => void held.delete(tree),
      get heldPaths() {
        return [...held].reduce((n, tree) => n + sizes.get(tree)!, 0);
      },
    };
    const stub = {
      getWorkspacePath: async () => path.join(root, 'ws'),
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    const svc = new AccessControlService(
      stub,
      KB,
      realDisk(),
      [],
      fakeRepository(commits),
      undefined,
      // Three paths per commit: room for one held tree.
      { treeIndexBudget: 3 },
      indexer,
    );
    expect(await svc.canWriteAtRef('ws', sha(0), ADMIN, 'Team/New.md')).toBe(true);
    expect(await svc.canWriteAtRef('ws', sha(1), ADMIN, 'Team/New.md')).toBe(true);
    expect(await svc.canWriteAtRef('ws', sha(2), ADMIN, 'Team/New.md')).toBe(true);
    expect(built).toHaveLength(3);
    // Past the budget of one held tree, the older trees were released.
    expect(held.size).toBe(1);
    expect(held.has(built[2]!)).toBe(true);
  });

  it('opens and drops the own-entries memo through any IOwnEntriesMemo, and answers as before', async () => {
    const repo = path.join(root, 'ws', KB);
    await fs.mkdir(path.join(repo, 'Knowledge/Open'), { recursive: true });
    await fs.writeFile(path.join(repo, 'roles.yaml'), ROLES_YAML);
    await fs.writeFile(path.join(repo, 'access.md'), '---\nwrite:\n  - Admin\n---\n');
    await fs.writeFile(path.join(repo, 'Knowledge/Open/access.md'), '---\nread:\n  - everyone\n---\n');
    await fs.writeFile(path.join(repo, 'Knowledge/Open/Denied.md'), '---\nread:\n  - deny everyone\n---\n');
    const calls: string[] = [];
    // A structural substitute that remembers nothing.
    const memo: IOwnEntriesMemo = {
      open: (ws) => {
        calls.push(`open ${ws}`);
        return { get: () => undefined, set: () => undefined };
      },
      drop: (ws) => void calls.push(`drop ${ws}`),
    };
    const stub = { getWorkspacePath: async () => path.join(root, 'ws') } as unknown as WorkspaceService;
    const svc = new AccessControlService(stub, KB, realDisk(), [], undefined, undefined, {}, undefined, memo);
    const paths = ['Knowledge/Open/Denied.md', 'Knowledge/Open/access.md'];
    const answers = await svc.canReadBatch('ws-1', 'ali@bevel.software', paths);
    expect(answers.get(paths[0]!)).toBe(false);
    expect(answers.get(paths[1]!)).toBe(true);
    svc.invalidate('ws-1');
    expect(calls).toEqual(['open ws-1', 'drop ws-1']);
  });

  it('refuses to hold or release a tree another TreeIndexer built', () => {
    const one = new TreeIndexer();
    const other = new TreeIndexer();
    const tree = one.index(['a.md', 'b.md']);
    expect(() => other.hold(tree)).toThrow(TypeError);
    expect(() => other.release(new Set(['a.md']))).toThrow(TypeError);
    one.hold(tree);
    expect(one.heldPaths).toBe(2);
    one.release(tree);
    expect(one.heldPaths).toBe(0);
  });
});
