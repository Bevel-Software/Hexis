import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { FileChangeNotifier } from '../../modules/kb-fs/file-change-notifier.js';
import { WorkflowEventBus } from '../../modules/workflow/event-bus.js';
import { registerCatalogCacheInvalidation } from '../catalog-cache-invalidation.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import { testKbContext } from '../../__tests__/kb-context.js';

const KB_DIR = 'knowledge-base';

const USER = {
  id: 'u1',
  email: 'someone@example.com',
  name: 'Someone',
} as unknown as Parameters<Parameters<FileChangeNotifier['onFilesChanged']>[0]>[0]['byUser'];

function setup() {
  const eventBus = new WorkflowEventBus();
  const fileChangeNotifier = new FileChangeNotifier();
  const catalogs = [
    { invalidate: vi.fn() },
    { invalidate: vi.fn() },
    { invalidate: vi.fn() },
  ];
  const accessControl = { invalidate: vi.fn() };
  const off = registerCatalogCacheInvalidation({
    eventBus,
    fileChangeNotifier,
    kb: testKbContext({ kbDirName: KB_DIR }),
    catalogs,
    accessControl,
  });
  /** How many times EVERY catalog was dropped — they are only ever dropped together. */
  const drops = () => {
    const counts = catalogs.map((c) => c.invalidate.mock.calls.length);
    expect(new Set(counts).size).toBe(1);
    return counts[0];
  };
  return { eventBus, fileChangeNotifier, drops, off, accessControl };
}

