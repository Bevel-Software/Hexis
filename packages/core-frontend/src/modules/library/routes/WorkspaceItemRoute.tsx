import { Navigate, useParams } from 'react-router-dom';
import { DEFAULT_BRANCH, GROUPS_DIR } from '@bevel-software/platform-shared';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useLibrary } from '../state/library-data';
import { SkillPage } from '../components/skill-page/SkillPage';
import { ToolPage } from '../components/tool-page/ToolPage';
import { LIBRARY_ROOT, pathForGroup } from './library-paths';

/**
 * The library page behind a canonical workspace URL —
 * `/workspace/<default>/<kbDir>/Groups/<group>/<...>` — rendered INSIDE the
 * same `LibraryLayout` route tree as every other library page, so the sidebar
 * is the one the reader already had and nothing remounts on the way in.
 *
 * Resolution is STRUCTURAL, not a catalog lookup: under `Groups/<group>/`, a
 * `*.tool` file is a tool page, any other direct FILE (an extension, no
 * segments below it — `access.md`) belongs to the group page, and everything
 * else is a skill FOLDER whose name is the skill's id — the same identity the
 * old name-based route used. That is what makes a skill created a moment ago
 * open instantly: its URL says everything the page needs, and `SkillPage`
 * fetches the skill by name itself. Waiting on the catalog here raced every
 * reload and lost (the just-created skill bounced to its group's page).
 *
 * The catalog is consulted only to REFINE a tool's slug (a `.tool` may
 * declare an explicit id different from its filename); the filename is the
 * fallback, which is also the default the backend derives.
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

  const [, , group, entry, ...rest] = segments;
  if (!group || !entry) {
    return <Navigate to={LIBRARY_ROOT} replace />;
  }

  if (rest.length === 0 && entry.toLowerCase().endsWith('.tool')) {
    const repoRel = `${GROUPS_DIR}/${group}/${entry}`;
    const catalogSlug = data.items.find(
      (i) => i.kind === 'integration' && i.path === repoRel,
    )?.id;
    return <ToolPage slug={catalogSlug ?? entry.slice(0, -'.tool'.length)} />;
  }

  // A direct FILE in the group folder (`access.md`, a stray upload) is the
  // group's business, not a page of its own.
  if (rest.length === 0 && /\.[a-z0-9]+$/i.test(entry)) {
    return <Navigate to={pathForGroup(group)} replace />;
  }

  return <SkillPage name={entry} activeFile={rest.join('/') || 'SKILL.md'} />;
}

/** A malformed escape is a bad link, not a crash — fall back to the raw segment. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
