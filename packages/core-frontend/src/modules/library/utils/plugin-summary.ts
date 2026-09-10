import { isPersonalPluginFolder, pluginOfPath } from '@bevel-software/platform-shared';
import type { PluginPrincipals, PluginSummary } from '../services/plugins.api';

/**
 * The plugin a repository path sits in, by IDENTITY: the summary whose
 * folder holds the path (deepest wins, so a nested plugin beats the scope
 * around it). Before the summaries have loaded — or for a path under a
 * folder the catalog does not list — the folder name stands in, which is
 * what every plugin was called before the manifest became the identity. A
 * personal folder is a place, not a plugin: null.
 */
export function pluginNameForPath(
  repoPath: string,
  summaries: readonly Pick<PluginSummary, 'name' | 'folders'>[],
): string | null {
  const folder = pluginOfPath(repoPath);
  if (folder === null) return null;
  // The catalog is the authority: whatever folder it lists as holding the
  // path names the plugin. Only a path no listed folder holds falls back to
  // the folder name — and a personal shelf, which the catalog never lists,
  // to null.
  const held = pluginHoldingPath(repoPath, summaries);
  if (held) return held.name;
  return isPersonalPluginFolder(folder) ? null : folder;
}

/**
 * The listed plugin whose folder holds `repoPath` — the folder itself or
 * anything beneath it, deepest first, so a nested plugin beats the scope
 * around it. Whole segments only: a sibling folder sharing a prefix never
 * claims the path. Null when no listed plugin holds it (a path outside
 * every plugin, or inside one the catalog does not list for this caller).
 * The one place the rule lives, for every surface that asks which plugin
 * a path is in.
 */
export function pluginHoldingPath<S extends Pick<PluginSummary, 'folders'>>(
  repoPath: string,
  summaries: readonly S[],
): S | null {
  let best: { plugin: S; depth: number } | null = null;
  for (const plugin of summaries) {
    for (const folder of plugin.folders) {
      if (repoPath !== folder && !repoPath.startsWith(`${folder}/`)) continue;
      if (!best || folder.length > best.depth) best = { plugin, depth: folder.length };
    }
  }
  return best?.plugin ?? null;
}

/** What a plugin is called on screen — its display name, else its identity. */
export function pluginLabel(name: string, summaries: readonly Pick<PluginSummary, 'name' | 'displayName'>[]): string {
  return summaries.find((s) => s.name === name)?.displayName || name;
}

/**
 * How a plugin describes its membership in prose.
 *
 * Membership is displayed as ACCESS-RULE PRINCIPALS — the roles and people
 * `access.md` names — and never as a head-count of who can read the folder.
 * Three reasons, all load-bearing:
 *
 *  1. Expanding a role to its people needs the roster endpoint, which is
 *     admin-gated. A per-person list would render for admins and vanish for
 *     everyone else, so the same plugin would describe itself differently
 *     depending on who asked.
 *  2. Resolution is closeness-first with per-file overrides, so "who can read
 *     this folder" is not well-defined AT folder granularity. A person list
 *     would be false precision.
 *  3. These are the stored truth, and they are what `ManageAccessDialog` shows
 *     the moment a writer opens it — the two surfaces can never disagree.
 *
 * Consequence, accepted and permanent: no "{n} people" anywhere in the Library.
 */

/** Names as written, users before roles — the order the run-by line reads in. */
function usersThenRoles(p: PluginPrincipals): string[] {
  return [...p.users.map((u) => u.name), ...p.roles].filter((s) => s.length > 0);
}

/** Roles before people — the order a share list reads in. */
function rolesThenUsers(p: PluginPrincipals): string[] {
  return [...p.roles, ...p.users.map((u) => u.name)].filter((s) => s.length > 0);
}

/**
 * Who runs the plugin: owners, falling back to writers, falling back to the
 * admins.
 *
 * The writer fallback is not a guess — owner ⊂ writer, and "who runs it" is
 * really "who can change it". The final fallback is a fact rather than a
 * placeholder: admin-rescue guarantees a platform Admin can always write an
 * `access.md`, so a plugin with no named principals genuinely is run by them.
 */
export function ownersTextOf(summary: Pick<PluginSummary, 'owners' | 'writers'>): string {
  const owners = usersThenRoles(summary.owners);
  if (owners.length > 0) return owners.join(', ');
  const writers = usersThenRoles(summary.writers);
  if (writers.length > 0) return writers.join(', ');
  return 'the workspace admins';
}

/**
 * Who the plugin is shared with, or `null` when there is nothing honest to say
 * — either the reader list was withheld (the caller cannot read the plugin, and
 * a locked plugin never advertises its share list) or it resolved empty.
 * Callers drop the whole `· shared with …` clause on null rather than printing
 * a dangling half-sentence.
 */
export function readersTextOf(summary: Pick<PluginSummary, 'readers'>): string | null {
  const readers = summary.readers;
  if (!readers) return null;
  if (!readers.restricted) return 'everyone here';
  const named = rolesThenUsers(readers);
  return named.length > 0 ? named.join(', ') : null;
}

/** The folder a plugin's writes and links point at — its single `Plugins/<G>` folder. */
export function primaryFolderOf(summary: Pick<PluginSummary, 'folders'>): string | null {
  return summary.folders[0] ?? null;
}
