import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import type { WorkspaceService } from '../../../workspace/index.js';
import { VersionControlHooks } from '../../version-control-hooks.js';
import { GitService } from '../git.service.js';

/**
 * Where a file reached HEAD as it is now (its add commit's position on the
 * first-parent chain): what settles which of two people's
 * personal tools keeps a secret namespace both claim (the tool-manual
 * catalog's `setHistory`). Against a real repository, because the answer is git's.
 */

const execFileAsync = promisify(execFile);
const KB_DIR = 'knowledge-base';

describe('GitService.addedPosition', () => {
  let root: string;
  let repo: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'git-first-added-'));
    repo = join(root, 'ws', KB_DIR);
    await mkdir(repo, { recursive: true });
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const git = (args: string[], date: number) =>
    execFileAsync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
        GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
        GIT_AUTHOR_DATE: `@${date} +0000`, GIT_COMMITTER_DATE: `@${date} +0000`,
      },
    });

  // The latest add, not the first: a tool deleted and written again must not
  // reclaim a namespace someone else's tool took in between.
  test('answers the add that began the file as it is now, not a later edit; null for a file never committed', async () => {
    await git(['init', '-b', 'main'], 1);
    await writeFile(join(repo, 'a.tool'), 'one\n');
    await git(['add', '.'], 1);
    await git(['commit', '-m', 'add'], 1_000);
    await writeFile(join(repo, 'a.tool'), 'two\n');
    await git(['commit', '-am', 'edit'], 2_000);
    const g = new GitService(
      { getWorkspacePath: async () => join(root, 'ws') } as unknown as WorkspaceService,
      new VersionControlHooks(),
      testKbContext({ kbDirName: KB_DIR }),
    );
    expect(await g.addedPosition('ws', 'a.tool')).toBe(1);

    await git(['rm', '-q', 'a.tool'], 3_000);
    await git(['commit', '-m', 'remove'], 3_000);
    await writeFile(join(repo, 'a.tool'), 'three\n');
    await git(['add', '.'], 4_000);
    await git(['commit', '-m', 're-add'], 4_000);
    await writeFile(join(repo, 'b.tool'), 'uncommitted\n');

    expect(await g.addedPosition('ws', 'a.tool')).toBe(4);
    expect(await g.addedPosition('ws', 'b.tool')).toBeNull();
    // A literal path, not a glob: `*.tool` names no committed file.
    expect(await g.addedPosition('ws', '*.tool')).toBeNull();

    // Added on a draft at 5_000, merged (`--no-ff`, as the platform merges) at
    // 7_000: it reached the branch at the merge, after main's own 6_000 add.
    await git(['checkout', '-q', '-b', 'draft'], 5_000);
    await writeFile(join(repo, 'c.tool'), 'draft\n');
    await git(['add', 'c.tool'], 5_000);
    await git(['commit', '-m', 'draft add'], 5_000);
    await git(['checkout', '-q', 'main'], 6_000);
    await writeFile(join(repo, 'd.tool'), 'main\n');
    await git(['add', 'd.tool'], 6_000);
    await git(['commit', '-m', 'main add'], 6_000);
    await git(['merge', '--no-ff', '-m', 'merge draft', 'draft'], 7_000);
    expect(await g.addedPosition('ws', 'c.tool')).toBe(6);
    expect(await g.addedPosition('ws', 'd.tool')).toBe(5);

    // Two adds in the same second, then one under a clock that went back:
    // each keeps its commit's place, which a commit date could not say.
    for (const [name, date] of [['e.tool', 9_000], ['f.tool', 9_000], ['g.tool', 10]] as const) {
      await writeFile(join(repo, name), 'later\n');
      await git(['add', name], date);
      await git(['commit', '-m', `add ${name}`], date);
    }
    expect(await g.addedPosition('ws', 'e.tool')).toBe(7);
    expect(await g.addedPosition('ws', 'f.tool')).toBe(8);
    expect(await g.addedPosition('ws', 'g.tool')).toBe(9);
  });
});
