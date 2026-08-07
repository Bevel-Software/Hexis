import { useLayoutEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAdmin } from '../../admin/state/admin.context';
import { setSidebarCollapsed } from '../../layout/state/sidebar';
import { useLibrary } from '../../library/state/library-data';
import { CreatorWelcomePage } from './CreatorWelcomePage';
import { WelcomePage } from './WelcomePage';

/**
 * Chooses the first welcome without changing what the permanent reminder does.
 *
 * Only RootLanding sends `greeting: true`. A later visit from the Connect your
 * agent reminder has no greeting state and must always reach its existing
 * instructions, even when the admin has not created anything yet.
 */
export function WelcomeRoute() {
  const location = useLocation();
  const { isAdmin, isAdminLoading = false } = useAdmin();
  const data = useLibrary();
  const greeting = (location.state as { greeting?: boolean } | null)?.greeting === true;

  // Hold the sidebar out of the first painted frame while the admin and
  // library checks settle. Both welcome pages use the full reading column.
  useLayoutEffect(() => {
    if (greeting) setSidebarCollapsed(true, true);
  }, [greeting]);

  if (!greeting || (!isAdminLoading && !isAdmin)) return <WelcomePage />;

  if (isAdminLoading || data.loading || data.groupsLoading) {
    return <div className="py-16 text-center text-ui text-ink-faint">Preparing your library…</div>;
  }

  const libraryIsEmpty =
    !data.error &&
    !data.groupsError &&
    data.items.length === 0 &&
    data.groupSummaries.length === 0;

  return libraryIsEmpty ? <CreatorWelcomePage /> : <WelcomePage />;
}
