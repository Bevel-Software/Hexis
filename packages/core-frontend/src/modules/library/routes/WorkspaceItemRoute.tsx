import { Navigate, useParams } from 'react-router-dom';
import { DEFAULT_BRANCH, GROUPS_DIR, groupOfPath } from '@bevel-software/platform-shared';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useLibrary, type LibraryItem } from '../state/library-data';
import { SkillPage } from '../components/skill-page/SkillPage';
import { ToolPage } from '../components/tool-page/ToolPage';
import { LIBRARY_ROOT, pathForGroup } from './library-paths';

/**
 * The library page behind a canonical workspace URL —
 * `/workspace/<default>/<kbDir>/Groups/<group>/<...>` — rendered INSIDE the
 * same `LibraryLayout` route tree as every other library page, so the sidebar
 * is the one the reader already had and nothing remounts on the way in.
 *
 * Which URLs reach here is decided by SHAPE (`isLibraryLocation`), so the
 * catalog is only consulted for WHICH page, never for which surface: while it
 * loads, a quiet placeholder holds the slot — a skill created a moment ago
 * resolves as soon as the reload lands, instead of falling through to the
 * Knowledge view because the catalog hadn't heard of it yet.
 *
 * A Groups path that resolves to no item once the catalog HAS answered (a
 * group's `access.md`, a loose file, a deleted skill) lands on its group's
 * page — the place that file belongs to.
 */
export function WorkspaceItemRoute() {
  const params = useParams<{ branch: string; '*': string }>();
  const splat = params['*'] ?? '';
  const branch = safeDecode(params.branch ?? '');
  const { kbDirName } = useWorkspace();
  const data = useLibrary();

  // Shape re-validation: the route pattern (`:branch/*`) is broader than the
  // shape the shell dispatches here, and a stray URL must not read as a page.
  const segments = splat.split('/').filter(Boolean).map(safeDecode);
  if (branch !== DEFAULT_BRANCH || segments[1] !== GROUPS_DIR || segments.length < 3) {
    return <Navigate to={LIBRARY_ROOT} replace />;
  }
  if (kbDirName !== null && segments[0] !== kbDirName) {
    return <Navigate to={LIBRARY_ROOT} replace />;
  }
  const repoRel = segments.slice(1).join('/');

  const target = classify(data.items, repoRel);
  if (target?.kind === 'skill') {
    return <SkillPage name={target.name} activeFile={target.file} />;
  }
  if (target?.kind === 'tool') {
    return <ToolPage slug={target.slug} />;
  }
  if (data.loading || kbDirName === null) {
    // The layout (and its sidebar) is already on screen — only the page slot
    // waits for the catalog.
    return <p className="py-10 text-center text-detail text-ink-faint">Loading…</p>;
  }
  const group = groupOfPath(repoRel);
  return <Navigate to={group ? pathForGroup(group) : LIBRARY_ROOT} replace />;
}

type ItemTarget =
  | { kind: 'skill'; name: string; file: string }
  | { kind: 'tool'; slug: string };

/** Longest-match resolution of a repo path to a catalog item. */
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
