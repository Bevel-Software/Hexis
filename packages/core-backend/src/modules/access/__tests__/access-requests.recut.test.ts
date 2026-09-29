import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { spliceGrant } from '../../access-model/access-splice.js';
import { pendingProposals } from '../../plugins/join-proposals.js';

const execFileAsync = promisify(execFile);

/**
 * WHY A REQUEST BRANCH IS CUT AGAIN FROM LIVE, proved against real git.
 *
 * Opening a change request merges the target branch INTO its source branch.
 * A request branch survives being declined — that is what lets the dialog say
 * "your last request wasn't accepted" — so the next request finds a branch
 * whose base may be old. Writing the new proposal onto it and opening the
 * request then asks git to merge live into a branch that edited the same
 * rules file from a different starting point, and git does what git does.
 *
 * The person asking is told to "resolve on reader2/join-artest3-04i7dr4", a
 * branch they cannot reach, and every retry says the same thing. There is no
 * route out of it for them, which is what made this worth a fix rather than a
 * better error message.
 *
 * Everything below is plain git on a scratch repo: no app, no doubles. The
 * first case is the bug, kept so the fix cannot quietly stop being necessary;
 * the second is the fix.
 */
describe('a request branch whose base has moved', () => {
  let root: string;
  let repo: string;

  const RULES = 'Research/access.md';
  const LIVE = 'live';
  const REQUEST = 'reader2/join-research-abc1234-def5678';
  const RITA = { kind: 'user' as const, email: 'rita@x.io', displayName: 'Rita' };
  const RAVI = { kind: 'user' as const, email: 'ravi@x.io', displayName: 'Ravi' };

  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args]);

  const readRules = async () => fs.readFile(path.join(repo, RULES), 'utf-8');
  const writeRules = async (text: string) => {
    await fs.mkdir(path.dirname(path.join(repo, RULES)), { recursive: true });
    await fs.writeFile(path.join(repo, RULES), text);
  };
  const commit = async (message: string) => {
    await git('add', '-A');
    await git('commit', '-q', '-m', message);
  };

  /** What opening a change request does: merge live INTO the request branch. */
  async function mergeLiveIntoRequest(): Promise<{ ok: boolean; conflicted: string[] }> {
    try {
      await git('merge', '--no-edit', LIVE);
      return { ok: true, conflicted: [] };
    } catch {
      const { stdout } = await execFileAsync('git', [
        '-C',
        repo,
        'diff',
        '--name-only',
        '--diff-filter=U',
      ]);
      await git('merge', '--abort');
      return { ok: false, conflicted: stdout.split('\n').filter(Boolean) };
    }
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-recut-'));
    repo = path.join(root, 'kb');
    await fs.mkdir(repo, { recursive: true });
    await git('init', '-q', '-b', LIVE);
    await git('config', 'user.email', 'test@bevel.software');
    await git('config', 'user.name', 'Test');
    await writeRules('---\n---\nowner:\n  - Ed <ed@x.io>\n');
    await commit('the rules as they were');

    // Ravi asked for Owner, and it was declined. The branch stays behind.
    await git('checkout', '-q', '-b', REQUEST);
    await writeRules(spliceGrant(await readRules(), 'owner', RAVI, { target: 'folder' }).text);
    await commit('Request owner access to Research');
    await git('checkout', '-q', LIVE);

    // Then an editor grants somebody else Can edit here — an ordinary click in
    // the dialog, and the only thing this scenario needs to go wrong.
    await writeRules(spliceGrant(await readRules(), 'write', RITA, { target: 'folder' }).text);
    await commit('Ed grants Rita Can edit');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('CONFLICTS when the stale branch is written to and the request opened on it', async () => {
    // What this did before: splice onto live's text, write it to the branch as
    // it stands, open the request. The content is right; the history is not.
    await git('checkout', '-q', REQUEST);
    const live = await execFileAsync('git', ['-C', repo, 'show', `${LIVE}:${RULES}`]);
    await writeRules(spliceGrant(live.stdout, 'write', RAVI, { target: 'folder' }).text);
    await commit('Request can edit access to Research');

    const merged = await mergeLiveIntoRequest();
    expect(merged.ok).toBe(false);
    expect(merged.conflicted).toEqual([RULES]);
  });

  it('is CLEAN once the branch is cut again from live first', async () => {
    // The fix: the answered request's branch is deleted and recut from live,
    // so live's tip is the merge base and there is nothing to reconcile.
    await git('branch', '-q', '-D', REQUEST);
    await git('checkout', '-q', '-b', REQUEST, LIVE);
    await writeRules(spliceGrant(await readRules(), 'write', RAVI, { target: 'folder' }).text);
    await commit('Request can edit access to Research');

    const merged = await mergeLiveIntoRequest();
    expect(merged.ok).toBe(true);

    // And the branch proposes exactly one thing — asked of the function the
    // app itself asks, rather than of the diff's line-by-line shape (a splice
    // may rewrite a whole block without proposing anything more). Rita's
    // grant is already on live, so it is nothing new; the declined Owner
    // proposal went with the branch that carried it.
    const branchText = (await execFileAsync('git', ['-C', repo, 'show', `${REQUEST}:${RULES}`]))
      .stdout;
    const liveText = (await execFileAsync('git', ['-C', repo, 'show', `${LIVE}:${RULES}`])).stdout;
    expect(pendingProposals(branchText, liveText, RULES)).toEqual([
      expect.objectContaining({ verb: 'write', id: `user:${RAVI.email}` }),
    ]);
  });
});
