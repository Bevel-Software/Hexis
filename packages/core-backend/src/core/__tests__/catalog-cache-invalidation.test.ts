import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { FileChangeNotifier } from '../../modules/kb-fs/file-change-notifier.js';
import { WorkflowEventBus } from '../../modules/workflow/event-bus.js';
import { registerCatalogCacheInvalidation } from '../catalog-cache-invalidation.js';

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
  const off = registerCatalogCacheInvalidation({
    eventBus,
    fileChangeNotifier,
    kbDirName: KB_DIR,
    catalogs,
  });
  /** How many times EVERY catalog was dropped — they are only ever dropped together. */
  const drops = () => {
    const counts = catalogs.map((c) => c.invalidate.mock.calls.length);
    expect(new Set(counts).size).toBe(1);
    return counts[0];
  };
  return { eventBus, fileChangeNotifier, drops, off };
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

  describe('write-time (fs-tree-changed)', () => {
    it('drops the catalogs on a default-branch working-tree write', () => {
      const { eventBus, drops } = setup();
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws', branch: DEFAULT_BRANCH });
      expect(drops()).toBe(1);
    });

    it('ignores a write to another branch', () => {
      const { eventBus, drops } = setup();
      eventBus.emit({ kind: 'fs-tree-changed', workspaceId: 'ws', branch: 'feature/x' });
      expect(drops()).toBe(0);
    });
  });

  describe('merge-time (change-request-merged)', () => {
    /**
     * The bug this exists for: approving a proposed skill closed its change
     * request (so it left the pending shelf at once) while the released catalog
     * kept serving its pre-merge scan, and the card vanished from the library
     * until the TTL ran out. A merge writes the default branch through `git
     * pull`, so neither of the two subscribers above ever fires for it.
     */
    it('drops the catalogs when a change request merges', () => {
      const { eventBus, drops } = setup();
      eventBus.emit({ kind: 'change-request-merged', number: 42 });
      expect(drops()).toBe(1);
    });

    it('drops them BEFORE the event reaches a browser session', () => {
      const { eventBus, drops } = setup();
      const seenAtPush: number[] = [];
      eventBus.subscribe({
        sessionId: 's1',
        userId: 'u1',
        getFocusedWorkspaceId: () => null,
        // The browser reloads the library off this event; if the caches were
        // still warm here, the reload would re-read the stale catalog.
        push: () => seenAtPush.push(drops()),
      });
      eventBus.emit({ kind: 'change-request-merged', number: 42 });
      expect(seenAtPush).toEqual([1]);
    });

    it('does not drop them when a merge fails', () => {
      const { eventBus, drops } = setup();
      eventBus.emit({
        kind: 'change-request-merge-failed',
        number: 42,
        reason: 'conflicts',
        conflicts: true,
      });
      expect(drops()).toBe(0);
    });
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
