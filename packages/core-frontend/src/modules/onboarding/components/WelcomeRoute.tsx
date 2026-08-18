import { useLayoutEffect } from 'react';
import { useAdmin } from '../../admin/state/admin.context';
import { setSidebarCollapsed } from '../../layout/state/sidebar';
import { useLibrary } from '../../library/state/library-data';
import { useWelcomeRouteState } from '../welcome-state';
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
  const { isAdmin, isAdminLoading = false } = useAdmin();
  const data = useLibrary();
  // The same reading `WelcomePage` gets — one parser, so the router and the
  // page cannot disagree about whether a deep link was carried.
  const { greeting, returnTo } = useWelcomeRouteState();

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

  if (isAdminLoading || data.loading || data.pluginsLoading) {
    // Two phases, two truths. While the ADMIN verdict is unknown the reader
    // may be headed for the agent welcome, where their library is beside the
    // point — so the hold says nothing about one. Once the verdict says
    // admin, the remaining wait really is their library loading.
    // A live region: the wait changes its own words as it advances from the
    // admin check to the library load, and a silent swap is a change only
    // sighted users are told about.
    return (
      <div role="status" className="py-16 text-center text-ui text-ink-faint">
        {isAdminLoading ? 'One moment…' : 'Preparing your library…'}
      </div>
    );
  }

  const libraryIsEmpty =
    !data.error &&
    !data.pluginsError &&
    data.items.length === 0 &&
    data.pluginSummaries.length === 0;

  return libraryIsEmpty ? <CreatorWelcomePage /> : <WelcomePage />;
}
