import { useContext, useEffect, useMemo, type ReactNode } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { DEFAULT_BRANCH, GROUPS_DIR } from '@bevel-software/platform-shared';
import { AppClaimContext } from '../../../core/registry';
import { KB_ROUTE_PREFIX } from '../../workspace/routing/kb-routes';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { LibraryToastProvider } from '../state/toast';
import { LibraryProvider, useLibrary, type LibraryItem } from '../state/library-data';
import { LibraryLayout } from '../components/LibraryLayout';
import { SkillPage } from '../components/skill-page/SkillPage';
import { ToolPage } from '../components/tool-page/ToolPage';

/**
 * The gate that makes a workspace URL the CANONICAL address of a library item.
 *
 * `/workspace/main/<kbDir>/Groups/<group>/<skill>/<file>` renders the SKILL
 * PAGE with that file's tab open, and `…/<manual>.tool` renders the TOOL page —
 * the same surfaces `/skills-and-tools` used to serve at name-based URLs. One
 * URL system for humans and agents: an agent can derive the address from the
 * repo path it already works with, the Knowledge tree's link to the same file
 * lands on the same page, and a skill file linking another skill's SKILL.md
 * navigates to that skill's page for free.
 *
 * The gate wraps the Knowledge app's element and steps aside for everything
 * that is not a library item:
 *
 *  - non-default branches (a draft under review shows the RAW file — the
 *    library pages only speak the default branch);
 *  - paths outside `Groups/` (knowledge documents — no catalog fetch, no
 *    flash: the shape alone decides);
 *  - `Groups/` paths that resolve to no catalog item (a group's `access.md`,
 *    a loose file) — these fall through to the raw view once the catalog
 *    answers.
 *
 * While an item page is on screen the gate CLAIMS the Skills & Tools app (see
 * {@link AppClaimContext}), so the toolbar's switcher highlights the app whose
 * surface the person is actually using, not the one that owns the URL prefix.
 */
export function WorkspaceItemGate({ knowledge }: { knowledge: ReactNode }) {
  const { kbDirName } = useWorkspace();
  const location = useLocation();
  const candidate = libraryCandidate(location.pathname, kbDirName);
  // The escape hatch for surfaces that need the RAW file behind an item URL
  // (the tool page's "Edit the tool file"): router STATE, never the URL. The
  // URL alone always means the item page — state is ephemeral, so a shared or
  // reloaded link cannot land on the raw view by accident.
  const rawRequested = (location.state as { rawFile?: boolean } | null)?.rawFile === true;
  // Not even a candidate → the knowledge surface, with no library providers
  // mounted: the common Knowledge path pays nothing for this feature.
  if (candidate === 'no' || rawRequested) return <>{knowledge}</>;
  // Shape says "maybe an item" but the workspace context (kbDirName) hasn't
  // resolved yet — hold blank rather than mounting a surface this URL is
  // about to swap out from under the reader.
  if (candidate === 'pending') return null;
  return (
    <LibraryToastProvider>
      <LibraryProvider>
        <CandidateSurface repoRel={candidate.repoRel} knowledge={knowledge} />
      </LibraryProvider>
    </LibraryToastProvider>
  );
}

/** What a candidate path resolved to, per the catalog. */
type ItemTarget =
  | { kind: 'skill'; name: string; file: string }
  | { kind: 'tool'; slug: string };

function CandidateSurface({ repoRel, knowledge }: { repoRel: string; knowledge: ReactNode }) {
  const data = useLibrary();
  const claim = useContext(AppClaimContext);
  const target = useMemo(() => classify(data.items, repoRel), [data.items, repoRel]);

  const found = target !== null;
  useEffect(() => {
    if (!found) return;
    claim('skills-tools');
    return () => claim(null);
  }, [found, claim]);

  if (target !== null) {
    // The same layout the /skills-and-tools routes mount, so the item page is
    // pixel-identical whichever address reached it. The nested route table
    // exists because LibraryLayout is a LAYOUT ROUTE (it renders an Outlet);
    // `*` matches whatever remains of the /workspace/* match.
    return (
      <Routes>
        <Route element={<LibraryLayout />}>
          <Route
            path="*"
            element={
              target.kind === 'skill' ? (
                <SkillPage name={target.name} activeFile={target.file} />
              ) : (
                <ToolPage slug={target.slug} />
              )
            }
          />
        </Route>
      </Routes>
    );
  }
  // Candidate shape, catalog still loading: hold blank for the round-trip
  // rather than flashing the raw file view under a URL that is about to be a
  // skill page (or vice versa).
  if (data.loading) return null;
  return <>{knowledge}</>;
}

/**
 * Whether this URL could name a library item: default branch, inside the KB
 * dir, under `Groups/`, at least `Groups/<group>/<x>` deep. `'no'` never
 * touches the catalog; `'pending'` is the same shape while `kbDirName` is
 * still unresolved (segment 2 can't be confirmed yet).
 */
function libraryCandidate(
  pathname: string,
  kbDirName: string | null,
): 'no' | 'pending' | { repoRel: string } {
  const segments = pathname.split('/').filter(Boolean).map(safeDecode);
  if (`/${segments[0]}` !== KB_ROUTE_PREFIX) return 'no';
  if (segments[1] !== DEFAULT_BRANCH) return 'no';
  if (segments[3] !== GROUPS_DIR) return 'no';
  if (segments.length < 6) return 'no'; // Groups/<group>/<item> at minimum
  if (kbDirName === null) return 'pending';
  if (segments[2] !== kbDirName) return 'no';
  return { repoRel: segments.slice(3).join('/') };
}

function classify(items: LibraryItem[], repoRel: string): ItemTarget | null {
  for (const item of items) {
    if (item.kind === 'integration' && item.path === repoRel) {
      return { kind: 'tool', slug: item.id };
    }
    if (item.kind === 'skill' && (repoRel === item.path || repoRel.startsWith(`${item.path}/`))) {
      return {
        kind: 'skill',
        name: item.id,
        file: repoRel === item.path ? 'SKILL.md' : repoRel.slice(item.path.length + 1),
      };
    }
  }
  return null;
}

/** A malformed escape is a bad link, not a crash — fall back to the raw segment. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
