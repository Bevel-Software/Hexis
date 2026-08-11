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
  const routeState = location.state as { greeting?: boolean; returnTo?: string | null } | null;
  const greeting = routeState?.greeting === true;
  /** A deep link that survived the SSO round-trip — see `RootLanding`. */
  const returnTo = greeting ? (routeState?.returnTo ?? null) : null;

  // Hold the sidebar out of the first painted frame while the admin and
  // library checks settle. Both welcome pages use the full reading column.
  useLayoutEffect(() => {
    if (greeting) setSidebarCollapsed(true, true);
  }, [greeting]);

  // A carried deep link outranks the creator welcome, admin or not: only
  // `WelcomePage` has the exit that honors `returnTo`, and a greeting that
  // concluded by discarding the page someone was sent would cost them the
  // reason they came. The library can be built after the link is kept.
  if (!greeting || returnTo || (!isAdminLoading && !isAdmin)) return <WelcomePage />;

  if (isAdminLoading || data.loading || data.groupsLoading) {
    // Two phases, two truths. While the ADMIN verdict is unknown the reader
    // may be headed for the agent welcome, where their library is beside the
    // point — so the hold says nothing about one. Once the verdict says
    // admin, the remaining wait really is their library loading.
    return (
      <div className="py-16 text-center text-ui text-ink-faint">
        {isAdminLoading ? 'One moment…' : 'Preparing your library…'}
      </div>
    );
  }

  const libraryIsEmpty =
    !data.error &&
    !data.groupsError &&
    data.items.length === 0 &&
    data.groupSummaries.length === 0;

  return libraryIsEmpty ? <CreatorWelcomePage /> : <WelcomePage />;
}
