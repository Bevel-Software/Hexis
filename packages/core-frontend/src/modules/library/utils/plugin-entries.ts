import { attentionOf, type LibraryItem } from '../state/library-data';
import type { PluginSummary } from '../services/plugins.api';
import { pluginLabel } from './plugin-summary';
import type { LibraryFilter, TeamAccess } from './status';

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
  /** The caller is in it (or an item grant reaches inside). */
  member: boolean;
}

/**
 * The plugin rows a gallery filter shows.
 *
 *  - Everything: the caller's own space, then every plugin the index lists,
 *    members' and locked alike — locked ones are still places on the map.
 *  - Owned by me: the plugins the caller manages, own space first.
 *  - A team: the plugins the team can read, as the server named them.
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

  const names = new Set<string>(summaries.map((g) => g.name));
  for (const item of items) if (item.plugin) names.add(item.plugin);
  const team = filter.kind === 'team' ? teams.find((t) => t.name === filter.group) : undefined;

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
    const member = summary ? summary.canRead || summary.canWrite || hasItems : hasItems;
    if (filter.kind === 'owned' && !summary?.canWrite) continue;
    if (filter.kind === 'team' && !team?.plugins.includes(name)) continue;
    entries.push({
      name,
      label: pluginLabel(name, summaries),
      summary,
      skillCount: summary ? summary.skillCount : derivedSkills,
      toolCount: summary ? summary.toolCount : derivedTools,
      attention: attention.total,
      urgent: attention.brokenLinks > 0,
      member,
    });
  }
  return entries.filter((e) => matches(e.label));
}

/**
 * How many of a plugin's items the catalog holds, by FOLDER plugin. `null`
 * is the caller's own space: in no plugin folder and not a shared skill —
 * a shared skill is nobody's alone, however it is linked.
 */
export function countKind(
  items: readonly LibraryItem[],
  plugin: string | null,
  kind: LibraryItem['kind'],
): number {
  return items.filter((i) => i.plugin === plugin && i.kind === kind && (plugin !== null || !i.shared)).length;
}
