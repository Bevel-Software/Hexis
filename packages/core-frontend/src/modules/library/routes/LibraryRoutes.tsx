import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { LibraryToastProvider } from '../state/toast';
import { LibraryProvider, useLibrary } from '../state/library-data';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { LibraryLayout } from '../components/LibraryLayout';
import { LibraryPage } from '../components/LibraryPage';
import { GroupPage } from '../components/GroupPage';
import { GroupsIndexPage } from '../components/GroupsIndexPage';
import { PersonalGroupPage } from '../components/PersonalGroupPage';
import { WelcomePage } from '../../onboarding/components/WelcomePage';
import { decodeGroupSegment, LIBRARY_ROOT, urlForItemFile, urlForSkillFile } from './library-paths';

/**
 * The Skills & Tools surface — everything under `/skills-and-tools/*`.
 *
 * The shell mounts this once (`CORE_APPS`), so the toast host and the data
 * provider wrap the WHOLE surface rather than one page: navigating between the
 * gallery, a group and an item must not refetch the catalog or drop a toast
 * mid-flight.
 *
 * Paths below are RELATIVE — the shell already matched `/skills-and-tools/*`.
 *
 * URL is the single source of truth for selection. There is no filter state
 * anywhere in the Library: `LibraryLayout` derives what the sidebar shows from
 * the path, and a click navigates. That is what makes deep links, the back
 * button and the item pages' links all land on the same thing.
 */
export function LibraryRoutes() {
  return (
    <LibraryToastProvider>
      <LibraryProvider>
        <Routes>
          <Route element={<LibraryLayout />}>
            {/* The Library OPENS on its groups. A group is where skills and
                tools live and who they are for, so the index of them is the
                orienting view; the undifferentiated card grid is a lens on
                the same catalog and keeps its own row and URL below. */}
            <Route index element={<GroupsIndexPage />} />

            {/* The whole catalog as cards, with the library-wide search. */}
            <Route path="everything" element={<LibraryPage filter={{ kind: 'all' }} />} />

            {/* The connect-your-agent welcome — inside the layout, so the
                sidebar (and the pill's selected state) is on screen with it.
                Auto-reached once, on first sign-in (see `RootLanding`);
                reachable forever through the pill and by URL. */}
            <Route path="welcome" element={<WelcomePage />} />

            <Route path="owned" element={<LibraryPage filter={{ kind: 'owned' }} />} />

            {/* `yours` is a GROUP page, not a gallery filter — the items in no
                folder, given the same page the folders get. The sidebar still
                lights it through the `ungrouped` filter, so the URL and the
                selection stay the pair they were. */}
            <Route path="yours" element={<PersonalGroupPage />} />

            {/* A group is a PLACE: `groups/:group` is a real page with a real
                URL, and `GroupPage` — not the router — decides whether the
                caller gets the member view or the locked one. */}
            {/* The index moved to the root. This path is where every older
                link points, so it redirects rather than 404s or duplicates
                the page at a second URL. */}
            <Route path="groups" element={<Navigate to={LIBRARY_ROOT} replace />} />
            <Route path="groups/:group" element={<GroupPage />} />

          </Route>

          {/* LEGACY item addresses. The canonical URL of a skill or tool is
              its workspace file URL (`urlForItemFile` — one URL system for
              humans and agents; `WorkspaceItemGate` renders the pages there).
              These name-based routes survive as redirects because links to
              them exist in the wild, the Secrets/Connect pages still build
              them by slug, and `tools/:slug` is the server-validated OAuth
              `returnTo` — the redirect carries the callback's `#…` fragment
              along. Outside the layout route: a redirect never paints a
              sidebar on its way through. */}
          <Route path="tools/:slug" element={<LegacyToolRedirect />} />
          <Route path="skills/:name" element={<LegacySkillRedirect />} />

          {/* An unknown subpath is a stale or mistyped link, not an error page —
              send it home. Outside the layout route so a redirect never paints
              a sidebar on its way through. */}
          <Route path="*" element={<Navigate to={LIBRARY_ROOT} replace />} />
        </Routes>
      </LibraryProvider>
    </LibraryToastProvider>
  );
}

/** `skills/:name` → the skill's canonical workspace URL (its SKILL.md). */
function LegacySkillRedirect() {
  const { name = '' } = useParams<{ name: string }>();
  const data = useLibrary();
  const { kbDirName } = useWorkspace();
  const decoded = decodeGroupSegment(name);
  const skill = data.items.find((i) => i.kind === 'skill' && i.id === decoded);
  if (skill && kbDirName) return <Navigate to={urlForSkillFile(kbDirName, skill.path)} replace />;
  if (kbDirName === null) return null;
  if (data.loading) return null;
  return <Navigate to={LIBRARY_ROOT} replace />;
}

/**
 * `tools/:slug` → the manual's canonical workspace URL. The `#…` fragment is
 * carried along explicitly — this route is the OAuth callback's landing
 * target, and the fragment is the outcome it came back with.
 */
function LegacyToolRedirect() {
  const { slug = '' } = useParams<{ slug: string }>();
  const location = useLocation();
  const data = useLibrary();
  const { kbDirName } = useWorkspace();
  const decoded = decodeGroupSegment(slug);
  const tool = data.items.find((i) => i.kind === 'integration' && i.id === decoded);
  if (kbDirName === null) return null;
  if (tool) {
    return (
      <Navigate to={{ pathname: urlForItemFile(kbDirName, tool.path), hash: location.hash }} replace />
    );
  }
  if (data.loading) return null;
  return <Navigate to={LIBRARY_ROOT} replace />;
}
