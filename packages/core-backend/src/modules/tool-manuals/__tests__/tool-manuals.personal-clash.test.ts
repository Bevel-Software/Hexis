import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import type { ToolManualService } from '../index.js';
import type { ToolManualHistorySource } from '../tool-manuals.contract.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realToolManualService } from '../../../__tests__/tool-manuals.js';
import { realGitService, realVersionControlHooks } from '../../../__tests__/real-version-control.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { IAccessControl } from '../../access/index.js';

/**
 * ONE PERSON'S PRIVATE TOOL NEVER TAKES ANOTHER PERSON'S AWAY.
 *
 * A tool id is the secret-variable namespace the vault keys its secrets by,
 * so two people's personal tools with one id cannot both be served. Which one
 * is served used to follow folder-path order: a newcomer whose personal folder
 * sorted first took an existing tool — and the secrets set for it — away from
 * its owner. The one that landed first keeps it; the newcomer is told, at its
 * own path, without being told whose it collided with.
 *
 * Against a real git repository and the real GitService, because the
 * deciding fact (when a file first landed) is git's answer, not ours.
 */

const execFileAsync = promisify(execFile);
const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

const AAA = 'Plugins/personal-aaa/software.bevel.hexis/tools/qa_zen.tool';
const ZZZ = 'Plugins/personal-zzz/software.bevel.hexis/tools/qa_zen.tool';
const OWNER = { [AAA]: 'aaa@x.eu', [ZZZ]: 'zzz@x.eu' } as const;

const tool = (host: string) =>
  `---\nid: qa_zen\ntype: http\nurl: https://${host}.example/utcp\nheaders:\n  Authorization: "Bearer \${API_KEY}"\n---\n`;

/** Each person reads their own personal folder and nothing of the other's. */
const ownFolderOnly: IAccessControl = {
  canRead: async (_w: string, email: string, p: string) => readsOwn(email, p),
  canReadBatch: async (_w: string, email: string, paths: string[]) =>
    new Map(paths.map((p) => [p, readsOwn(email, p)])),
} as unknown as IAccessControl;

function readsOwn(email: string, p: string): boolean {
  if (p.startsWith('Plugins/personal-aaa/')) return email === 'aaa@x.eu';
  if (p.startsWith('Plugins/personal-zzz/')) return email === 'zzz@x.eu';
  return true;
}

describe('two people, one tool id, each in their own personal plugin', () => {
  let root: string;
  let repo: string;
  let commitAt: number;

  const workspaceService = {
    getOrCreateForBranch: async () => ({ id: wsId }),
    getWorkspacePath: async (id: string) => join(root, id),
    hasBootstrappedWorkspace: async () => false,
  } as unknown as WorkspaceService;

  const git = (args: string[], date?: number) =>
    execFileAsync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
        ...(date === undefined ? {} : { GIT_AUTHOR_DATE: `@${date} +0000`, GIT_COMMITTER_DATE: `@${date} +0000` }),
      },
    });

  const put = async (rel: string, body: string) => {
    await mkdir(dirname(join(repo, rel)), { recursive: true });
    await writeFile(join(repo, rel), body);
  };
  /** Write and commit, each commit a day after the last. */
  const land = async (rel: string, body: string) => {
    await put(rel, body);
    await git(['add', '--', rel]);
    commitAt += 86_400;
    await git(['commit', '-m', `add ${rel}`], commitAt);
  };

  const catalog = (history?: ToolManualHistorySource) => {
    const svc = realToolManualService({
      workspaceService,
      accessControl: ownFolderOnly,
      kb: testKbContext({ kbDirName: KB_DIR }),
    });
    if (history) svc.setHistory(history);
    return svc;
  };
  const realGit = (): ToolManualHistorySource => {
    const g = realGitService(
      { getWorkspacePath: async (id: string) => join(root, id) } as unknown as WorkspaceService,
      realVersionControlHooks(),
      testKbContext({ kbDirName: KB_DIR }),
    );
    return { addedAt: g.addedAt.bind(g) };
  };
  const servedTo = async (svc: ToolManualService, email: string) => (await svc.listAccessibleCatalog(email)).tools;
  const reportedTo = async (svc: ToolManualService, email: string) => (await svc.listAccessibleCatalog(email)).invalid;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tools-personal-clash-'));
    repo = join(root, wsId, KB_DIR);
    await mkdir(repo, { recursive: true });
    commitAt = 1_700_000_000;
    await git(['init', '-b', DEFAULT_BRANCH]);
    await land('README.md', 'kb\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  // Both directions: the incumbent's folder sorting FIRST (aaa) and LAST (zzz).
  // Before the fix the zzz-first case served aaa's newcomer to nobody's benefit
  // and took zzz's tool away.
  describe.each([
    { first: AAA, second: ZZZ },
    { first: ZZZ, second: AAA },
  ])('$first landed before $second', ({ first, second }) => {
    test('the owner of the earlier tool keeps it; the newcomer is told, without being told whose', async () => {
      await land(first, tool('incumbent'));
      await land(second, tool('newcomer'));
      const svc = catalog(realGit());

      const kept = await servedTo(svc, OWNER[first]);
      expect(kept.map((t) => [t.name, t.path])).toEqual([['qa_zen', first]]);
      expect(await reportedTo(svc, OWNER[first])).toEqual([]);

      expect(await servedTo(svc, OWNER[second])).toEqual([]);
      const told = await reportedTo(svc, OWNER[second]);
      expect(told.map((i) => i.path)).toEqual([second]);
      expect(told[0]!.reason).toContain('namespace');
      expect(told[0]!.reason).toContain('cannot see');
      // Names nobody: neither the other folder nor its owner.
      const otherFolder = first.split('/')[1]!;
      expect(told[0]!.reason).not.toContain(otherFolder);
      expect(told[0]!.reason).not.toContain(OWNER[first]);

      // The secrets the incumbent's owner set stay theirs: the namespace's
      // admin variable is declared by the incumbent's manual alone.
      expect(await svc.scopeOfVariable('qa__zen_API_KEY')).toBe('admin');
      expect((await svc.listAllSummaries()).filter((t) => t.name === 'qa_zen').map((t) => t.path)).toEqual([first]);
    });

    test('a newcomer written but not committed yet does not displace the committed tool', async () => {
      await land(first, tool('incumbent'));
      await put(second, tool('newcomer'));
      const svc = catalog(realGit());

      expect((await servedTo(svc, OWNER[first])).map((t) => t.path)).toEqual([first]);
      expect((await reportedTo(svc, OWNER[second])).map((i) => i.path)).toEqual([second]);
    });
  });

  test('when history cannot be read, neither is served rather than the wrong one', async () => {
    await land(AAA, tool('a'));
    await land(ZZZ, tool('z'));
    const svc = catalog({
      addedAt: async () => {
        throw new Error('git is unavailable');
      },
    });

    expect(await servedTo(svc, 'aaa@x.eu')).toEqual([]);
    expect(await servedTo(svc, 'zzz@x.eu')).toEqual([]);
    expect((await reportedTo(svc, 'aaa@x.eu')).map((i) => i.path)).toEqual([AAA]);
    expect((await reportedTo(svc, 'zzz@x.eu')).map((i) => i.path)).toEqual([ZZZ]);
  });

  test('one person with no clash keeps their tool even when no history is wired', async () => {
    await land(ZZZ, tool('z'));
    const svc = catalog();
    expect((await servedTo(svc, 'zzz@x.eu')).map((t) => t.path)).toEqual([ZZZ]);
  });
});
