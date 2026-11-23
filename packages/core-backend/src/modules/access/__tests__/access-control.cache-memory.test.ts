import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import v8 from 'node:v8';
import vm from 'node:vm';

import { NodeFs } from '../../kb-fs/node-fs.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import { NO_GIT_CREDENTIALS, type IGitRunner } from '../../../shared/git.contract.js';
import { AccessControlService } from '../access-control.service.js';

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

/**
 * A repository that exists only as answers to the git calls a model build
 * makes: `rev-parse` (a commit is its own sha), `ls-tree -r -z` (the commit's
 * paths, printed afresh on every call, as text or bytes as asked) and
 * `cat-file --batch` (roles.yaml and the root access.md; anything else is
 * missing).
 */
function fakeRepository(commits: Map<string, () => string[]>): IGitRunner {
  const blobs = new Map([
    ['roles.yaml', ROLES],
    ['access.md', ROOT_ACCESS],
    ['Plugins/Demo/plugin.json', '{ "name": "Demo" }\n'],
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
    return new AccessControlService(stub, KB, new NodeFs(), [], fakeRepository(commits), undefined, limits);
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

  it('releases a tree let go under the budget: what the model keeps holds no listing', async () => {
    // Every commit's tree is new, so no base is shared, and a budget of zero
    // makes every model let its tree go: what is left is what the model keeps.
    const commits = new Map<string, () => string[]>();
    const shas: string[] = [];
    for (let c = 0; c <= COMMITS; c++) {
      shas.push(sha(c));
      const own = Array.from({ length: TREE - 3 }, (_, i) => pagePath(`Tree-${c}`, i));
      commits.set(sha(c), () => ['roles.yaml', 'access.md', 'Plugins/Demo/plugin.json', ...own]);
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

const TTL_MS = 5 * 60_000;
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

  /** Every workspace id is a clone of the same tree here. */
  function service(limits: { ownEntriesMaxWorkspaces?: number; ownEntriesMaxEntries?: number } = {}) {
    const stub = { getWorkspacePath: async () => workspaceDir } as unknown as WorkspaceService;
    return new AccessControlService(stub, KB, new NodeFs(), [], undefined, undefined, { ...limits, now: () => clock });
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

  it('holds no entry for a path that cannot carry access entries, and answers it as before', async () => {
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
    const svc = service({ ownEntriesMaxWorkspaces: 2 });
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
    const svc = service({ ownEntriesMaxEntries: 1 });
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
