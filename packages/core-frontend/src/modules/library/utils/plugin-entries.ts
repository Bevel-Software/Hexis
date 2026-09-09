import { attentionOf, type LibraryItem } from '../state/library-data';
import type { PluginSummary } from '../services/plugins.api';
import { pluginLabel } from './plugin-summary';
import { filterLibraryItems, isInPlugin, pluginsOfItem, type LibraryFilter, type TeamAccess } from './status';

/**
 * One plugin row of a gallery page — the Library's plugin renderer takes
 * these (see `PluginRows`). Built from BOTH witnesses, as the all-plugins
 * index built its rows: the summaries (the server's list, with verdicts and
 * counts) and the catalog (an item whose path or link names a plugin the
 * summaries missed still proves the plugin is there).
 */
export interface PluginEntry {
  /** Identity — what the row navigates by. `null` for the caller's own space. */
  name: string | null;
  label: string;
  summary: PluginSummary | null;
  skillCount: number;
  toolCount: number;
  attention: number;
  urgent: boolean;
  /** The caller can READ it — the server says so, or an item of it is in their catalog. */
  member: boolean;
}

/**
 * The plugin rows a gallery filter shows.
 *
 *  - Everything: the caller's own space, then every plugin the index lists,
 *    members' and locked alike — locked ones are still places on the map.
 *  - Owned by me: the plugins the caller manages, own space first.
 *  - A team: the plugins the team can read, as the server named them; the
 *    counts on those rows are the TEAM's — how many of the plugin's skills
 *    and tools are in the team's slice — so a row never claims more than
 *    the cards beneath it show.
 *  - A plugin's own page and the personal page list items, not plugins.
 *
 * `query` matches the label, so a search narrows plugins with the cards.
 */
export function pluginEntriesFor(
  items: readonly LibraryItem[],
  summaries: readonly PluginSummary[],
  filter: LibraryFilter,
  teams: readonly TeamAccess[],
  query: string,
  personalLabel: string,
): PluginEntry[] {
  if (filter.kind === 'group' || filter.kind === 'ungrouped') return [];
  const q = query.trim().toLowerCase();
  const matches = (label: string) => !q || label.toLowerCase().includes(q);

  // Both witnesses: the index, and every plugin an item belongs to — by
  // folder or by link. A plugin the caller reaches only through a shared
  // skill it links has no folder item to name it, and must still be a row.
  const names = new Set<string>(summaries.map((g) => g.name));
  for (const item of items) for (const name of pluginsOfItem(item)) names.add(name);
  const team = filter.kind === 'team' ? teams.find((t) => t.name === filter.group) : undefined;
  const teamItems = filter.kind === 'team' ? filterLibraryItems(items, filter, '', teams) : null;

  const entries: PluginEntry[] = [];
  if (filter.kind !== 'team') {
    entries.push({
      name: null,
      label: personalLabel,
      summary: null,
      skillCount: countKind(items, null, 'skill'),
      toolCount: countKind(items, null, 'integration'),
      attention: 0,
      urgent: false,
      member: true,
    });
  }
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const summary = summaries.find((g) => g.name === name) ?? null;
    const derivedSkills = countKind(items, name, 'skill');
    const derivedTools = countKind(items, name, 'integration');
    const hasItems = derivedSkills + derivedTools > 0;
    const attention = attentionOf(items, name, summaries);
    // Membership is READ, never write: an admin rescued into a plugin's
    // rules can manage a folder they cannot open, and that row is locked.
    const member = summary ? summary.canRead || hasItems : hasItems;
    if (filter.kind === 'owned' && !summary?.canWrite) continue;
    if (filter.kind === 'team' && !team?.plugins.includes(name)) continue;
    entries.push({
      name,
      label: pluginLabel(name, summaries),
      summary,
      skillCount: teamItems ? countKind(teamItems, name, 'skill') : summary ? summary.skillCount : derivedSkills,
      toolCount: teamItems ? countKind(teamItems, name, 'integration') : summary ? summary.toolCount : derivedTools,
      attention: attention.total,
      urgent: attention.brokenLinks > 0,
      member,
    });
  }
  return entries.filter((e) => matches(e.label));
}

/**
 * How many of a plugin's items the catalog holds — by folder OR by link,
 * the way the plugin page lists them. `null` is the caller's own space: in
 * no plugin folder and not a shared skill — a shared skill is nobody's
 * alone, however it is linked.
 */
export function countKind(
  items: readonly LibraryItem[],
  plugin: string | null,
  kind: LibraryItem['kind'],
): number {
  return items.filter(
    (i) => i.kind === kind && (plugin === null ? i.plugin === null && !i.shared : isInPlugin(i, plugin)),
  ).length;
}
