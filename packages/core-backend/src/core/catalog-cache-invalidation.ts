import { DEFAULT_BRANCH, PLUGINS_DIR, SKILLS_DIR } from '@bevel-software/platform-shared';
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
    // Skills, tools, the plugin index and the link index all read `Plugins/`
    // or `Skills/`, so one touch check drives every cache. An access grant
    // lands as a default-branch change to `Plugins/<plugin>/access.md` or a
    // skill folder's `access.md`, so this is also what makes a newly-granted
    // plugin or link unlock within one round-trip instead of one TTL. Both
    // names are live bindings (a deployment may rename the roots), hence read
    // per event rather than captured.
    if (
      paths.some(
        (p) => p.startsWith(`${kbDirName}/${PLUGINS_DIR}/`) || p.startsWith(`${kbDirName}/${SKILLS_DIR}/`),
      )
    ) {
      invalidateAll();
    }
  });

  // Subscriber B — the DEFAULT branch's tree changed under the catalogs.
  //
  // `fs-tree-changed` is emitted the moment bytes hit a working tree: by the
  // workspace routes when someone writes a file, and by `pullWorkspace` when a
  // pull rewrites the default workspace — a merge landing an approved skill,
  // the non-fast-forward recovery ladder, a plain sync from the remote. That
  // is deliberately ONE signal rather than one per occasion: the catalogs do
  // not care which path rewrote the tree, only that it is no longer the tree
  // they scanned. Enumerating the occasions instead (a subscriber for merges,
  // another for recoveries) left every path nobody had thought of yet serving
  // a stale catalog for a full TTL — which is exactly how the merge case got
  // missed.
  //
  // `git-sync-recovered` is the same fact arriving by the other road: a
  // workspace that had diverged from origin has been reconciled, so its tree
  // moved. The pull inside that recovery announces itself, but the recovery
  // can also complete by paths that do not run one, and a catalog left holding
  // a scan of the diverged tree is the failure this exists to prevent.
  const offEmit = eventBus.onEmit((event) => {
    if (event.kind !== 'fs-tree-changed' && event.kind !== 'git-sync-recovered') return;
    // Both events declare `branch`, so no `in` guard: the kind check above has
    // already narrowed the union to the two that carry one.
    if (event.branch !== DEFAULT_BRANCH) return;
    invalidateAll();
  });

  return () => {
    offFiles();
    offEmit();
  };
}
