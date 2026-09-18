import { useCallback, useEffect, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/platform-shared';
import { fetchFileAccessBatch } from '../../access/api';
import { listToolSecrets, type ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import { listPendingTools, type PendingToolSummary } from '../services/tools.api';
import {
  defaultWorkspaceId,
  getSkill,
  listPendingSkills,
  listSkills,
  type LibrarySkillSummary,
  type PendingSkillSummary,
} from '../services/library.api';
import {
  listMyChangeRequests,
  listOpenChangeRequests,
} from '../../change-requests/services/change-requests.api';

/**
 * All the list-level data the Library gallery needs, loaded in parallel:
 *
 *  - skills      — `GET /api/skills` (default-branch catalog, canRead-filtered)
 *  - tools       — `GET /api/secrets/tools` (variables + per-user config status
 *                  + per-tool `canWrite`)
 *  - ownership   — "owned by me" = named in an `owner:` grant (directly or by
 *                  role) on the skill's `SKILL.md` or the tool's `.tool` file:
 *                  ONE `POST /workspace/:id/access/batch` with `verb: owner`
 *                  on the default-branch workspace, skills and tools together
 *                  (one more per 500 paths past the endpoint's cap).
 *                  Write alone is not ownership — an Admin writes everywhere.
 *  - write       — the skills' `SKILL.md` write verdict, the same batch without
 *                  a verb; it drives the editor-side affordances, which a
 *                  writer keeps whether or not they own. Tools reuse the
 *                  `canWrite` the secrets route already computes
 *  - change requests — all open + the caller's own, for the review layer
 *  - pending skills — `GET /api/skills/pending`, the skills that exist only on
 *                  an open change request's branch (author + approvers only)
 *  - pending tools — `GET /api/tools/pending`, the same for a `.tool` manual or
 *                  an `mcp.json` server proposed on an open change request
 *
 * Non-critical failures degrade to empty sets rather than blocking the page —
 * only the skills+tools pair failing surfaces as a load error.
 */
export interface LibraryData {
  loading: boolean;
  error: string | null;
  skills: LibrarySkillSummary[];
  /**
   * Proposed skills, not yet released. Kept SEPARATE from `skills` all the way
   * up to the gallery: everything downstream of `skills` treats an entry as a
   * thing that exists and can be opened, and a proposal is neither.
   */
  pendingSkills: PendingSkillSummary[];
  tools: ToolSecrets[];
  /**
   * Proposed tools, not yet released. Kept SEPARATE from `tools` for exactly
   * the reason `pendingSkills` is kept out of `skills`: everything downstream
   * of `tools` treats an entry as an integration that exists — it has a page, a
   * connection state, secrets to fill in — and a proposal has none of that.
   */
  pendingTools: PendingToolSummary[];
  /** Skill names (folder ids) whose SKILL.md names the caller in an `owner:` grant. */
  ownedSkills: Set<string>;
  /** Skill names (folder ids) whose SKILL.md the caller can write. */
  writableSkills: Set<string>;
  /** Tool slugs whose `.tool` file names the caller in an `owner:` grant. */
  ownedTools: Set<string>;
  /**
   * Per-skill `allowed-tools` frontmatter (name → entries), used to derive
   * which integrations a skill needs. Loaded via one `getSkill` per catalog
   * entry — the browser skill surface has no bulk endpoint for frontmatter.
   */
  allowedToolsBySkill: Map<string, string[]>;
  /** Open change requests, all authors. */
  crs: PullRequestSummary[];
  /** Numbers of the caller's own change requests. */
  myCrNumbers: Set<number>;
  reload(): void;
}

export function useLibraryData(): LibraryData {
  const [state, setState] = useState<Omit<LibraryData, 'reload'>>({
    loading: true,
    error: null,
    skills: [],
    pendingSkills: [],
    pendingTools: [],
    tools: [],
    ownedSkills: new Set(),
    writableSkills: new Set(),
    ownedTools: new Set(),
    allowedToolsBySkill: new Map(),
    crs: [],
    myCrNumbers: new Set(),
  });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));

    (async () => {
      const [skills, tools] = await Promise.all([listSkills(), listToolSecrets()]);

      const skillProbes = skills.map((s) => `${s.path}/SKILL.md`);
      const ownerProbes = [...skillProbes, ...tools.map((t) => t.path)];
      // The batch endpoint refuses more than 500 paths per request, so a large
      // catalog goes out in slices of that size and the verdicts are merged.
      // A failed slice is "no verdicts" for its paths: nothing pilled, nothing
      // unlocked — and the other slices still stand. Slices go one after
      // another, so a large catalog costs more round trips, never a burst: at
      // most one request per verb is in flight. A load that was superseded
      // (unmount, reload) stops sending slices; its verdicts are discarded.
      const BATCH_LIMIT = 500;
      const verdicts = async (paths: string[], verb: 'write' | 'owner') => {
        const results: Record<string, boolean> = {};
        for (let i = 0; i < paths.length && !cancelled; i += BATCH_LIMIT) {
          const part = await fetchFileAccessBatch(
            defaultWorkspaceId(),
            paths.slice(i, i + BATCH_LIMIT),
            verb,
          ).catch(() => ({ results: {} as Record<string, boolean> }));
          Object.assign(results, part.results);
        }
        return { results };
      };

      const [writable, ownership, crs, mine, pending, pendingTools, details] = await Promise.all([
        verdicts(skillProbes, 'write'),
        verdicts(ownerProbes, 'owner'),
        listOpenChangeRequests().catch(() => [] as PullRequestSummary[]),
        listMyChangeRequests().catch(() => [] as PullRequestSummary[]),
        listPendingSkills().catch(() => [] as PendingSkillSummary[]),
        listPendingTools().catch(() => [] as PendingToolSummary[]),
        Promise.all(
          skills.map(
            (s): Promise<[string, string[]]> =>
              getSkill(s.name)
                .then((d): [string, string[]] => [s.name, d.allowedTools ?? []])
                .catch((): [string, string[]] => [s.name, []]),
          ),
        ),
      ]);

      if (cancelled) return;
      // Fail closed: a path missing from the verdicts is a no.
      const skillsWhere = (results: Record<string, boolean>) =>
        new Set(skills.filter((s) => results[`${s.path}/SKILL.md`] === true).map((s) => s.name));
      setState({
        loading: false,
        error: null,
        skills,
        pendingSkills: pending,
        tools,
        pendingTools,
        ownedSkills: skillsWhere(ownership.results),
        writableSkills: skillsWhere(writable.results),
        ownedTools: new Set(tools.filter((t) => ownership.results[t.path] === true).map((t) => t.slug)),
        allowedToolsBySkill: new Map(details),
        crs: crs.filter((c) => c.state === 'open'),
        myCrNumbers: new Set(mine.map((c) => c.number)),
      });
    })().catch((err) => {
      if (cancelled) return;
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : "Couldn't load the library.",
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [revision]);

  const reload = useCallback(() => setRevision((r) => r + 1), []);

  return { ...state, reload };
}
