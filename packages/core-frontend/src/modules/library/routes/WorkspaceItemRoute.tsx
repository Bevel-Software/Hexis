import { Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { DEFAULT_BRANCH, PLUGINS_DIR, SKILLS_DIR } from '@bevel-software/platform-shared';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { useLibrary } from '../state/library-data';
import { SkillPage } from '../components/skill-page/SkillPage';
import { ToolPage } from '../components/tool-page/ToolPage';
import { LIBRARY_ROOT, pathForPlugin } from './library-paths';

/**
 * The library page behind a canonical workspace URL —
 * `/workspace/<default>/<kbDir>/Plugins/<plugin>/<...>` or
 * `/workspace/<default>/<kbDir>/Skills/<...>` — rendered INSIDE the same
 * `LibraryLayout` route tree as every other library page, so the sidebar is
 * the one the reader already had and nothing remounts on the way in.
 *
 * Resolution is STRUCTURAL, not a catalog lookup: under `Plugins/<plugin>/`, a
 * `*.tool` file is a tool page, the plugin's `mcp.json` is a tool page too
 * (which of its servers is named by `?server=`, or by the catalog when the file
 * declares only one), any other direct FILE (an extension, no segments below
 * it — `access.md`) belongs to the plugin page, and everything else is a skill
 * FOLDER whose name is the skill's id — the same identity the old name-based
 * route used. That is what makes a skill created a moment ago
 * open instantly: its URL says everything the page needs, and `SkillPage`
 * fetches the skill by name itself. Waiting on the catalog here raced every
 * reload and lost (the just-created skill bounced to its plugin's page).
 *
 * The catalog is consulted only to REFINE a tool's slug (a `.tool` may
 * declare an explicit id different from its filename); the filename is the
 * fallback, which is also the default the backend derives.
 */
export function WorkspaceItemRoute() {
  const params = useParams<{ branch: string; '*': string }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const splat = params['*'] ?? '';
  const branch = safeDecode(params.branch ?? '');
  const { kbDirName } = useWorkspace();
  const data = useLibrary();

  // Shape re-validation: the route pattern (`:branch/*`) is broader than the
  // shape the shell dispatches here, and a stray URL must not read as a page.
  const segments = splat.split('/').filter(Boolean).map(safeDecode);
  const kbRoot = segments[1];
  if (branch !== DEFAULT_BRANCH || (kbRoot !== PLUGINS_DIR && kbRoot !== SKILLS_DIR) || segments.length < 3) {
    return <Navigate to={LIBRARY_ROOT} replace />;
  }
  if (kbDirName !== null && segments[0] !== kbDirName) {
    return <Navigate to={LIBRARY_ROOT} replace />;
  }

  /**
   * `key={name}` is load-bearing. A provisional name gets CORRECTED once the
   * catalog lands (folder name → declared id), and without a remount the page
   * would render once with the new name still holding the old name's failed
   * detail state — the "doesn't exist" flash, one frame before the corrected
   * request even starts. Remounting discards it.
   */
  const skillPage = (name: string, activeFile: string, provisional: boolean) => (
    <SkillPage key={name} name={name} activeFile={activeFile} provisional={provisional} />
  );

  // The shared-skills root holds skills and the scope folders that own them,
  // nothing else with a page: no plugin, no tools. The same evidence rules as
  // below, with the two plugin destinations replaced — a SCOPE folder has no
  // page of its own (the sidebar's tree is where it is browsed), and a file
  // filed directly in a scope (its access.md, a stray note) opens as the plain
  // file it is, in the pane workspace.
  if (kbRoot === SKILLS_DIR) {
    const rest = segments.slice(2);
    const last = rest[rest.length - 1]!;
    const repoRel = `${SKILLS_DIR}/${rest.join('/')}`;
    const owner = deepestSkillOwning(data.items, repoRel);
    if (owner) {
      const file = repoRel.slice(owner.path.length + 1);
      return skillPage(owner.id, file || 'SKILL.md', false);
    }
    if (last === 'SKILL.md' && rest.length >= 2) {
      return skillPage(rest[rest.length - 2]!, 'SKILL.md', true);
    }
    if (!hasExtension(last) && containsCatalogSkill(data.items, repoRel)) {
      return <Navigate to={LIBRARY_ROOT} replace />;
    }
    const parentRel = repoRel.slice(0, repoRel.length - last.length - 1);
    if (hasExtension(last) && (rest.length === 1 || containsCatalogSkill(data.items, parentRel))) {
      // Router STATE, not a different URL: the shell reads `rawFile` to step
      // past the shape rule into the pane workspace, and a shared link can
      // never carry state — so nobody lands on the raw view by accident.
      // Once asked, hold still: the shell is swapping surfaces on that state,
      // and asking again from here would be a navigation loop.
      const rawRequested = (location.state as { rawFile?: boolean } | null)?.rawFile === true;
      if (rawRequested) return null;
      return <Navigate to={`${location.pathname}${location.search}`} state={{ rawFile: true }} replace />;
    }
    if (data.loading) return null;
    return hasExtension(last)
      ? skillPage(rest[rest.length - 2]!, last, true)
      : skillPage(last, 'SKILL.md', true);
  }

  const [, , plugin, ...tail] = segments;
  const last = tail[tail.length - 1];
  if (!plugin || !last) {
    return <Navigate to={LIBRARY_ROOT} replace />;
  }
  const repoRel = `${PLUGINS_DIR}/${plugin}/${tail.join('/')}`;

  // A `.tool` is a tool page wherever it sits. The backend finds manuals at
  // ANY depth below `Plugins/` (`walkFiles` over the whole tree), so a manual
  // filed inside a category folder is a real, listed tool — matching only at
  // the plugin's top level would list it and then 404 the click.
  if (last.toLowerCase().endsWith('.tool')) {
    const catalogSlug = data.items.find(
      (i) => i.kind === 'integration' && i.path === repoRel,
    )?.id;
    return <ToolPage slug={catalogSlug ?? last.slice(0, -'.tool'.length)} />;
  }

  // A plugin's `mcp.json` declares tools too — SEVERAL per file, so the file
  // URL alone cannot name a page and `?server=<slug>` disambiguates (a QUERY
  // param, never the hash: the `#…` fragment on tool URLs is the OAuth
  // callback's outcome channel — see `urlForMcpServer`). Before this branch
  // existed, the file fell through to the direct-file rule below and every
  // mcp-declared tool card bounced straight back to its plugin page.
  //
  // Only the plugin's DIRECT child qualifies (`tail.length === 1`): the
  // backend's discovery reads exactly `Plugins/<plugin>/mcp.json`, so an
  // `mcp.json` nested deeper is a skill's bundled file — an example, a
  // template — and must render as that skill's file, not as a tool page.
  if (last === 'mcp.json' && tail.length === 1) {
    const fromParam = searchParams.get('server');
    // A named server renders directly — ToolPage's own not-found handles a bad
    // slug once the secrets listing settles, exactly as it does for a typo.
    if (fromParam) return <ToolPage slug={fromParam} />;
    const declared = data.items.filter((i) => i.kind === 'integration' && i.path === repoRel);
    if (declared.length === 1) return <ToolPage slug={declared[0]!.id} />;
    // Several servers and nothing naming one: the bare URL is ambiguous and
    // has no page — its plugin does. With NONE known, wait for the catalog
    // (same wait-don't-guess posture as below) before drawing that inference.
    if (declared.length === 0 && data.loading) return null;
    return <Navigate to={pathForPlugin(plugin)} replace />;
  }

  // THE CATALOG IS THE AUTHORITY on which folder is a skill and what its id
  // is. Plugins may nest (`Plugins/Engineering/coding/create-ticket/SKILL.md`),
  // and a skill's id is its frontmatter `id`/`name` — only FALLING BACK to the
  // folder name — so neither the depth nor the id can be read off the URL with
  // certainty. Take the DEEPEST skill whose folder contains this path: a
  // category folder is never itself a skill, so the deepest match is the owner,
  // and a `SKILL.md` bundled inside a skill (`<skill>/examples/SKILL.md`)
  // stays that skill's file instead of inventing a skill called `examples`.
  const owner = deepestSkillOwning(data.items, repoRel);
  if (owner) {
    const file = repoRel.slice(owner.path.length + 1);
    return skillPage(owner.id, file || 'SKILL.md', false);
  }

  // Not in the catalog. A `SKILL.md` still names its own skill structurally —
  // the folder holding it — and that is deliberately catalog-FREE: a skill
  // created a moment ago opens from its URL alone, before any reload lands.
  // (`Plugins/<plugin>/SKILL.md` makes the plugin folder itself the skill, which
  // is what the backend's walk would report for it.)
  if (last === 'SKILL.md') {
    return skillPage(tail.length >= 2 ? tail[tail.length - 2]! : plugin, 'SKILL.md', true);
  }

  // Everything below is decided on POSITIVE evidence only. What the catalog
  // KNOWS is trustworthy whenever it is there — cached entries survive a
  // failed refresh — but what it does NOT know proves nothing: it may be
  // loading, stale (a skill created seconds ago), or have failed outright.
  // Reading absence as "this is not a page" is what bounced valid deep links
  // to the plugin, so this no longer draws that inference at all.

  // A folder with catalog skills UNDER it is a category, not a skill. That is
  // the discriminator between a category folder and a just-created skill whose
  // reload hasn't landed: the former has known descendants, the latter has
  // none. A category has no page of its own; its plugin does.
  if (!hasExtension(last) && containsCatalogSkill(data.items, repoRel)) {
    return <Navigate to={pathForPlugin(plugin)} replace />;
  }

  // A FILE is the plugin's business when it cannot be a skill's file: either it
  // sits directly in the plugin folder (structurally never inside a skill), or
  // its own folder is a known category. `access.md` at either level, a stray
  // upload. A file under an UNKNOWN folder is left alone — that folder is most
  // likely a skill the catalog hasn't caught up with.
  const parentRel = repoRel.slice(0, repoRel.length - last.length - 1);
  if (hasExtension(last) && (tail.length === 1 || containsCatalogSkill(data.items, parentRel))) {
    return <Navigate to={pathForPlugin(plugin)} replace />;
  }

  // Nothing positive settled it. While the catalog is still loading, WAIT: the
  // evidence above may be one render away, and guessing flashes a page for a
  // name that is about to change. The layout and its sidebar are already on
  // screen around this.
  if (data.loading) return null;

  // Read the URL structurally — a file belongs to the folder holding it, a
  // bare folder names itself, the same rule the backend applies when no
  // frontmatter declares an id. Provisional: the catalog never confirmed it,
  // so SkillPage must not turn a failed lookup into "doesn't exist" until the
  // catalog has actually answered.
  return hasExtension(last)
    ? skillPage(tail.length >= 2 ? tail[tail.length - 2]! : plugin, last, true)
    : skillPage(last, 'SKILL.md', true);
}

/** Whether a path segment names a file rather than a folder. */
function hasExtension(segment: string): boolean {
  return /\.[a-z0-9]+$/i.test(segment);
}

/**
 * Whether the catalog knows any skill BELOW this path — i.e. whether it is a
 * container. Only meaningful once the catalog has actually loaded.
 */
function containsCatalogSkill(
  items: readonly { kind: string; path: string }[],
  repoRel: string,
): boolean {
  return items.some((i) => i.kind === 'skill' && i.path.startsWith(`${repoRel}/`));
}

/**
 * The catalog skill whose folder contains `repoRel`, deepest first — the skill
 * a bundled file belongs to. Deepest wins because a category folder is never a
 * skill itself, so between `Plugins/E/coding` and `Plugins/E/coding/create-ticket`
 * only the latter can be a real entry; taking the shallower match would hand
 * the file to whichever skill sat nearest the plugin root.
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
