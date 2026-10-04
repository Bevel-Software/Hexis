import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { NodeFs } from '../../kb-fs/node-fs.js';
import { WorkspaceService } from '../workspace.service.js';
import { NodeGitRunner } from '../../workflow/git/node-git-runner.js';
import { gitCredentials } from '../../../shared/git.contract.js';

const execFileAsync = promisify(execFile);

/**
 * The working copy a repo-global operation is handed.
 *
 * Listing change requests, reading one by number, listing branches: none of
 * them is about a particular draft, so they run in whichever clone is already
 * on disk (`findAnyWorkspaceId`). That clone is one this process may never have
 * opened — and a clone gets its credential helper when its branch is opened.
 *
 * A deployment's oldest clone had none: it predated the helper being persisted.
 * It sorted first on disk, so every repo-global fetch ran in it, failed with
 * "could not read Username", was swallowed, and came back as `unknown branch`
 * for each open change request — thirty-four of them, on every list, while all
 * thirty-four branches were on the remote. Opening that one branch in the app
 * stamped the helper and the errors stopped.
 */

const BRANCH = 'main';
const OLD_DRAFT = 'someone/an-old-draft';
const KB_DIR = 'knowledge-base';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@x.com',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@x.com',
    },
  });
  return stdout.toString();
}

/** The credential helpers a clone's own config carries; none is the empty list. */
async function helpersOf(repoDir: string): Promise<string[]> {
  return git(repoDir, ['config', '--local', '--get-all', 'credential.helper']).then(
    (out) => out.split('\n').filter((line) => line.trim() !== ''),
    () => [],
  );
}

let root: string;
let workspacesRoot: string;
let upstream: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-any-creds-'));
  workspacesRoot = path.join(root, 'workspaces');
  await fs.mkdir(workspacesRoot, { recursive: true });
  upstream = path.join(root, 'upstream.git');
  await git(root, ['init', '--bare', '-b', BRANCH, upstream]);
  const seed = path.join(root, '.seed');
  await fs.mkdir(seed);
  await git(seed, ['init', '-b', BRANCH]);
  await fs.writeFile(path.join(seed, 'README.md'), 'seed\n', 'utf8');
  await git(seed, ['add', '-A']);
  await git(seed, ['commit', '-m', 'init']);
  await git(seed, ['remote', 'add', 'origin', upstream]);
  await git(seed, ['push', 'origin', BRANCH]);
  await git(seed, ['push', 'origin', `${BRANCH}:refs/heads/${OLD_DRAFT}`]);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A clone as an older build left it: on disk, complete, and with no helper of ours. */
async function anOldCloneWithNoHelper(branch: string): Promise<string> {
  const repoDir = path.join(workspacesRoot, encodeURIComponent(branch), KB_DIR);
  await fs.mkdir(path.dirname(repoDir), { recursive: true });
  await git(root, ['clone', '-b', branch, upstream, repoDir]);
  expect(await helpersOf(repoDir)).toEqual([]);
  return repoDir;
}

function service(token: string | null) {
  return new WorkspaceService(
    workspacesRoot,
    () => upstream,
    testKbContext({ kbDirName: KB_DIR, branchModel: { defaultBranch: BRANCH, protectedBranches: [BRANCH] } }),
    new NodeFs(),
    new NodeGitRunner(undefined, gitCredentials('x-access-token', token)),
  );
}

describe('the working copy a repo-global operation runs in', () => {
  it('is given the deployment’s credential helper before it is handed out', async () => {
    const repoDir = await anOldCloneWithNoHelper(OLD_DRAFT);

    const id = await service('a-token').findAnyWorkspaceId();

    expect(id).toBe(encodeURIComponent(OLD_DRAFT));
    // One helper, ours: the one that reads the token from the environment the
    // runner hands each git call. The token itself is never written down.
    const helpers = await helpersOf(repoDir);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]).toContain('GITHUB_TOKEN');
    expect(helpers[0]).not.toContain('a-token');
  });

  it('is the same clone it always picked: the first on disk', async () => {
    await anOldCloneWithNoHelper(OLD_DRAFT);
    await anOldCloneWithNoHelper(BRANCH);
    const svc = service('a-token');
    const entries = (await fs.readdir(workspacesRoot)).filter((name) => !name.startsWith('.'));
    expect(await svc.findAnyWorkspaceId()).toBe(entries[0]);
  });

  it('keeps a helper an operator wrote themselves, beside ours', async () => {
    const repoDir = await anOldCloneWithNoHelper(OLD_DRAFT);
    await git(repoDir, ['config', '--add', 'credential.helper', 'store']);

    await service('a-token').findAnyWorkspaceId();

    const helpers = await helpersOf(repoDir);
    expect(helpers).toContain('store');
    expect(helpers.some((h) => h.includes('GITHUB_TOKEN'))).toBe(true);
  });

  it('writes the helper once, not on every call', async () => {
    const repoDir = await anOldCloneWithNoHelper(OLD_DRAFT);
    const svc = service('a-token');
    await svc.findAnyWorkspaceId();
    const config = path.join(repoDir, '.git', 'config');
    const stampedAt = (await fs.stat(config)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));

    await svc.findAnyWorkspaceId();
    await svc.findAnyWorkspaceId();

    expect((await fs.stat(config)).mtimeMs).toBe(stampedAt);
  });

  it('stamps nothing on a deployment that has no token', async () => {
    const repoDir = await anOldCloneWithNoHelper(OLD_DRAFT);
    expect(await service(null).findAnyWorkspaceId()).toBe(encodeURIComponent(OLD_DRAFT));
    expect(await helpersOf(repoDir)).toEqual([]);
  });

  it('still answers null when nothing is cloned', async () => {
    expect(await service('a-token').findAnyWorkspaceId()).toBeNull();
  });
});
