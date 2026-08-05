import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  listToolSecrets,
  type ToolSecrets,
} from '../../secrets-vault/services/tool-secrets.api';
import { getSkill, listSkills, type LibrarySkillSummary } from '../services/library.api';
import { getToolDetail, type ToolManualDetail } from '../services/tools.api';
import { neededToolsFor } from '../utils/status';

/**
 * Everything one tool page needs, from three independent loads with three
 * different failure postures:
 *
 *  - `GET /api/secrets/tools` is the SPINE. It decides whether the page exists
 *    at all (a tool the caller can't read is simply absent from the response —
 *    fail-closed, and indistinguishable from a typo'd slug on purpose), so its
 *    failure is the only one that becomes `error`.
 *  - `GET /api/tools/:slug` is DECORATION — description + capabilities. It
 *    degrades to `null` on any failure, which is what lets the page ship
 *    against a backend that doesn't serve it yet.
 *  - the skill catalog is the reverse index. It degrades to `[]`, and
 *    `skillsLoaded` exists so the page can tell "no skills use this" from "we
 *    don't know yet" — an empty degraded result must never render as an
 *    empty-state claim.
 *
 * Requests are ordered by a monotonic ref rather than cancelled: a reload while
 * the first round is in flight must not let the earlier answer overwrite the
 * later one, and `slug` can change under the hook when a link inside the page
 * points at another tool.
 */
export interface ToolPageState {
  /** Until `listToolSecrets` settles. */
  loading: boolean;
  /** ONLY a `listToolSecrets` failure — the two degraded loads never set it. */
  error: string | null;
  /** Settled, and no accessible tool carries this slug. */
  notFound: boolean;
  tool: ToolSecrets | null;
  /** `null` while loading AND on any failure — the page renders without it. */
  detail: ToolManualDetail | null;
  skillsLoaded: boolean;
  /** Skills whose `allowed-tools` reach this tool. */
  poweredSkills: LibrarySkillSummary[];
  reload(): void;
}

interface SpineState {
  loading: boolean;
  error: string | null;
  notFound: boolean;
  tool: ToolSecrets | null;
}

const LOADING: SpineState = { loading: true, error: null, notFound: false, tool: null };

export function useToolPage(slug: string): ToolPageState {
  const [spine, setSpine] = useState<SpineState>(LOADING);
  const [detail, setDetail] = useState<ToolManualDetail | null>(null);
  const [skills, setSkills] = useState<LibrarySkillSummary[]>([]);
  const [allowedToolsBySkill, setAllowedToolsBySkill] = useState<Map<string, string[]>>(
    () => new Map(),
  );
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const requestRef = useRef(0);

  // Switching tools (or reloading) has to clear the PREVIOUS tool's spine and
  // detail, or the page paints stale content under the new slug's heading. That
  // reset is state derived from a changed input, so it happens during render
  // against the previous key rather than in the effect body — an effect resets
  // after paint, which is both a frame of the old tool showing through and the
  // synchronous setState that `react-hooks/set-state-in-effect` flags.
  // `useState(key)` seeds the key so a fresh mount, already holding LOADING,
  // does not reset itself on the first render.
  const key = `${slug}:${revision}`;
  const [seenKey, setSeenKey] = useState(key);
  if (key !== seenKey) {
    setSeenKey(key);
    setSpine(LOADING);
    setDetail(null);
    setSkillsLoaded(false);
  }

  useEffect(() => {
    const request = ++requestRef.current;
    const current = () => requestRef.current === request;

    listToolSecrets()
      .then((tools) => {
        if (!current()) return;
        const tool = tools.find((t) => t.slug === slug) ?? null;
        setSpine({ loading: false, error: null, notFound: tool === null, tool });
      })
      .catch((err: unknown) => {
        if (!current()) return;
        setSpine({
          loading: false,
          error: err instanceof Error ? err.message : "Couldn't load this tool.",
          notFound: false,
          tool: null,
        });
      });

    getToolDetail(slug)
      .then((d) => {
        if (current()) setDetail(d);
      })
      .catch(() => {
        // Degraded, not broken: no lede and no capabilities section.
      });

    listSkills()
      .then((list) =>
        // One `getSkill` per skill because `allowed-tools` frontmatter has no
        // bulk endpoint. A single skill failing costs that skill's entry, not
        // the index.
        Promise.all(
          list.map((s) =>
            getSkill(s.name)
              .then((d): [string, string[]] => [s.name, d.allowedTools ?? []])
              .catch((): [string, string[]] => [s.name, []]),
          ),
        ).then((entries) => ({ list, entries })),
      )
      .catch(() => ({ list: [] as LibrarySkillSummary[], entries: [] as [string, string[]][] }))
      .then(({ list, entries }) => {
        if (!current()) return;
        setSkills(list);
        setAllowedToolsBySkill(new Map(entries));
        setSkillsLoaded(true);
      });
  }, [slug, revision]);

  const poweredSkills = useMemo(() => {
    const tool = spine.tool;
    if (!tool) return [];
    return skills.filter(
      (s) => neededToolsFor({ allowedTools: allowedToolsBySkill.get(s.name) }, [tool]).length > 0,
    );
  }, [skills, allowedToolsBySkill, spine.tool]);

  const reload = useCallback(() => setRevision((r) => r + 1), []);

  return { ...spine, detail, skillsLoaded, poweredSkills, reload };
}
