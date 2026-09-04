import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode,  } from 'react';
import { LibraryContext } from './library-context';
import { pluginOfPath, isPersonalPluginFolder, SKILLS_DIR } from '@bevel-software/platform-shared';

/**
 * The plugin a card files under — with personal folders mapped to `null`, the
 * "yours alone" bucket. A personal folder (`Plugins/personal-<id>/`) is where
 * a person's own skills live; it is a place, not a plugin, and the only
 * personal items a caller can ever read are their own (the folder's seeded
 * access.md names nobody else), so `null` here always means "yours".
 */
function displayPluginOf(path: string): string | null {
  const plugin = pluginOfPath(path);
  return plugin !== null && isPersonalPluginFolder(plugin) ? null : plugin;
}

/** Under the shared `Skills/` root — owned by a scope, not by a person or a plugin folder. */
function isSharedPath(path: string): boolean {
  return path === SKILLS_DIR || path.startsWith(`${SKILLS_DIR}/`);
}
import { useLibraryData, type LibraryData } from '../hooks/useLibraryData';
import { listPlugins, type PluginSummary } from '../services/plugins.api';
import {
  neededToolsFor,
  skillStatus,
  toolStatus,
  type AttentionStatus,
} from '../utils/status';

/**
 * The Library's data host.
 *
 * Everything under `/skills-and-tools/*` — the gallery, the plugin pages, the
 * all-plugins index — reads the SAME catalog, so it is fetched once here rather
 * than once per page. That matters more than it looks: `useLibraryData` pays an
 * N+1 `getSkill` to read `allowed-tools` frontmatter, and mounting it per route
 * would re-pay it on every navigation.
 *
 * Two independent loads live side by side:
 *  - the catalog (`useLibraryData`), whose failure IS surfaced (the gallery
 *    shows a banner — an empty library is indistinguishable from a broken one);
 *  - the plugin index (`GET /api/plugins`), whose failure degrades to `[]` and is
 *    reported through `pluginsError` for the surfaces that want to say so.
 */

/** One card in the gallery — a skill or an integration, already status-derived. */
export interface LibraryItem {
  kind: 'skill' | 'integration';
  id: string;
  name: string;
  description: string;
  owned: boolean;
  status: AttentionStatus;
  /** Folder plugin from the KB path, or null when the item is in none. */
  plugin: string | null;
  /** Under the shared `Skills/` root — see `LibraryFilterable.shared`. */
  shared?: boolean;
  /** Repo-root-relative path — the skill's folder, or the `.tool` file. */
  path: string;
  /**
   * A skill's declared `version:` frontmatter. Undefined for integrations, and
   * for the many skills that declare none — the field is optional all the way
   * down from `SKILL.md`, so absence is the normal case, not a load failure.
   */
  version?: string;
  /**
   * Set only on a skill that does not exist yet — it lives on an open change
   * request's branch and is waiting on somebody to approve it.
   *
   * Deliberately NOT folded into `status`: `AttentionStatus` answers "is
   * anything standing in this item's way?", which drives the setup filter and
   * the amber counts, and a skill under review is not a broken skill. Callers
   * that must treat a proposal differently — the card, the click — read this.
   */
  pending?: {
    changeRequestNumber: number;
    branch: string;
    authorName: string;
    /** True when the reader proposed it themselves. */
    mine: boolean;
  };
}

export interface LibraryContextValue extends LibraryData {
  items: LibraryItem[];
  /** `[]` until loaded, and on error. */
  pluginSummaries: PluginSummary[];
  pluginsLoading: boolean;
  pluginsError: string | null;
  reloadPlugins(): void;
}


