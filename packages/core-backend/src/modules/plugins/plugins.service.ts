import path from 'node:path';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import {
  DEFAULT_BRANCH,
  PLUGINS_DIR,
  pluginOfPath,
  isPersonalPluginFolder,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../../shared/workspace-id.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { ISkillService } from '../skills/skills.contract.js';
import type { IToolManualService } from '../tool-manuals/tool-manuals.contract.js';
import { TtlCache } from '../../shared/ttl-cache.js';
import type { PluginCatalogEntry, IPluginIndexService } from './plugins.contract.js';
import type { PluginLinkIndex } from './plugin-links.js';

const CACHE_TTL_MS = 60_000;

/**
 * The plugin index: every plugin folder in the default-branch KB, with its
 * caller-independent totals and access principals.
 *
 * Two decisions worth keeping straight:
 *
 *  - **Existence is an `access.md`, counting is not.** A plugin EXISTS because
 *    its folder carries an `access.md` — the file the provisioning endpoint
 *    seeds and the one every per-caller verdict (member / manager /
 *    discoverable) resolves against. A bare directory under `Plugins/` is NOT
 *    a plugin: git cannot record an empty folder, so deleting a plugin's files
 *    leaves its directory behind on live checkouts, and enumerating by
 *    directory would resurrect every such ghost. Counts come from the
 *    already-cached global catalogs — `skillService.listSkills(undefined)` and
 *    `toolManualService.listAllSummaries()` — bucketed by `pluginOfPath`. A
 *    second `walkFiles` pass would re-read the same tree and could disagree
 *    with the catalogs about what counts as a skill.
 *  - **Loose files are not plugins.** `Plugins/slack.tool` sits directly under
 *    the root, so it is a file, not a directory — the same ≥3-segment rule
 *    `pluginOfPath` applies, arrived at from the other side.
 *
 * Cached for {@link CACHE_TTL_MS} and dropped by `invalidate()` from the
 * file-change subscriber, so a grant committed on the default branch is
 * reflected within one round-trip rather than one TTL.
 */
export class PluginIndexService implements IPluginIndexService {
  private readonly cache: TtlCache<PluginCatalogEntry[]>;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly skillService: ISkillService,
    private readonly toolManualService: IToolManualService,
    private readonly kbDirName: string,
    now: () => number = Date.now,
    /**
     * The link index, when the deployment has one: a plugin's skill count is
     * then inline PLUS linked. Optional so hosts composing their own service
     * set (and older tests) keep the inline-only count.
     */
    private readonly links?: PluginLinkIndex,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, now);
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  async catalog(): Promise<PluginCatalogEntry[]> {
    const cached = this.cache.get();
    if (cached) return cached;
    const entries = await this.build();
    // A failed scan and a KB with genuinely no plugin folders both serve `[]`,
    // but only the second is a fact worth holding for the TTL. Caching the
    // failure would hide every plugin from every user for the full 60s AFTER
    // the cause is gone — a clone mid-creation, a readdir that raced a
    // checkout — and `invalidate()` only fires on a file-change event that may
    // never arrive in that window. So a degraded read is served, not stored,
    // and the next caller retries.
    if (entries === null) return [];
    this.cache.set(entries);
    return entries;
  }

  // --- internal --------------------------------------------------------------

   /**
   * Degrades on ANY failure rather than throwing. The Library must never break
   * because a plugin folder can't be read — same philosophy as the skill and
   * tool-manual scanners, and the reason the route's 500 is reserved for the
   * per-caller half.
   *
   * `null` is that degraded case and is deliberately NOT the same value as an
   * empty array: a KB with no plugin folders returns `[]`, which is true and
   * cacheable, while a failure returns `null`, which `catalog()` serves as `[]`
   * without storing it.
   */
  private async build(): Promise<PluginCatalogEntry[] | null> {
    try {
      const wsId = (await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)).id;
      const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);

      const folders = await this.scanFolders(kbRoot);
      if (folders.size === 0) return [];

      const [skillCounts, toolCounts] = await Promise.all([
        this.countSkills(),
        this.countTools(),
      ]);

      const entries: PluginCatalogEntry[] = [];
      for (const [name, pluginFolders] of folders) {
        // One folder, one access boundary — the folder IS the plugin.
        const [primary] = pluginFolders;
        const [owners, writers, readers] = await Promise.all([
          this.accessControl.eligibleOwners(wsId, primary),
          this.accessControl.eligibleWriters(wsId, primary),
          this.accessControl.eligibleReaders(wsId, primary),
        ]);
        entries.push({
          name,
          folders: pluginFolders,
          skillCount: skillCounts.get(name) ?? 0,
          toolCount: toolCounts.get(name) ?? 0,
          owners,
          writers,
          readers,
        });
      }
      return entries.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.warn(
        `[plugins] plugin index unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** name → repo-relative plugin folder (always a single-element list). */
  private async scanFolders(kbRoot: string): Promise<Map<string, string[]>> {
    const byName = new Map<string, string[]>();
    let children: Dirent[];
    try {
      children = await fs.readdir(path.join(kbRoot, PLUGINS_DIR), { withFileTypes: true });
    } catch {
      return byName; // a KB without a `Plugins/` root simply has no plugins
    }
    const candidates = children.filter(
      (child) =>
        child.isDirectory() &&
        !child.name.startsWith('.') &&
        // Personal folders live under Plugins/ but are not plugins: one exists
        // per person, private by construction, and listing them would put a
        // locked row per employee in everyone's index.
        !isPersonalPluginFolder(child.name),
    );
    // A plugin exists exactly when its folder carries an `access.md` (see the
    // class doc) — stat that file, don't trust the directory.
    const verdicts = await Promise.all(
      candidates.map(async (child) => {
        try {
          return (await fs.stat(path.join(kbRoot, PLUGINS_DIR, child.name, 'access.md'))).isFile();
        } catch {
          return false;
        }
      }),
    );
    candidates.forEach((child, i) => {
      if (verdicts[i]) byName.set(child.name, [`${PLUGINS_DIR}/${child.name}`]);
    });
    return byName;
  }

  private async countSkills(): Promise<Map<string, number>> {
    // `undefined` is the documented GLOBAL, unfiltered mode — counts are a
    // property of the plugin, not of who is asking.
    if (!this.links) return bucketByPlugin(await this.skillService.listSkills(undefined));
    // With links, a skill counts for EVERY plugin that holds it — inline in
    // its folder, or linked from a manifest. Personal folders are already
    // absent from the membership (they are places, not plugins).
    const counts = new Map<string, number>();
    for (const memberships of (await this.links.membership()).bySkill.values()) {
      for (const m of memberships) counts.set(m.name, (counts.get(m.name) ?? 0) + 1);
    }
    return counts;
  }

  private async countTools(): Promise<Map<string, number>> {
    return bucketByPlugin(await this.toolManualService.listAllSummaries());
  }
}

/** Count items per plugin folder name; ungrouped items (`null`) count nowhere. */
function bucketByPlugin(items: { path: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const plugin = pluginOfPath(item.path);
    if (plugin === null) continue;
    counts.set(plugin, (counts.get(plugin) ?? 0) + 1);
  }
  return counts;
}

/** The default-branch workspace id every plugin resolution runs against. */
export function pluginsWorkspaceId(): string {
  return workspaceIdForBranch(DEFAULT_BRANCH);
}
