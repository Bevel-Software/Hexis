/**
 * The approval gate after a change of the bots' domain, through the real
 * access resolver over a git tree: until the change request rewriting the
 * grants is merged, a grant written at the old domain counts for the bot's
 * approvals as it counts for its reads — a bot named as a required approver
 * at the old domain approves under its current address and opens the gate,
 * and a denial written at the old domain still shuts it. Once the old domain
 * stops counting, neither spelling at it does anything.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PullRequestFile } from '@bevel-software/platform-shared';

import type { WorkspaceService } from '../../../workspace/index.js';
import type { IAccessControl } from '../../../access/index.js';
import { realAccessControl } from '../../../../__tests__/real-access.js';
import { realDisk } from '../../../../__tests__/real-disk.js';
import { BotAddressBook } from '../../../bots/index.js';
import type { Database } from '../../../database/index.js';
import type { GitService } from '../../git/git.service.js';
import { ChangeRequestReviewService } from '../change-request-review.service.js';

const execFileAsync = promisify(execFile);
const KB_DIR = 'knowledge-base';
const WS = 'ws-bot-previous-domain';
const HEAD = 'head-sha-1';

const OLD = 'release-helper@old.example';
const BOT = 'release-helper@agent.hexis';

const fm = (body: string) => `---\n${body}---\n`;
const TREE: Record<string, string> = {
  'roles.yaml': 'roles:\n  Admin:\n    - admin@x.io\n',
  'groups.yaml': `groups:\n  Releasers:\n    - ${OLD}\n`,
  'access.md': fm('read:\n  - everyone\nwrite:\n  - Admin\n'),
  // Named directly, at the old domain, as the one who may write here.
  'Direct/access.md': fm(`write:\n  - Release helper <${OLD}>\n`),
  'Direct/page.md': '# direct\n',
  // Through a group whose member list still names the old address.
  'Group/access.md': fm('write:\n  - group/Releasers\n'),
  'Group/page.md': '# group\n',
  // Everyone writes, but the bot is denied at the old domain.
  'Denied/access.md': fm(`write:\n  - everyone\n  - deny Release helper <${OLD}>\n`),
  'Denied/page.md': '# denied\n',
};

function file(p: string): PullRequestFile {
  return { path: p, status: 'modified', additions: 1, deletions: 0, isBinary: false, sha: 'blob', rawUrl: '' } as PullRequestFile;
}

/** The bot's approvals, signed with its current address, at the request's head. */
function db(paths: string[]): Database {
  const rows = paths.map((p) => ({
    prNumber: 7,
    path: p,
    approverEmail: BOT,
    approverName: 'Release helper',
    headSha: HEAD,
    approvedAt: new Date('2026-11-22T00:00:00Z'),
  }));
  return { select: () => ({ from: () => ({ where: async () => rows }) }) } as unknown as Database;
}

describe('a bot\'s approvals while the bots\' domain change request is open', () => {
  let root: string;
  let book: BotAddressBook;
  let access: IAccessControl;
  const PATHS = ['Direct/page.md', 'Group/page.md', 'Denied/page.md'];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'bevel-bot-prev-domain-'));
    const workspaceDir = path.join(root, WS);
    const repo = path.join(workspaceDir, KB_DIR);
    for (const [rel, text] of Object.entries(TREE)) {
      await fs.mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
      await fs.writeFile(path.join(repo, rel), text);
    }
    const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args]);
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@x.io');
    await git('config', 'user.name', 'Test');
    await git('add', '-A');
    await git('commit', '-m', 'seed');
    // The gate reads the request's target as the shared remote holds it.
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    const workspaceService = {
      getWorkspacePath: async () => workspaceDir,
      ensureRemotesFetched: async () => undefined,
    } as unknown as WorkspaceService;
    book = new BotAddressBook();
    book.replace({ domain: 'agent.hexis', botIds: ['release-helper'], previousDomain: 'old.example' });
    access = realAccessControl(workspaceService, KB_DIR, realDisk(), book);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function review() {
    const workspace = { ensureRemotesFetched: vi.fn(async () => undefined) } as unknown as WorkspaceService;
    return new ChangeRequestReviewService(db(PATHS), access, workspace, {} as unknown as GitService);
  }

  it('names the bot granted at the old domain as a required approver under its current address', async () => {
    const eligible = await access.eligibleWritersForPathsAtRef(WS, 'origin/main', PATHS);
    expect(eligible?.get('Direct/page.md')?.users).toEqual([{ name: '', email: BOT }]);
    // The bot, under its current address only (the admin is eligible by the Admin floor).
    expect(eligible?.get('Direct/page.md')?.emails.has(BOT)).toBe(true);
    expect(eligible?.get('Direct/page.md')?.emails.has(OLD)).toBe(false);
    expect(eligible?.get('Group/page.md')?.emails.has(BOT)).toBe(true);
    expect(eligible?.get('Group/page.md')?.emails.has(OLD)).toBe(false);
    expect(eligible?.get('Denied/page.md')?.excludedEmails?.has(BOT)).toBe(true);
    expect(eligible?.get('Denied/page.md')?.excludedEmails?.has(OLD)).toBe(false);
  });

  it('counts the bot\'s approval where it is granted at the old domain, and not where it is denied there', async () => {
    const states = await review().getApprovalStates(7, PATHS.map(file), HEAD, 'main', null, WS, BOT);
    const byPath = new Map(states.map((s) => [s.path, s]));
    expect(byPath.get('Direct/page.md')?.isApproved).toBe(true);
    expect(byPath.get('Direct/page.md')?.viewerCanApprove).toBe(true);
    expect(byPath.get('Group/page.md')?.isApproved).toBe(true);
    expect(byPath.get('Denied/page.md')?.isApproved).toBe(false);
    expect(byPath.get('Denied/page.md')?.viewerCanApprove).toBe(false);
  });

  it('counts nothing at the old domain once the rewrite is merged and it stops counting', async () => {
    book.replace({ domain: 'agent.hexis', botIds: ['release-helper'], previousDomain: null });
    access.invalidate(WS);
    const states = await review().getApprovalStates(7, PATHS.map(file), HEAD, 'main', null, WS, BOT);
    const byPath = new Map(states.map((s) => [s.path, s]));
    expect(byPath.get('Direct/page.md')?.isApproved).toBe(false);
    expect(byPath.get('Group/page.md')?.isApproved).toBe(false);
    // The old-domain denial no longer names the bot, and everyone writes
    // there, but a bot is not part of everyone: it may not approve, and an
    // approval it holds does not open the gate.
    expect(byPath.get('Denied/page.md')?.viewerCanApprove).toBe(false);
    expect(byPath.get('Denied/page.md')?.isApproved).toBe(false);
  });
});
