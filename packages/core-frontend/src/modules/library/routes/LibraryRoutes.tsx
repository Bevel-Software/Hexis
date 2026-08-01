import { Navigate, Route, Routes } from 'react-router-dom';
import { LibraryToastProvider } from '../state/toast';
import { LibraryProvider } from '../state/library-data';
import { LibraryLayout } from '../components/LibraryLayout';
import { LibraryPage } from '../components/LibraryPage';
import { ToolPage } from '../components/tool-page/ToolPage';
import { LIBRARY_ROOT } from './library-paths';

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
            <Route index element={<LibraryPage filter={{ kind: 'all' }} />} />
            <Route path="owned" element={<LibraryPage filter={{ kind: 'owned' }} />} />
            <Route path="yours" element={<LibraryPage filter={{ kind: 'ungrouped' }} />} />

            {/* WP5 (group pages): `GroupsIndexPage`, `GroupPage` (member view;
                WP7 adds the locked branch) and `ProposeSkillPage` — the last of
                which is Ali's seam, its `?group=` query frozen by the plan.
                The ROUTES land now so the sidebar, the item pages and every
                deep link have somewhere real to point. */}
            <Route path="groups" element={<PageComingInALaterWorkPackage />} />
            <Route path="groups/:group" element={<PageComingInALaterWorkPackage />} />
            <Route path="propose" element={<PageComingInALaterWorkPackage />} />

            {/* The routed replacement for the dialog's tool half, and the
                landing target of the OAuth round-trip
                (`…/tools/:slug#authorized`). */}
            <Route path="tools/:slug" element={<ToolPage />} />

            {/* CONTRACT (Ali): the skill page mounts at `skills/:name`
                (`:name` = `encodeURIComponent(skill name)`), HERE, above the
                fallback. Insert the route; change nothing else. Until it
                exists that URL redirects to the gallery, which is harmless. */}
          </Route>

          {/* An unknown subpath is a stale or mistyped link, not an error page —
              send it to the gallery. Outside the layout route so a redirect
              never paints a sidebar on its way through. */}
          <Route path="*" element={<Navigate to={LIBRARY_ROOT} replace />} />
        </Routes>
      </LibraryProvider>
    </LibraryToastProvider>
  );
}

/**
 * Stands in for a page a later work package owns. Renders NOTHING on purpose:
 * the route resolving is the contract this package ships, and half a page is
 * worse than an empty one.
 */
function PageComingInALaterWorkPackage() {
  return null;
}
