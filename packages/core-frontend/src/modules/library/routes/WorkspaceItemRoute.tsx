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

  const [, , group, ...tail] = segments;
  const last = tail[tail.length - 1];
  if (!group || !last) {
    return <Navigate to={LIBRARY_ROOT} replace />;
  }
  const repoRel = `${GROUPS_DIR}/${group}/${tail.join('/')}`;

  // A `.tool` is a tool page wherever it sits. The backend finds manuals at
  // ANY depth below `Groups/` (`walkFiles` over the whole tree), so a manual
  // filed inside a category folder is a real, listed tool — matching only at
  // the group's top level would list it and then 404 the click.
  if (last.toLowerCase().endsWith('.tool')) {
    const catalogSlug = data.items.find(
      (i) => i.kind === 'integration' && i.path === repoRel,
    )?.id;
    return <ToolPage slug={catalogSlug ?? last.slice(0, -'.tool'.length)} />;
  }

  // THE CATALOG IS THE AUTHORITY on which folder is a skill and what its id
  // is. Groups may nest (`Groups/Engineering/coding/create-ticket/SKILL.md`),
  // and a skill's id is its frontmatter `id`/`name` — only FALLING BACK to the
  // folder name — so neither the depth nor the id can be read off the URL with
  // certainty. Take the DEEPEST skill whose folder contains this path: a
  // category folder is never itself a skill, so the deepest match is the owner,
  // and a `SKILL.md` bundled inside a skill (`<skill>/examples/SKILL.md`)
  // stays that skill's file instead of inventing a skill called `examples`.
  const owner = deepestSkillOwning(data.items, repoRel);
  if (owner) {
    const file = repoRel.slice(owner.path.length + 1);
    return <SkillPage name={owner.id} activeFile={file || 'SKILL.md'} />;
  }

  // Not in the catalog. A `SKILL.md` still names its own skill structurally —
  // the folder holding it — and that is deliberately catalog-FREE: a skill
  // created a moment ago opens from its URL alone, before any reload lands.
  // (`Groups/<group>/SKILL.md` makes the group folder itself the skill, which
  // is what the backend's walk would report for it.)
  if (last === 'SKILL.md') {
    return <SkillPage name={tail.length >= 2 ? tail[tail.length - 2]! : group} activeFile="SKILL.md" />;
  }

  // Below here the URL is genuinely ambiguous — `<skill>/reference/x.md` and
  // `<category>/<skill>/x.md` are the same shape — and the catalog is the only
  // thing that can settle it. While it is still loading, WAIT: guessing sends
  // SkillPage to fetch a skill named after a category folder, which flashes a
  // not-found error and then corrects itself. The layout (and its sidebar) is
  // already on screen around this.
  if (data.loading) return null;

  // The catalog has spoken and no skill owns this file, so it is not a page:
  // a group's `access.md`, a category folder's own `access.md`, a stray
  // upload. That belongs to the group — at ANY depth, not just the group's
  // top level.
  if (/\.[a-z0-9]+$/i.test(last)) {
    return <Navigate to={pathForGroup(group)} replace />;
  }

  // A FOLDER the catalog doesn't know: most likely a skill whose reload hasn't
  // landed yet (the catalog can be settled but stale). Its own name is the id
  // — the same rule the backend applies when no frontmatter declares one.
  return <SkillPage name={last} activeFile="SKILL.md" />;
}

/**
 * The catalog skill whose folder contains `repoRel`, deepest first — the skill
 * a bundled file belongs to. Deepest wins because a category folder is never a
 * skill itself, so between `Groups/E/coding` and `Groups/E/coding/create-ticket`
 * only the latter can be a real entry; taking the shallower match would hand
 * the file to whichever skill sat nearest the group root.
 *
 * Compares on whole segments (`path + '/'`), never a bare `startsWith`: a
 * sibling named `create-ticket-v2` shares a prefix with `create-ticket` and
 * must not claim its files.
 */
function deepestSkillOwning(
  items: readonly { kind: string; id: string; path: string }[],
  repoRel: string,
): { id: string; path: string } | null {
  let best: { id: string; path: string } | null = null;
  for (const item of items) {
    if (item.kind !== 'skill') continue;
    if (repoRel !== item.path && !repoRel.startsWith(`${item.path}/`)) continue;
    if (!best || item.path.length > best.path.length) best = { id: item.id, path: item.path };
  }
  return best;
}

/** A malformed escape is a bad link, not a crash — fall back to the raw segment. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
