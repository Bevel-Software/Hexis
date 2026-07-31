import { useCallback, useEffect, useState } from 'react';
import type { PullRequestSummary } from '@bevel-software/shared';
import { fetchFileAccessBatch } from '../../access/api';
import { listToolSecrets, type ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';
import {
  DEFAULT_WORKSPACE_ID,
  getSkill,
  listMyChangeRequests,
  listOpenChangeRequests,
  listSkills,
  type LibrarySkillSummary,
} from '../services/library.api';

/**
 * All the list-level data the Library gallery needs, loaded in parallel:
 *
 *  - skills      — `GET /api/skills` (default-branch catalog, canRead-filtered)
 *  - tools       — `GET /api/secrets/tools` (variables + per-user config status
 *                  + per-tool `canWrite`)
 *  - ownership   — "owned by me" = write access on the skill's `SKILL.md`
 *                  (`POST /workspace/:id/access/batch` on the default-branch
 *                  workspace); tools reuse the `canWrite` the secrets route
 *                  already computes
 *  - change requests — all open + the caller's own, for the review layer
 *
 * Non-critical failures degrade to empty sets rather than blocking the page —
 * only the skills+tools pair failing surfaces as a load error.
 */
export interface LibraryData {
  loading: boolean;
  error: string | null;
  skills: LibrarySkillSummary[];
  tools: ToolSecrets[];
  /** Skill names (folder ids) whose SKILL.md the caller can write. */
  ownedSkills: Set<string>;
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
    tools: [],
    ownedSkills: new Set(),
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

      const [ownership, crs, mine, details] = await Promise.all([
        skills.length
          ? fetchFileAccessBatch(
              DEFAULT_WORKSPACE_ID,
              skills.map((s) => `${s.path}/SKILL.md`),
            ).catch(() => ({ results: {} as Record<string, boolean> }))
          : Promise.resolve({ results: {} as Record<string, boolean> }),
        listOpenChangeRequests().catch(() => [] as PullRequestSummary[]),
        listMyChangeRequests().catch(() => [] as PullRequestSummary[]),
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
      const ownedSkills = new Set(
        skills.filter((s) => ownership.results[`${s.path}/SKILL.md`] === true).map((s) => s.name),
      );
      setState({
        loading: false,
        error: null,
        skills,
        tools,
        ownedSkills,
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
