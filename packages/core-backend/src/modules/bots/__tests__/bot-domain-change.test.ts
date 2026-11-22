import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthUser } from '@bevel-software/platform-shared';
import { realDisk } from '../../../__tests__/real-disk.js';
import { WalkError, type ITreeWalker } from '../../../shared/fs.contract.js';
import { PushNeedsAgentResolutionError } from '../../../shared/domain-errors.js';
import { hasAccessFrontmatterExtension, isAccessFile } from '../../access-model/index.js';
import { GrantRewriteChangeRequests } from '../bot-domain-change.js';

/**
 * The change request a bots' domain change opens. Run against core's OWN
 * template `.bevelignore`, which hides every `access.md` and `roles.yaml` from
 * the explorer: the rewrite must still find every grant the access model
 * reads, or the old domain counts forever.
 */

const KB = 'knowledge-base';
const TEMPLATE_IGNORE = fileURLToPath(new URL('../../../../kb-template/.bevelignore', import.meta.url));
const ADMIN = { id: 'u-admin', email: 'admin@acme.com', name: 'Admin' } as unknown as AuthUser;

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** A workspace folder holding the knowledge base `files`; `name` keeps a second one (the default branch's working copy) apart. */
async function seed(files: Record<string, string>, name = 'branch'): Promise<string> {
  root ??= await mkdtemp(path.join(tmpdir(), 'bot-domain-change-'));
  const dir = path.join(root, name);
  const repo = path.join(dir, KB);
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, '.bevelignore'), await readFile(TEMPLATE_IGNORE, 'utf-8'));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), text);
  }
  return dir;
}

/**
 * `dir` is the new branch's checkout: the committed default branch. `live`,
 * when given, is the default branch's own working copy, which may hold what is
 * not committed; the rewrite must never read it.
 */
function rewriter(
  dir: string,
  walker: Pick<ITreeWalker, 'walkKb'> = realDisk(),
  opts: { live?: string; failDelete?: boolean; failCommit?: boolean | Error } = {},
) {
  const written: Record<string, string> = {};
  const calls: string[] = [];
  const descriptions: string[] = [];
  const folder = (ws: string) => (ws === 'ws-main' ? (opts.live ?? path.join(root!, 'unused-live')) : dir);
  const r = new GrantRewriteChangeRequests({
    versionControl: {
      createBranch: async (_ws: string, branch: string, from: string) => {
        calls.push(`branch ${branch} from ${from}`);
      },
      deleteBranch: async (ws: string, branch: string, by: AuthUser) => {
        calls.push(`delete ${branch} in ${ws} by ${by.email}`);
        if (opts.failDelete) throw new Error('push https://x-access-token:ghp_secret@github.com/o/r failed');
      },
      commitChanges: async (_ws: string, by: AuthUser, message: string) => {
        calls.push(`commit by ${by.email}: ${message}`);
        if (opts.failCommit) throw opts.failCommit instanceof Error ? opts.failCommit : new Error('commit failed');
      },
      openChangeRequest: async (_ws: string, by: AuthUser, req: { targetBranch: string; description: string }) => {
        calls.push(`request by ${by.email} into ${req.targetBranch}`);
        descriptions.push(req.description);
        return { number: 7 };
      },
    } as never,
    workspace: {
      getOrCreateForBranch: async () => ({ id: 'ws-branch' }),
      getWorkspacePath: async (ws) => folder(ws),
      readFile: (ws, wsPath) => readFile(path.join(folder(ws), wsPath), 'utf-8'),
      writeFile: async (ws, wsPath, content) => {
        expect(ws).toBe('ws-branch');
        written[wsPath.slice(KB.length + 1)] = content;
      },
    },
    walker,
    kb: { defaultBranch: 'main', kbDirName: KB, defaultWorkspaceId: () => 'ws-main' },
    isAccessFile,
    hasOwnAccessLines: hasAccessFrontmatterExtension,
  });
  return { r, written, calls, descriptions };
}

