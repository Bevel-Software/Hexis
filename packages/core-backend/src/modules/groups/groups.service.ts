import path from 'node:path';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import {
  DEFAULT_BRANCH,
  GROUPS_DIR,
  LEGACY_SKILLS_DIR,
  LEGACY_TOOLS_DIR,
  groupOfPath,
} from '@bevel-software/platform-shared';
import type { WorkspaceService } from '../workspace/workspace.service.js';
import { workspaceIdForBranch } from '../workspace/workspace.service.js';
import type { IAccessControl } from '../access/access-control.interface.js';
import type { ISkillService } from '../skills/skills.contract.js';
import type { IToolManualService } from '../tool-manuals/tool-manuals.contract.js';
import { TtlCache } from '../../shared/ttl-cache.js';
import type { GroupCatalogEntry, IGroupIndexService } from './groups.contract.js';

const CACHE_TTL_MS = 60_000;

/** The roots whose DIRECT subfolders are groups — merged layout first. */
const GROUP_SCAN_ROOTS = [GROUPS_DIR, LEGACY_SKILLS_DIR, LEGACY_TOOLS_DIR] as const;

/**
 * The group index: every group folder in the default-branch KB, with its
 * caller-independent totals and access principals.
 *
 * Two decisions worth keeping straight:
 *
 *  - **Enumeration is a readdir, counting is not.** A group EXISTS because a
 *    folder exists (`readdir` of the three roots, union by name), but its
 *    counts come from the already-cached global catalogs —
 *    `skillService.listSkills(undefined)` and
 *    `toolManualService.listAllSummaries()` — bucketed by `groupOfPath`. A
 *    second `walkFiles` pass would re-read the same tree and could disagree
 *    with the catalogs about what counts as a skill.
 *  - **Loose files are not groups.** `Tools/slack.tool` sits directly under a
 *    root, so it is a file, not a directory — the same ≥3-segment rule
 *    `groupOfPath` applies, arrived at from the other side.
 *
 * Cached for {@link CACHE_TTL_MS} and dropped by `invalidate()` from the
 * file-change subscriber, so a grant committed on the default branch is
 * reflected within one round-trip rather than one TTL.
 */
export class GroupIndexService implements IGroupIndexService {
  private readonly cache: TtlCache<GroupCatalogEntry[]>;

  constructor(
    private readonly workspaceService: WorkspaceService,
    private readonly accessControl: IAccessControl,
    private readonly skillService: ISkillService,
    private readonly toolManualService: IToolManualService,
    private readonly kbDirName: string,
    now: () => number = Date.now,
  ) {
    this.cache = new TtlCache(CACHE_TTL_MS, now);
  }

  invalidate(): void {
    this.cache.invalidate();
  }

  async catalog(): Promise<GroupCatalogEntry[]> {
    const cached = this.cache.get();
    if (cached) return cached;
    const entries = await this.build();
    // A failed scan and a KB with genuinely no group folders both serve `[]`,
    // but only the second is a fact worth holding for the TTL. Caching the
    // failure would hide every group from every user for the full 60s AFTER
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
   * because a group folder can't be read — same philosophy as the skill and
   * tool-manual scanners, and the reason the route's 500 is reserved for the
   * per-caller half.
   *
   * `null` is that degraded case and is deliberately NOT the same value as an
   * empty array: a KB with no group folders returns `[]`, which is true and
   * cacheable, while a failure returns `null`, which `catalog()` serves as `[]`
   * without storing it.
   */
  private async build(): Promise<GroupCatalogEntry[] | null> {
    try {
      const wsId = (await this.workspaceService.getOrCreateForBranch(DEFAULT_BRANCH)).id;
      const kbRoot = path.join(await this.workspaceService.getWorkspacePath(wsId), this.kbDirName);

      const folders = await this.scanFolders(kbRoot);
      if (folders.size === 0) return [];

      const [skillCounts, toolCounts] = await Promise.all([
        this.countSkills(),
        this.countTools(),
      ]);

      const entries: GroupCatalogEntry[] = [];
      for (const [name, groupFolders] of folders) {
        // The `Groups/`-rooted folder is the primary: post-migration it is the
        // only one, and pre-migration it is the one the migration keeps. The
        // principals of a group that spans `Skills/X` + `Tools/X` therefore
        // come from ONE folder — an approximation the migration collapses.
        const primary = groupFolders.find((f) => f.startsWith(`${GROUPS_DIR}/`)) ?? groupFolders[0];
        const [owners, writers, readers] = await Promise.all([
          this.accessControl.eligibleOwners(wsId, primary),
          this.accessControl.eligibleWriters(wsId, primary),
          this.accessControl.eligibleReaders(wsId, primary),
        ]);
        entries.push({
          name,
          folders: groupFolders,
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
        `[groups] group index unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** name → repo-relative constituent folders, in root order (`Groups/` first). */
  private async scanFolders(kbRoot: string): Promise<Map<string, string[]>> {
    const byName = new Map<string, string[]>();
    for (const root of GROUP_SCAN_ROOTS) {
      let children: Dirent[];
      try {
        children = await fs.readdir(path.join(kbRoot, root), { withFileTypes: true });
      } catch {
        continue; // a root the KB doesn't have (pre- or post-migration) is not an error
      }
      for (const child of children) {
        if (!child.isDirectory() || child.name.startsWith('.')) continue;
        const list = byName.get(child.name);
        if (list) list.push(`${root}/${child.name}`);
        else byName.set(child.name, [`${root}/${child.name}`]);
      }
    }
    return byName;
  }

  private async countSkills(): Promise<Map<string, number>> {
    // `undefined` is the documented GLOBAL, unfiltered mode — counts are a
    // property of the group, not of who is asking.
    return bucketByGroup(await this.skillService.listSkills(undefined));
  }

  private async countTools(): Promise<Map<string, number>> {
    return bucketByGroup(await this.toolManualService.listAllSummaries());
  }
}

/** Count items per group folder name; ungrouped items (`null`) count nowhere. */
function bucketByGroup(items: { path: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const group = groupOfPath(item.path);
    if (group === null) continue;
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  return counts;
}

/** The default-branch workspace id every group resolution runs against. */
export function groupsWorkspaceId(): string {
  return workspaceIdForBranch(DEFAULT_BRANCH);
}