export function LibraryProvider({ children }: { children: ReactNode }) {
  const data = useLibraryData();
  const [pluginSummaries, setPluginSummaries] = useState<PluginSummary[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(true);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [pluginsRevision, setPluginsRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listPlugins()
      .then((plugins) => {
        if (cancelled) return;
        setPluginSummaries(plugins);
        setPluginsError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Keep whatever we had: a transient failure on a manual reload should
        // not blank a list the user is looking at.
        setPluginsError(err instanceof Error ? err.message : "Couldn't load plugins.");
      })
      .finally(() => {
        if (!cancelled) setPluginsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pluginsRevision]);

  const items: LibraryItem[] = useMemo(() => {
    const skillItems: LibraryItem[] = data.skills.map((s) => ({
      kind: 'skill',
      id: s.name,
      name: s.name,
      description: s.description,
      owned: data.ownedSkills.has(s.name),
      plugin: displayPluginOf(s.path),
      shared: isSharedPath(s.path),
      path: s.path,
      version: s.version,
      status: skillStatus(
        neededToolsFor({ allowedTools: data.allowedToolsBySkill.get(s.name) }, data.tools),
      ),
    }));
    /**
     * Proposed skills, alongside the released ones rather than in a pile of
     * their own. The question "is this skill available?" is asked in the same
     * place as "does this plugin have one?", and a separate shelf answers the
     * second while hiding the first — which is exactly the failure this fixes:
     * a skill an agent proposed was nowhere at all until it merged.
     *
     * `status` is the neutral `ok`: a proposal has no integrations resolved
     * against it, and reporting `warn` would put it in the setup filter and the
     * plugin's amber count as though something were broken.
     */
    const pendingItems: LibraryItem[] = data.pendingSkills.map((s) => ({
      kind: 'skill',
      id: s.name,
      name: s.name,
      description: s.description,
      owned: false,
      plugin: displayPluginOf(s.path),
      shared: isSharedPath(s.path),
      path: s.path,
      version: s.version,
      status: { state: 'ok', text: 'In review' },
      pending: {
        changeRequestNumber: s.changeRequestNumber,
        branch: s.branch,
        authorName: s.authorName,
        mine: s.isAuthor,
      },
    }));
    const toolItems: LibraryItem[] = data.tools.map((t) => ({
      kind: 'integration',
      id: t.slug,
      name: t.name,
      // The browser tool surface exposes no human description for a `.tool`
      // manual yet (see report) — the card stays clean; detail lives behind it.
      description: '',
      owned: t.canWrite,
      plugin: displayPluginOf(t.path),
      path: t.path,
      status: toolStatus(t),
    }));
    return [...skillItems, ...pendingItems, ...toolItems];
  }, [
    data.skills,
    data.pendingSkills,
    data.tools,
    data.ownedSkills,
    data.allowedToolsBySkill,
  ]);

  // The loading flag is raised HERE rather than in the effect: `useState(true)`
  // already covers the first load, and flipping it from the event that asked
  // for the refetch keeps the effect body free of synchronous setState (which
  // costs a cascading render on every revision).
  const reloadPlugins = useCallback(() => {
    setPluginsLoading(true);
    setPluginsRevision((r) => r + 1);
  }, []);

  const value = useMemo(
    (): LibraryContextValue => ({
      ...data,
      items,
      pluginSummaries,
      pluginsLoading,
      pluginsError,
      reloadPlugins,
    }),
    [data, items, pluginSummaries, pluginsLoading, pluginsError, reloadPlugins],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('useLibrary must be used inside a LibraryProvider');
  return value;
}

/**
 * "This workspace holds no plugins at all" — settled, and from both witnesses.
 *
 * One predicate for every surface that offers to create the FIRST plugin (the
 * nav's spelled-out row, the index's CTA), so the two cannot drift into
 * disagreeing about whether a workspace is untouched. Deliberately false while
 * either source is still loading or has failed: an unanswered question is not
 * "no plugins", and a first-plugin doorway shown on a guess points somebody at
 * a decision that may already be taken.
 */
export function workspaceHasNoPlugins(lib: LibraryContextValue): boolean {
  return (
    !lib.loading &&
    !lib.pluginsLoading &&
    !lib.error &&
    !lib.pluginsError &&
    lib.pluginSummaries.length === 0 &&
    lib.items.every((item) => item.plugin === null)
  );
}

/**
 * How many of a plugin's integrations need setup — the amber count on the
 * sidebar row and the plugin page's banner, computed from one place so the two
 * can never disagree.
 *
 * Only integrations count. A skill that reports `warn` is warning about the
 * very integration already counted here, so counting both would double every
 * broken connection; pending change requests are a review concern, not a setup
 * one, and belong to a different surface.
 */
export function attentionOf(items: LibraryItem[], plugin: string): number {
  return items.filter(
    (i) => i.plugin === plugin && i.kind === 'integration' && i.status.state !== 'ok',
  ).length;
}
