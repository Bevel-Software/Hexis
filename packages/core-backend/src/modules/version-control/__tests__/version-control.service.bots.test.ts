import { describe, expect, it, vi } from 'vitest';
import { testKbContext } from '../../../__tests__/kb-context.js';
import type { AuthUser } from '@bevel-software/platform-shared';
import type { GitService } from '../git/git.service.js';
import type { PullRequestService } from '../git/pull-request.service.js';
import type { IChangeRequestReviewService } from '../change-request-review/change-request-review.interface.js';
import type { WorkspaceService } from '../../workspace/workspace.service.js';
import type { IAccessControl } from '../../access/access-control.interface.js';
import type { FileLockService } from '../file-lock.service.js';
import type { PendingCommitsService } from '../pending-commits.service.js';
import { VersionControlEventBus } from '../event-bus.js';
import { VersionControlService } from '../version-control.service.js';
import type { Database } from '../../database/connection.js';
import type { IChangeReadGate } from '../../access-model/change-gate.js';
import { BotChangesAccessError } from '../../access-model/index.js';

/**
 * A bot never changes access, at the two places every change of it passes:
 * the lock every write acquires (on any branch, drafts included, where no
 * write gate runs), and the merge of a change request. A person is held to
 * neither, and a bot's other writes and merges go through as before.
 */

const KB = 'knowledge-base';
const DRAFT = 'bots/proposal';
const WS = 'ws-1';
const BOT: AuthUser = { id: 'u-bot', email: 'release-helper@agent.hexis', name: 'release-helper' };
const PERSON: AuthUser = { id: 'u-dana', email: 'dana@acme.com', name: 'Dana' };
const isBot = (email: string) => email === BOT.email;

function makeService(changed: Record<string, { base: string | null; head: string | null }> = {}) {
  const acquire = vi.fn(async () => ({ acquired: true, lock: {} as never }));
  const gate: IChangeReadGate = { judge: vi.fn(), assertMayChange: vi.fn(async () => undefined) };
  const git = {
    fetch: vi.fn(async () => undefined),
    changedPathsForPr: vi.fn(async () => Object.keys(changed)),
    readFileAtRef: vi.fn(async (_ws: string, ref: string, p: string) =>
      ref.endsWith('main') ? (changed[p]?.base ?? null) : (changed[p]?.head ?? null),
    ),
  } as unknown as GitService;
  const prs = { getPr: vi.fn(async () => ({ base: 'main', branch: DRAFT })) } as unknown as PullRequestService;
  const mergePr = vi.fn(async () => ({ merged: true }));
  const svc = new VersionControlService(
    {} as unknown as Database,
    git,
    prs,
    { mergePr } as unknown as IChangeRequestReviewService,
    { getOrCreateForBranch: vi.fn(async () => ({ id: 'ws-draft' })) } as unknown as WorkspaceService,
    {} as IAccessControl,
    { acquire, get: vi.fn(async () => null) } as unknown as FileLockService,
    {} as PendingCommitsService,
    testKbContext({ kbDirName: KB }),
    gate,
    new VersionControlEventBus(),
    undefined,
    undefined,
    undefined,
    isBot,
  );
  return { svc, acquire, mergePr };
}

describe('a bot at the lock', () => {
  it.each(['roles.yaml', 'access.md', 'Team/access.md', 'groups.yaml', 'synced-groups.yaml'])(
    'is refused %s, on a draft branch too, before any lock is taken',
    async (file) => {
      const { svc, acquire } = makeService();
      await expect(svc.acquireLock(WS, DRAFT, `${KB}/${file}`, BOT)).rejects.toBeInstanceOf(BotChangesAccessError);
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it('takes the lock on any other file, and a person takes it on an access file as before', async () => {
    const { svc, acquire } = makeService();
    expect((await svc.acquireLock(WS, DRAFT, `${KB}/Team/page.md`, BOT)).acquired).toBe(true);
    expect((await svc.acquireLock(WS, DRAFT, `${KB}/Team/access.md`, PERSON)).acquired).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(2);
  });
});

describe('a bot merging a change request', () => {
  const merge = (svc: VersionControlService, user: AuthUser) =>
    svc.mergeChangeRequest(7, user, 'sha', [], 'open' as never, 'title', 'main', WS);

  it('is refused one that changes an access.md, naming it, and nothing is merged', async () => {
    const { svc, mergePr } = makeService({ 'Team/access.md': { base: 'read:\n  - Eng\n', head: 'read:\n  - everyone\n' } });
    await expect(merge(svc, BOT)).rejects.toThrow(/"Team\/access\.md" decides who may reach what/);
    expect(mergePr).not.toHaveBeenCalled();
  });

  it("is refused one that changes a file's own access lines", async () => {
    const { svc, mergePr } = makeService({
      'Team/page.md': { base: '---\nread:\n  - Eng\n---\n# p\n', head: '---\nread:\n  - everyone\n---\n# p\n' },
    });
    await expect(merge(svc, BOT)).rejects.toThrow(/access lines/);
    expect(mergePr).not.toHaveBeenCalled();
  });
});