describe('the grant-rewriting change request of a bots\' domain change', () => {
  it('rewrites every grant naming a bot at the old domain, in files the template .bevelignore hides from the explorer', async () => {
    const dir = await seed({
      'access.md': '---\nread:\n  - ops@agent.hexis\n  - dana@acme.com\n---\n',
      'Finance/access.md': '---\nwrite:\n  - ops@agent.hexis\n---\n',
      'roles.yaml': 'roles:\n  reviewers:\n    - ops@agent.hexis\n    - dana@acme.com\n',
      'groups.yaml': 'groups:\n  release:\n    members:\n      - ops@agent.hexis\n',
      'Finance/Budget.md': '---\nread:\n  - ops@agent.hexis\n---\nWrite to ops@agent.hexis for the numbers.\n',
      'Tools/deploy.tool': '---\nname: deploy\nread:\n  - ops@agent.hexis\n---\n',
      'Notes/plain.md': 'ops@agent.hexis is mentioned in prose only.\n',
      'Notes/other.txt': 'ops@agent.hexis\n',
    });
    const { r, written, calls } = rewriter(dir);

    expect(await r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).toBe(7);

    expect(Object.keys(written).sort()).toEqual(
      ['Finance/Budget.md', 'Finance/access.md', 'Tools/deploy.tool', 'access.md', 'groups.yaml', 'roles.yaml'],
    );
    expect(written['access.md']).toBe('---\nread:\n  - ops@bots.acme.com\n  - dana@acme.com\n---\n');
    expect(written['Finance/access.md']).toBe('---\nwrite:\n  - ops@bots.acme.com\n---\n');
    expect(written['roles.yaml']).toBe('roles:\n  reviewers:\n    - ops@bots.acme.com\n    - dana@acme.com\n');
    expect(written['groups.yaml']).toContain('- ops@bots.acme.com');
    expect(written['Tools/deploy.tool']).toContain('- ops@bots.acme.com');
    // A file's own definition is its frontmatter; its body is left as written.
    expect(written['Finance/Budget.md']).toBe('---\nread:\n  - ops@bots.acme.com\n---\nWrite to ops@agent.hexis for the numbers.\n');
    expect(calls).toEqual([
      expect.stringMatching(/^branch bots\/domain-bots\.acme\.com-[a-z0-9]+ from main$/),
      'commit by admin@acme.com: Address bots at bots.acme.com instead of agent.hexis',
      'request by admin@acme.com into main',
    ]);
  });

  it('opens nothing when no grant names a bot at the old domain', async () => {
    const dir = await seed({ 'access.md': '---\nread:\n  - dana@acme.com\n  - other@agent.hexis\n---\n' });
    const { r, written, calls } = rewriter(dir);
    expect(await r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).toBeNull();
    expect(written).toEqual({});
    // The branch was cut to read the committed tree; with no request from it, it goes again.
    expect(calls).toEqual([
      expect.stringMatching(/^branch bots\/domain-bots\.acme\.com-[a-z0-9]+ from main$/),
      expect.stringMatching(/^delete bots\/domain-bots\.acme\.com-[a-z0-9]+ in ws-main by admin@acme\.com$/),
    ]);
  });

  it('refuses the whole rewrite, opening nothing, when a folder cannot be listed', async () => {
    const dir = await seed({ 'access.md': '---\nread:\n  - ops@agent.hexis\n---\n' });
    const real = realDisk();
    // A walker that finds a hole: reported and walked around unless the
    // caller asks for the walk to throw — which the rewrite must.
    const holed: Pick<ITreeWalker, 'walkKb'> = {
      async walkKb(r, listeners, options) {
        if (options?.unreadable === 'throw') throw new WalkError('Finance', new Error('EACCES'));
        const result = await real.walkKb(r, listeners, options);
        for (const l of listeners) await l.onHole?.('Finance', new Error('EACCES'));
        return { holes: [...result.holes, 'Finance'] };
      },
    };
    const { r, written, calls } = rewriter(dir, holed);
    await expect(r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).rejects.toBeInstanceOf(WalkError);
    expect(written).toEqual({});
    expect(calls).toEqual([
      expect.stringMatching(/^branch /),
      expect.stringMatching(/^delete bots\/domain-/),
    ]);
  });

  it('rewrites only what the default branch has committed, never a file its working copy holds uncommitted', async () => {
    // The committed default branch, as the new branch's checkout holds it.
    const committed = await seed({
      'access.md': '---\nread:\n  - ops@agent.hexis\n---\n',
      'Finance/Budget.md': '---\nread:\n  - ops@agent.hexis\n---\nCommitted body.\n',
    });
    // The default branch's working copy: the same, plus an unzip's extracted
    // files nobody committed, and an edit still landing.
    const live = await seed(
      {
        'access.md': '---\nread:\n  - ops@agent.hexis\n---\n',
        'Finance/Budget.md': '---\nread:\n  - ops@agent.hexis\n---\nAn edit not committed yet.\n',
        'QA/Unz2/access.md': '---\nread:\n  - ops@agent.hexis\n---\n',
        'QA/Unz2/lines.md': '---\nwrite:\n  - ops@agent.hexis\n---\n',
      },
      'live',
    );
    const { r, written } = rewriter(committed, realDisk(), { live });

    expect(await r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).toBe(7);
    expect(Object.keys(written).sort()).toEqual(['Finance/Budget.md', 'access.md']);
    expect(written['Finance/Budget.md']).toBe('---\nread:\n  - ops@bots.acme.com\n---\nCommitted body.\n');
  });

  it('opens nothing when only an uncommitted file names a bot', async () => {
    const committed = await seed({ 'access.md': '---\nread:\n  - dana@acme.com\n---\n' });
    const live = await seed({ 'QA/Unz2/access.md': '---\nread:\n  - ops@agent.hexis\n---\n' }, 'live');
    const { r, written } = rewriter(committed, realDisk(), { live });
    expect(await r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).toBeNull();
    expect(written).toEqual({});
  });

  it('touches no git at all when there is no bot', async () => {
    const dir = await seed({ 'access.md': '---\nread:\n  - ops@agent.hexis\n---\n' });
    // A walker that fails if asked: with no bot the rewrite reads nothing.
    const refusing: Pick<ITreeWalker, 'walkKb'> = {
      walkKb: async () => {
        throw new Error('read with no bot');
      },
    };
    const { r, written, calls } = rewriter(dir, refusing);
    expect(await r.open(ADMIN, 'agent.hexis', 'bots.acme.com', [])).toBeNull();
    expect(written).toEqual({});
    expect(calls).toEqual([]);
  });

  it('tells the admin, in the request, that grants it could not see stop counting once it is merged', async () => {
    const dir = await seed({ 'access.md': '---\nread:\n  - ops@agent.hexis\n---\n' });
    const { r, descriptions } = rewriter(dir);
    expect(await r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).toBe(7);
    expect(descriptions).toHaveLength(1);
    expect(descriptions[0]).toContain('stops counting once this is merged');
    expect(descriptions[0]).toContain('search for @agent.hexis after merging');
  });

  it('keeps the branch, and answers the failure, when the rewrite is committed but its push is handed to recovery', async () => {
    const dir = await seed({ 'access.md': '---\nread:\n  - ops@agent.hexis\n---\n' });
    const handedOff = new PushNeedsAgentResolutionError('bots/domain-x', 'access.md', 'rejected', 'rejected', 'refused');
    const { r, calls } = rewriter(dir, realDisk(), { failCommit: handedOff });
    await expect(r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).rejects.toBe(handedOff);
    // The commit is the rewrite and recovery owns it: nothing deletes its branch, and no request is opened.
    expect(calls.some((c) => c.startsWith('delete'))).toBe(false);
    expect(calls.some((c) => c.startsWith('request'))).toBe(false);
    expect(calls.at(-1)).toMatch(/^commit by admin@acme\.com/);
  });

  it('removes the branch and answers the failure when the rewrite cannot be committed', async () => {
    const dir = await seed({ 'access.md': '---\nread:\n  - ops@agent.hexis\n---\n' });
    const { r, calls } = rewriter(dir, realDisk(), { failCommit: true });
    await expect(r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).rejects.toThrow('commit failed');
    expect(calls.at(-1)).toMatch(/^delete bots\/domain-/);
    expect(calls.some((c) => c.startsWith('request'))).toBe(false);
  });

  it('still answers nothing to rewrite, and the original failure, when the unused branch cannot be removed', async () => {
    const empty = await seed({ 'access.md': '---\nread:\n  - dana@acme.com\n---\n' });
    expect(await rewriter(empty, realDisk(), { failDelete: true }).r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).toBeNull();
    const failing = rewriter(empty, realDisk(), { failDelete: true, failCommit: true });
    await writeFile(path.join(empty, KB, 'access.md'), '---\nread:\n  - ops@agent.hexis\n---\n');
    await expect(failing.r.open(ADMIN, 'agent.hexis', 'bots.acme.com', ['ops'])).rejects.toThrow('commit failed');
  });
});