describe('registerCatalogCacheInvalidation', () => {
  describe('commit-time (FileChangeNotifier)', () => {
    it('drops the catalogs when a default-branch commit touches Plugins/', () => {
      const { fileChangeNotifier, drops } = setup();
      fileChangeNotifier.emit({
        workspaceId: 'ws',
        branch: DEFAULT_BRANCH,
        paths: [`${KB_DIR}/Plugins/Engineering/coding/SKILL.md`],
        byUser: USER,
      });
      expect(drops()).toBe(1);
    });

    /**
     * The four files a released catalog is MADE of. A commit touching any of
     * them has to drop the caches at once — the agent tester's report was a
     * valid `.tool` that stayed absent and uncallable until the connection was
     * recreated, and each of these declares tools or skills the same way.
     */
    it.each([
      ['a `.tool` manual', `${KB_DIR}/Plugins/Everyone/software.bevel.hexis/tools/serper.tool`],
      ['an mcp.json', `${KB_DIR}/Plugins/Everyone/mcp.json`],
      ['a plugin.json', `${KB_DIR}/Plugins/Everyone/plugin.json`],
      ['a SKILL.md under a plugin', `${KB_DIR}/Plugins/Everyone/skills/rfi/SKILL.md`],
      ['a SKILL.md under the shared root', `${KB_DIR}/Skills/Ops/rfi/SKILL.md`],
    ])('drops the catalogs when a default-branch commit touches %s', (_what, path) => {
      const { fileChangeNotifier, drops } = setup();
      fileChangeNotifier.emit({ workspaceId: 'ws', branch: DEFAULT_BRANCH, paths: [path], byUser: USER });
      expect(drops()).toBe(1);
    });

    /**
     * A REMOVAL is the same signal as an addition: the notifier reports the
     * paths a commit touched, and a deleted manual is one of them. Without
     * this the removed tool stays listed — and callable — for a full TTL.
     */
    it('drops them for a removal, which reaches here as the same touched path', () => {
      const { fileChangeNotifier, drops } = setup();
      fileChangeNotifier.emit({
        workspaceId: 'ws',
        branch: DEFAULT_BRANCH,
        paths: [`${KB_DIR}/Plugins/Everyone/software.bevel.hexis/tools/retired.tool`],
        byUser: USER,
      });
      expect(drops()).toBe(1);
    });

    /** One drop per commit, whichever of its paths qualified. */
    it('drops them once for a batch that touches several catalog files', () => {
      const { fileChangeNotifier, drops } = setup();
      fileChangeNotifier.emit({
        workspaceId: 'ws',
        branch: DEFAULT_BRANCH,
        paths: [
          `${KB_DIR}/KnowledgeBase/Note.md`,
          `${KB_DIR}/Plugins/Everyone/mcp.json`,
          `${KB_DIR}/Plugins/Everyone/plugin.json`,
        ],
        byUser: USER,
      });
      expect(drops()).toBe(1);
    });

    it('ignores commits on other branches, and commits outside Plugins/', () => {
      const { fileChangeNotifier, drops } = setup();
      fileChangeNotifier.emit({
        workspaceId: 'ws',
        branch: 'feature/x',
        paths: [`${KB_DIR}/Plugins/Engineering/coding/SKILL.md`],
        byUser: USER,
      });
      fileChangeNotifier.emit({
        workspaceId: 'ws',
        branch: DEFAULT_BRANCH,
        paths: [`${KB_DIR}/KnowledgeBase/Note.md`],
        byUser: USER,
      });
      expect(drops()).toBe(0);
    });
  });

  describe("the default branch's tree changed", () => {
    /**
     * The bug this exists for: approving a proposed skill closed its change
     * request (so it left the pending shelf at once) while the released catalog
     * kept serving its pre-merge scan, and the card vanished from the library
     * until the TTL ran out.
     *
     * One test, because the subscriber sees ONE signal: the merge reaches here
     * as the `fs-tree-changed` its post-merge pull emits, exactly as a
     * working-tree write does — NOT as a `change-request-merged` special
     * case. That a pull of the default workspace actually emits this event
     * (only after it resolves, and only when it changed the tree's content) is the emitter's
     * own contract, pinned in workflow.service.releaseLock.test.ts under
     * "the tree-change announcement".
     */
    it('drops the catalogs when the default tree changes (write or post-merge pull alike)', () => {
      const { eventBus, drops } = setup();
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws', branch: DEFAULT_BRANCH });
      expect(drops()).toBe(1);
    });

    it('drops them when a diverged workspace is reconciled', () => {
      const { eventBus, drops } = setup();
      eventBus.emit({ kind: 'git-sync-recovered', workspaceId: 'ws', branch: DEFAULT_BRANCH });
      expect(drops()).toBe(1);
    });

    it('ignores both events on another branch', () => {
      const { eventBus, drops } = setup();
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws', branch: 'feature/x' });
      eventBus.emit({ kind: 'git-sync-recovered', workspaceId: 'ws', branch: 'feature/x' });
      expect(drops()).toBe(0);
    });

    it('drops them BEFORE the event reaches a browser session', () => {
      const { eventBus, drops } = setup();
      const seenAtPush: number[] = [];
      eventBus.subscribe({
        sessionId: 's1',
        userId: 'u1',
        // `fs-tree-changed` is workspace-scoped, so a session only receives
        // it while watching that workspace.
        getFocusedWorkspaceIds: () => ['ws'],
        // The browser reloads the library off this event; if the caches were
        // still warm here, the reload would re-read the stale catalog.
        push: () => seenAtPush.push(drops()),
      });
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws', branch: DEFAULT_BRANCH });
      expect(seenAtPush).toEqual([1]);
    });

    it('does not drop them when a merge fails', () => {
      const { eventBus, drops } = setup();
      eventBus.emit({
        kind: 'change-request-merge-failed',
        forUserId: 'u1',
        number: 42,
        reason: 'conflicts',
        conflicts: true,
      });
      expect(drops()).toBe(0);
    });
  });

  /**
   * The read gate goes with them. Every catalog here is ACL-filtered, and a
   * skill's or a manual's own `read:` frontmatter lives in the very file the
   * commit rewrote — but the batch gate memoizes those own-entry rules per
   * workspace for five minutes. A fresh catalog resolved through a stale gate
   * is the pair disagreeing: a revoked skill still loadable by name, a
   * just-granted one still missing from the listing, for the rest of the memo.
   */
  it('drops the access gate for the default workspace with them', () => {
    const { fileChangeNotifier, eventBus, drops, accessControl } = setup();
    fileChangeNotifier.emit({
      workspaceId: 'ws',
      branch: DEFAULT_BRANCH,
      paths: [`${KB_DIR}/Skills/Ops/rfi/SKILL.md`],
      byUser: USER,
    });
    expect(drops()).toBe(1);
    expect(accessControl.invalidate).toHaveBeenCalledExactlyOnceWith(workspaceIdForBranch(DEFAULT_BRANCH));

    eventBus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws', branch: DEFAULT_BRANCH });
    expect(accessControl.invalidate).toHaveBeenCalledTimes(2);

    // And not for a branch these catalogs never read.
    eventBus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws2', branch: 'agent/draft' });
    expect(accessControl.invalidate).toHaveBeenCalledTimes(2);
  });

  it('detaches every subscription on unsubscribe', () => {
    const { eventBus, fileChangeNotifier, drops, off } = setup();
    off();
    eventBus.emit({ kind: 'change-request-merged', number: 42 });
    eventBus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws', branch: DEFAULT_BRANCH });
    fileChangeNotifier.emit({
      workspaceId: 'ws',
      branch: DEFAULT_BRANCH,
      paths: [`${KB_DIR}/Plugins/Engineering/coding/SKILL.md`],
      byUser: USER,
    });
    expect(drops()).toBe(0);
  });
});
