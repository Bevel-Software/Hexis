import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testKbContext } from '../../../../__tests__/kb-context.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { WorkspaceService } from '../../../workspace/workspace.service.js';
import { WorkflowHooks } from '../../workflow-hooks.js';
import { GitService } from '../git.service.js';

const execFileAsync = promisify(execFile);

/**
 * What the log says when a change request's branches cannot be fetched.
 *
 * The fetch is best-effort: when it fails, the refs are resolved from what the
 * working copy already has. A working copy that could not reach the remote at
 * all then reported `unknown branch` for every branch it had never seen, and
 * nothing said the fetch had been refused — the log named a missing branch
 * that was on the remote the whole time.
 */

const TRUNK = 'current-company-state';
const WORKSPACE = 'ws-pr-fetch';

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

let root: string;
let repo: string;
let upstream: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-pr-fetch-'));
  upstream = path.join(root, 'upstream.git');
  await runGit(root, ['init', '--bare', '-b', TRUNK, upstream]);
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await runGit(seed, ['init', '-b', TRUNK]);
  await runGit(seed, ['remote', 'add', 'origin', upstream]);
  await fs.writeFile(path.join(seed, 'base.md'), 'base\n');
  await runGit(seed, ['add', '-A']);
  await runGit(seed, ['commit', '-m', 'init']);
  await runGit(seed, ['push', 'origin', TRUNK]);
  // A draft the working copy below has never seen: pushed after it was cloned.
  repo = path.join(root, WORKSPACE, 'knowledge-base');
  await fs.mkdir(path.dirname(repo), { recursive: true });
  await runGit(root, ['clone', upstream, repo]);
  await runGit(seed, ['checkout', '-b', 'alice/feature']);
  await fs.writeFile(path.join(seed, 'new.md'), 'new\n');
  await runGit(seed, ['add', '-A']);
  await runGit(seed, ['commit', '-m', 'feature']);
  await runGit(seed, ['push', 'origin', 'alice/feature']);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function service(): GitService {
  const workspaces = {
    getWorkspacePath: async () => path.dirname(repo),
  } as unknown as WorkspaceService;
  return new GitService(workspaces, new WorkflowHooks(), testKbContext());
}

/** Everything the service logged at warn level, as one string per line. */
function warnings(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((call) => call.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
}

describe('a change request whose branches cannot be fetched', () => {
  it('says the fetch failed, and where, when the working copy cannot reach the remote', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // The remote this working copy fetches from is gone from under it.
    await runGit(repo, ['remote', 'set-url', 'origin', path.join(root, 'no-such-remote.git')]);

    await expect(service().changedPathsForPr(WORKSPACE, TRUNK, 'alice/feature')).rejects.toThrow(
      'unknown branch: alice/feature',
    );

    const said = warnings(warn).filter((line) => line.includes('could not fetch change-request branches'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(`"${WORKSPACE}"`);
    expect(said[0]).toContain('though it may be on the remote');
  });

  it('says it once for a list that asks about many requests in one working copy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runGit(repo, ['remote', 'set-url', 'origin', path.join(root, 'no-such-remote.git')]);
    const git = service();

    for (const branch of ['alice/feature', 'bob/other', 'carol/third']) {
      await git.changedPathsForPr(WORKSPACE, TRUNK, branch).catch(() => undefined);
    }

    expect(warnings(warn).filter((line) => line.includes('could not fetch change-request branches'))).toHaveLength(1);
  });

  it('says nothing when the branch is simply gone from the remote: that is what a retired branch looks like', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(service().changedPathsForPr(WORKSPACE, TRUNK, 'dave/retired')).rejects.toThrow(
      'unknown branch: dave/retired',
    );

    expect(warnings(warn).filter((line) => line.includes('could not fetch change-request branches'))).toEqual([]);
  });

  it('says nothing when the fetch works, and finds the branch the working copy had never seen', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await service().changedPathsForPr(WORKSPACE, TRUNK, 'alice/feature')).toEqual(['new.md']);

    expect(warnings(warn).filter((line) => line.includes('could not fetch change-request branches'))).toEqual([]);
  });
});
