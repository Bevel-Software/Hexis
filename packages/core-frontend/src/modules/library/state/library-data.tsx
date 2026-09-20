import { PR_STALE_EVENT, TOOL_CREDENTIALS_STALE_EVENT } from '../../../core/events';
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode,  } from 'react';
import { LibraryContext } from './library-context';
import { SKILLS_DIR } from '@bevel-software/platform-shared';
import { pluginNameForPath, pluginsHoldingTool } from '../utils/plugin-summary';
import type { PluginMembership } from '../services/library.api';

/**
 * The plugin a card files under, by IDENTITY — the server's own answer for a
 * skill it decorated (the inline membership), else the folder resolved
 * through the plugin summaries (see `pluginNameForPath`). Personal folders
 * map to `null`, the "yours alone" bucket: a personal folder is a place, not
 * a plugin, and the only personal items a caller can ever read are their own.
 */
function pluginOfItem(
  path: string,
  memberships: readonly { name: string; linked: boolean }[] | undefined,
  summaries: readonly PluginSummary[],
): string | null {
  return memberships?.find((m) => !m.linked)?.name ?? pluginNameForPath(path, summaries);
}

/** Under the shared `Skills/` root — owned by a scope, not by a person or a plugin folder. */
function isSharedPath(path: string): boolean {
  return path === SKILLS_DIR || path.startsWith(`${SKILLS_DIR}/`);
}
import { useLibraryData, type LibraryData } from '../hooks/useLibraryData';
import { listPlugins, type PluginSummary } from '../services/plugins.api';
import { listTeams } from '../services/teams.api';
import {
  isInPlugin,
  neededToolsFor,
  skillStatus,
  toolStatus,
  type AttentionStatus,
  type TeamAccess,
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
  /**
   * The caller is named in the item's `owner:` grant, directly or through a
   * role — the Owner pill and "Owned by me". Write access is not ownership.
   */
  owned: boolean;
  /**
   * The caller may write the item — a skill's SKILL.md, a tool's `.tool`
   * file. What the editor-side affordances go by, owner or not.
   */
  canWrite: boolean;
  status: AttentionStatus;
  /** Folder plugin from the KB path, or null when the item is in none. */
  plugin: string | null;
  /** Under the shared `Skills/` root — see `LibraryFilterable.shared`. */
  shared?: boolean;
  /**
   * Every plugin holding the item, inline or linked. A skill's comes from the
   * server, which keeps the link index; a TOOL's is derived here from where
   * its file sits and which roots each plugin links (`pluginsHoldingTool`).
   */
  plugins?: PluginMembership[];
  /** Repo-root-relative path — the skill's folder, or the `.tool` file. */
  path: string;
  /**
   * A skill's declared `version:` frontmatter. Undefined for integrations, and
   * for the many skills that declare none — the field is optional all the way
   * down from `SKILL.md`, so absence is the normal case, not a load failure.
   */
  version?: string;
  /**
   * Set only on an item that does not exist yet — it lives on an open change
   * request's branch and is waiting on somebody to approve it. A skill's
   * `SKILL.md`, a tool's `.tool` manual or `mcp.json` server: the same flag,
   * because the reader's question ("can I use this yet?") and the card's
   * answer are the same for both.
   *
   * Deliberately NOT folded into `status`: `AttentionStatus` answers "is
   * anything standing in this item's way?", which drives the setup filter and
   * the amber counts, and an item under review is not a broken one. Callers
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
  /**
   * What each team can use (`GET /api/teams`), `[]` until loaded and on
   * error. Loaded and reloaded WITH the plugin summaries: both are answers
   * from the access rules, and an edit that changes one changes the other.
   */
  teams: TeamAccess[];
  teamsLoading: boolean;
  /**
   * Why `teams` is empty when it is: the request failed. Kept apart from
   * "no teams" so a team page can tell "this team is not there" from "we
   * could not ask" — the second is not the first.
   */
  teamsError: string | null;
  reloadPlugins(): void;
}


