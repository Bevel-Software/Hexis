import { DEFAULT_BRANCH, PLUGINS_DIR } from '@bevel-software/platform-shared';
import type { FileChangeNotifier } from '../modules/kb-fs/file-change-notifier.js';
import type { WorkflowEventBus } from '../modules/workflow/event-bus.js';

/**
 * A catalog that scans the DEFAULT branch's working tree and caches the result
 * behind a TTL — the skill catalog, the tool-manual catalog, the plugin index.
 * All three answer the same question ("what is released?") off the same folder,
 * so they go stale together and are dropped together.
 */
export interface InvalidatableCatalog {
  invalidate(): void;
}

/**
 * Every way a released catalog can go stale, wired in one place.
 *
 * The TTL inside each catalog is a backstop, not the freshness mechanism: at a
 * minute wide it is far longer than the gap between "the user did the thing"
 * and "the user looks for the result". These three subscribers are what make
 * the next read see the change instead of the previous minute's answer.
 *
 * Returns an unsubscribe that detaches all three.
 */
export function registerCatalogCacheInvalidation(deps: {
  eventBus: WorkflowEventBus;
  fileChangeNotifier: FileChangeNotifier;
  /** The KB folder inside the workspace — `paths` are workspace-relative. */
  kbDirName: string;
  catalogs: InvalidatableCatalog[];
}): () => void {
  const { eventBus, fileChangeNotifier, kbDirName, catalogs } = deps;
  const invalidateAll = () => {
    for (const c of catalogs) c.invalidate();
  };

  // Subscriber A — COMMIT-time freshness: a committed change drops the affected
  // caches immediately instead of waiting out their TTLs. The catalogs are
  // global but read the DEFAULT branch only, so only default-branch changes
  // under their folders matter. (The kb-graph id-index invalidation that used
  // to live here is registered by the enterprise overlay, next to the kb-graph
  // service it belongs to — the caches are independent, so the split preserves
  // behavior.)
  const offFiles = fileChangeNotifier.onFilesChanged(({ branch, paths }) => {
    if (branch !== DEFAULT_BRANCH) return;
    // Skills, tools and the plugin index all live under `Plugins/`, so one
    // touch check drives all three caches. An access grant lands as a
    // default-branch change to `Plugins/<plugin>/access.md`, so this is also
    // what makes a newly-granted plugin unlock within one round-trip instead
    // of one TTL.
    if (paths.some((p) => p.startsWith(`${kbDirName}/${PLUGINS_DIR}/`))) invalidateAll();
  });

  // Subscriber B — WRITE-time freshness for the same catalogs. The workspace
  // routes emit `fs-tree-changed` the moment bytes hit a working tree;
  // Subscriber A fires only when the ASYNC commit lands. Between the two,
  // "create a skill, reload the catalog" raced the commit pipeline and lost —
  // the new skill's card stayed invisible until a refresh outlived the TTL.
  // The catalogs scan the working tree anyway, so invalidating at write time
  // makes the very next read see the file. No path filter: this event carries
  // none, and a spurious drop only costs one re-scan.
  //
  // Subscriber C — MERGE-time freshness, the third way a skill reaches the
  // default branch and the one neither of the above covers. A merge writes the
  // default branch's tree through `git pull`, not through the write routes or
  // the commit pipeline, so it emits neither event. That left approving a
  // proposed skill with a hole the reviewer sees: the change request closes, so
  // the skill drops off the pending shelf at once, while the released catalog
  // keeps serving the pre-merge scan for the rest of its TTL — the card the
  // reviewer just approved vanishes from the library entirely and comes back
  // only when the TTL runs out. `change-request-merged` is emitted after the
  // post-merge pull of the target workspace, so by the time this runs the file
  // is on disk, and `onEmit` runs before the SSE fan-out, so the browser that
  // is told to reload cannot beat the invalidation. The event carries no
  // branch, so a merge to a non-default base drops the caches too — one
  // needless re-scan, on the same reasoning as Subscriber B.
  const offEmit = eventBus.onEmit((event) => {
    if (event.kind === 'change-request-merged') {
      invalidateAll();
      return;
    }
    if (event.kind !== 'fs-tree-changed') return;
    if (!('branch' in event) || event.branch !== DEFAULT_BRANCH) return;
    invalidateAll();
  });

  return () => {
    offFiles();
    offEmit();
  };
}
