import { Navigate, Route, Routes } from 'react-router-dom';
import { LibraryToastProvider } from '../state/toast';
import { LibraryProvider } from '../state/library-data';
import { LibraryLayout } from '../components/LibraryLayout';
import { LibraryPage } from '../components/LibraryPage';
import { GroupPage } from '../components/GroupPage';
import { GroupsIndexPage } from '../components/GroupsIndexPage';
import { PersonalGroupPage } from '../components/PersonalGroupPage';
import { ProposeSkillPage } from '../components/ProposeSkillPage';
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

            {/* `yours` is a GROUP page, not a gallery filter — the items in no
                folder, given the same page the folders get. The sidebar still
                lights it through the `ungrouped` filter, so the URL and the
                selection stay the pair they were. */}
            <Route path="yours" element={<PersonalGroupPage />} />

            {/* A group is a PLACE: `groups/:group` is a real page with a real
                URL, and `GroupPage` — not the router — decides whether the
                caller gets the member view or the locked one. `propose` is
                Ali's seam; its `?group=` query is frozen by the plan. */}
            <Route path="groups" element={<GroupsIndexPage />} />
            <Route path="groups/:group" element={<GroupPage />} />
            <Route path="propose" element={<ProposeSkillPage />} />

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
