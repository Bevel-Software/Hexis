import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { groupOfPath } from '@bevel-software/platform-shared';
import { useLibraryData, type LibraryData } from '../hooks/useLibraryData';
import { listGroups, type GroupSummary } from '../services/groups.api';
import {
  neededToolsFor,
  skillStatus,
  toolStatus,
  type AttentionStatus,
} from '../utils/status';

/**
 * The Library's data host.
 *
 * Everything under `/skills-and-tools/*` — the gallery, the group pages, the
 * all-groups index — reads the SAME catalog, so it is fetched once here rather
 * than once per page. That matters more than it looks: `useLibraryData` pays an
 * N+1 `getSkill` to read `allowed-tools` frontmatter, and mounting it per route
 * would re-pay it on every navigation.
 *
 * Two independent loads live side by side:
 *  - the catalog (`useLibraryData`), whose failure IS surfaced (the gallery
 *    shows a banner — an empty library is indistinguishable from a broken one);
 *  - the group index (`GET /api/groups`), whose failure degrades to `[]` and is
 *    reported through `groupsError` for the surfaces that want to say so.
 */

/** One card in the gallery — a skill or an integration, already status-derived. */
export interface LibraryItem {
  kind: 'skill' | 'integration';
  id: string;
  name: string;
  description: string;
  owned: boolean;
  status: AttentionStatus;
  /** Folder group from the KB path, or null when the item is in none. */
  group: string | null;
  /** Repo-root-relative path — the skill's folder, or the `.tool` file. */
  path: string;
}

export interface LibraryContextValue extends LibraryData {
  items: LibraryItem[];
  /** `[]` until loaded, and on error. */
  groupSummaries: GroupSummary[];
  groupsLoading: boolean;
  groupsError: string | null;
  reloadGroups(): void;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

export function LibraryProvider({ children }: { children: ReactNode }) {
  const data = useLibraryData();
  const [groupSummaries, setGroupSummaries] = useState<GroupSummary[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(true);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [groupsRevision, setGroupsRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    listGroups()
      .then((groups) => {
        if (cancelled) return;
        setGroupSummaries(groups);
        setGroupsError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Keep whatever we had: a transient failure on a manual reload should
        // not blank a list the user is looking at.
        setGroupsError(err instanceof Error ? err.message : "Couldn't load groups.");
      })
      .finally(() => {
        if (!cancelled) setGroupsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupsRevision]);

  const items: LibraryItem[] = useMemo(() => {
    const skillItems: LibraryItem[] = data.skills.map((s) => ({
      kind: 'skill',
      id: s.name,
      name: s.name,
      description: s.description,
      owned: data.ownedSkills.has(s.name),
      group: groupOfPath(s.path),
      path: s.path,
      status: skillStatus(
        neededToolsFor({ allowedTools: data.allowedToolsBySkill.get(s.name) }, data.tools),
      ),
    }));
    const toolItems: LibraryItem[] = data.tools.map((t) => ({
      kind: 'integration',
      id: t.slug,
      name: t.name,
      // The browser tool surface exposes no human description for a `.tool`
      // manual yet (see report) — the card stays clean; detail lives behind it.
      description: '',
      owned: t.canWrite,
      group: groupOfPath(t.path),
      path: t.path,
      status: toolStatus(t),
    }));
    return [...skillItems, ...toolItems];
  }, [data.skills, data.tools, data.ownedSkills, data.allowedToolsBySkill]);

  // The loading flag is raised HERE rather than in the effect: `useState(true)`
  // already covers the first load, and flipping it from the event that asked
  // for the refetch keeps the effect body free of synchronous setState (which
  // costs a cascading render on every revision).
  const reloadGroups = useCallback(() => {
    setGroupsLoading(true);
    setGroupsRevision((r) => r + 1);
  }, []);

  const value = useMemo(
    (): LibraryContextValue => ({
      ...data,
      items,
      groupSummaries,
      groupsLoading,
      groupsError,
      reloadGroups,
    }),
    [data, items, groupSummaries, groupsLoading, groupsError, reloadGroups],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('useLibrary must be used inside a LibraryProvider');
  return value;
}

/**
 * How many of a group's integrations need setup — the amber count on the
 * sidebar row and the group page's banner, computed from one place so the two
 * can never disagree.
 *
 * Only integrations count. A skill that reports `warn` is warning about the
 * very integration already counted here, so counting both would double every
 * broken connection; pending change requests are a review concern, not a setup
 * one, and belong to a different surface.
 */
export function attentionOf(items: LibraryItem[], group: string): number {
  return items.filter(
    (i) => i.group === group && i.kind === 'integration' && i.status.state !== 'ok',
  ).length;
}