export function LibraryProvider({ children }: { children: ReactNode }) {
  const data = useLibraryData();
  const { reload } = data;
  const [pluginSummaries, setPluginSummaries] = useState<PluginSummary[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(true);
  const [pluginsError, setPluginsError] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamAccess[]>([]);
  const [teamsLoading, setTeamsLoading] = useState(true);
  const [teamsError, setTeamsError] = useState<string | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    // The team lens degrades to "no teams" rather than failing the Library:
    // the sidebar simply has no team rows, and Everything is untouched.
    // (`teamsLoading` is raised by `reloadPlugins`, as `pluginsLoading` is —
    // the first load starts raised, and the effect body stays free of a
    // synchronous setState.)
    listTeams()
      .then((next) => {
        if (cancelled) return;
        setTeams(next);
        setTeamsError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTeams([]);
        // A blank message is no message: the page tells the error state
        // apart from "no teams" by this being non-empty.
        setTeamsError((err instanceof Error && err.message) || "Couldn't load teams.");
      })
      .finally(() => {
        if (!cancelled) setTeamsLoading(false);
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
      canWrite: data.writableSkills.has(s.name),
      plugin: pluginOfItem(s.path, s.plugins, pluginSummaries),
      shared: isSharedPath(s.path),
      plugins: s.plugins ?? [],
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
      canWrite: false,
      plugin: pluginOfItem(s.path, undefined, pluginSummaries),
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
    const toolItems: LibraryItem[] = data.tools.map((t) => {
      // A tool's memberships are DERIVED, not served — the tool surface knows
      // where the file is, the summaries know which roots each plugin links,
      // and `pluginsHoldingTool` is the one place those two meet. With them a
      // tool under a linked root is on the plugin's page, pill and all, the
      // way a linked skill is.
      const plugins = pluginsHoldingTool(t.path, pluginSummaries);
      return {
        kind: 'integration',
        id: t.slug,
        name: t.name,
        // The browser tool surface exposes no human description for a `.tool`
        // manual yet (see report) — the card stays clean; detail lives behind it.
        description: '',
        owned: data.ownedTools.has(t.slug),
        canWrite: t.canWrite,
        plugin: pluginOfItem(t.path, plugins, pluginSummaries),
        plugins,
        path: t.path,
        status: toolStatus(t),
      };
    });
    /**
     * Proposed tools, beside the released ones exactly as proposed skills sit
     * beside released skills — and for the very same bug: a tool an agent
     * proposed was nowhere in the library at all until somebody merged it, so
     * the person who asked for it had no way to see that it was on its way.
     *
     * `owned`/`canWrite` are false and stay false: there is no file on the
     * default branch to own or to edit, and every affordance that reads them
     * would address a path that is not there. The plugin comes from the
     * declaration's own path, which is where the file will land.
     */
    const pendingToolItems: LibraryItem[] = data.pendingTools.map((t) => ({
      kind: 'integration',
      id: t.slug,
      name: t.name,
      // The released tool cards carry no description either — detail lives
      // behind the card — and a proposal has even less standing to differ.
      description: '',
      owned: false,
      canWrite: false,
      plugin: pluginOfItem(t.path, undefined, pluginSummaries),
      path: t.path,
      // The neutral `ok`, as for a proposed skill: a proposal has no
      // credential resolved against it, and reporting `warn` would put it in
      // the setup filter and the plugin's amber count as though an integration
      // somebody has to configure had appeared.
      status: { state: 'ok', text: 'In review' },
      pending: {
        changeRequestNumber: t.changeRequestNumber,
        branch: t.branch,
        authorName: t.authorName,
        mine: t.isAuthor,
      },
    }));
    return [...skillItems, ...pendingItems, ...toolItems, ...pendingToolItems];
  }, [
    data.skills,
    data.pendingSkills,
    data.tools,
    data.pendingTools,
    data.ownedSkills,
    data.writableSkills,
    data.ownedTools,
    data.allowedToolsBySkill,
    pluginSummaries,
  ]);

  // The loading flag is raised HERE rather than in the effect: `useState(true)`
  // already covers the first load, and flipping it from the event that asked
  // for the refetch keeps the effect body free of synchronous setState (which
  // costs a cascading render on every revision).
  const reloadPlugins = useCallback(() => {
    setPluginsLoading(true);
    setTeamsLoading(true);
    setPluginsRevision((r) => r + 1);
  }, []);

  // ONE reload for the whole Library. The plugin summaries carry counts and
  // verdicts derived from the same knowledge base as the catalog — how many
  // skills a plugin holds, how many of its links are broken, who may read
  // it — so a page that refreshes the catalog after a link, a repair or an
  // access edit must refresh the summaries too, or the sidebar count and the
  // plugin page's banner keep the number from before the change.
  const reloadAll = useCallback(() => {
    reload();
    reloadPlugins();
  }, [reload, reloadPlugins]);

  // The catalog carries its own view of open change requests (proposals,
  // review boxes). The shell's change-request provider refreshes on this
  // event; so does the whole Library, or the two would disagree after a
  // proposal lands or is resolved — and a merged change can move plugin
  // links and access, so the summaries refresh with the catalog here too.
  useEffect(() => {
    const onStale = () => reloadAll();
    window.addEventListener(PR_STALE_EVENT, onStale);
    return () => window.removeEventListener(PR_STALE_EVENT, onStale);
  }, [reloadAll]);

  // A credential landing anywhere in the app is a catalog change here: every
  // "needs setup" in the Library — the cards, the plugin page's banner, the
  // sidebar count — is derived from the tool rows this catalog carries, and
  // they were loaded before the save. The tool page re-probes itself, which is
  // why the bug only ever showed up one click LATER: on the page the reader
  // went back to.
  useEffect(() => {
    const onCredentials = () => reloadAll();
    window.addEventListener(TOOL_CREDENTIALS_STALE_EVENT, onCredentials);
    return () => window.removeEventListener(TOOL_CREDENTIALS_STALE_EVENT, onCredentials);
  }, [reloadAll]);

  const value = useMemo(
    (): LibraryContextValue => ({
      ...data,
      reload: reloadAll,
      items,
      pluginSummaries,
      pluginsLoading,
      pluginsError,
      teams,
      teamsLoading,
      teamsError,
      reloadPlugins,
    }),
    [data, reloadAll, items, pluginSummaries, pluginsLoading, pluginsError, teams, teamsLoading, teamsError, reloadPlugins],
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
 * How much of a plugin needs a person — the count on the sidebar row, the
 * index badge and the plugin page's banners, computed from one place so they
 * can never disagree. Two kinds, added together:
 *
 *  - integrations that need setup (`brokenLinksOf` subtracted from this
 *    gives that number alone);
 *  - linked skills the plugin's members cannot read (`brokenLinksOf`).
 *
 * A skill that reports `warn` about a tool is NOT counted: it is warning
 * about the very integration already counted here, so counting both would
 * double every broken connection. Pending change requests are a review
 * concern, not a setup one, and belong to a different surface.
 */
export interface PluginAttention {
  /** Everything that needs a person: integrations to set up, broken links, and what the definition left out. */
  total: number;
  /** The broken-link part alone — what turns the count orange. */
  brokenLinks: number;
  /** What the platform could not keep of the plugin's definition — a server, a skill root — as the server reports it. */
  warnings: number;
}

export function attentionOf(
  items: readonly LibraryItem[],
  plugin: string,
  summaries: readonly Pick<PluginSummary, 'name' | 'brokenLinks' | 'warnings'>[] = [],
): PluginAttention {
  // One pass for the links, returned beside the total: every caller wants
  // both, and computing the part again for the tone would filter the whole
  // catalog a second time per plugin.
  const brokenLinks = brokenLinksOf(items, plugin, summaries);
  // `!i.pending` is said out loud rather than left to the neutral `ok` a
  // proposal carries: this count drives the sidebar badge and the setup
  // filter, and "somebody has to configure this integration" is never true of
  // a tool that does not exist yet. A future status change on the proposal
  // side must not be able to leak into the amber count by accident.
  const integrations = items.filter(
    (i) => isInPlugin(i, plugin) && i.kind === 'integration' && !i.pending && i.status.state !== 'ok',
  ).length;
  // Amber, like an integration to set up: it needs a person who can edit
  // the plugin's files, and blocks nobody but the users of what is missing.
  const warnings = summaries.find((s) => s.name === plugin)?.warnings?.length ?? 0;
  return { total: integrations + brokenLinks + warnings, brokenLinks, warnings };
}

/**
 * How many of `plugin`'s LINKED skills its members cannot read: the link is
 * in the manifest but the skill folder no longer grants the plugin's readers.
 * Counted apart from the integrations because it is a different kind of
 * problem — a tool that needs setup blocks the reader's own use; a link
 * without its grant blocks every member of the plugin, right now — and the
 * sidebar and the plugin page rank it above amber for that reason.
 *
 * The SERVER's count wins when the summary carries one: it comes from the
 * unfiltered link index, so a manager whom the missing grant locks out of
 * the skill still sees it. The caller's own catalog is only the fallback for
 * an older server — it cannot list a skill the caller may not read, which is
 * exactly the skill this is about.
 */
export function brokenLinksOf(
  items: readonly LibraryItem[],
  plugin: string,
  summaries: readonly Pick<PluginSummary, 'name' | 'brokenLinks'>[] = [],
): number {
  const served = summaries.find((s) => s.name === plugin)?.brokenLinks;
  if (served !== undefined) return served;
  return items.filter(
    (i) => i.kind === 'skill' && (i.plugins ?? []).some((m) => m.name === plugin && m.linked && m.granted === false),
  ).length;
}
