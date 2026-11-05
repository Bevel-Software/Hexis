import { useContext, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { DEFAULT_BRANCH, KNOWLEDGE_BASE_DIR } from '@bevel-software/platform-shared';
import { isPublicDemo } from '../../../core/bootstrap';
import { KB_ROUTE_PREFIX, WorkspaceContext, kbFileUrl } from '../../workspace';
import { takePostLoginRedirect } from '../../auth';

/**
 * The public demo's front door is its guided tour, not an empty file tree:
 * a first-time visitor landing on the bare domain has no idea what they are
 * looking at, and this page exists to tell them. Demo-branch content
 * knowledge, deliberately — the file is seeded on the demo workspace's
 * knowledge root, and this constant lives only on the public-demo branch.
 */
const DEMO_HOME_FILE = 'Start here.md';

/**
 * Where `/` lands: Knowledge, for everyone, brand-new accounts included.
 *
 * There is no automatic welcome page. Choosing where the knowledge lives is
 * the one step that has to come before the app (the setup gate asks it);
 * connecting an agent can wait, and it waits in plain sight — the sidebar's
 * Connect your agent pill and the Get set up list both lead to the welcome
 * page, and neither takes over the screen on the way in.
 *
 * A deep link that came through SSO arrives HERE rather than at itself — the
 * OAuth round-trip returns to a fixed callback URL, which scrubs to `/`
 * (see `consumeSsoCallback`) — so the link's intention survives as the stash
 * `startSsoLogin` left behind, and it outranks Knowledge.
 *
 * On the public demo (`isPublicDemo()`), and only there, a bare `/` lands on
 * the Start here page instead of the tree. A carried deep link still wins —
 * it is an intention, the tour is a default.
 */
export function RootLanding() {
  // Read tolerantly, not via useWorkspace(): this component's documented
  // property is that it renders providerless (tests, bare ShellRoutes), and
  // only the demo-home redirect needs the workspace at all.
  const kbDirName = useContext(WorkspaceContext)?.kbDirName ?? null;
  const [stash, setStash] = useState<{ returnTo: string | null } | null>(null);

  // Taken in an effect, not a state initializer: the take CLEARS the stash,
  // and StrictMode double-invokes initializers — the second invocation would
  // read the empty slot and win. The effect's second run reads null too, but
  // only the run that found something writes.
  useEffect(() => {
    const returnTo = takePostLoginRedirect();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the one-shot take described above; it settles in one extra render
    setStash((s) => s ?? { returnTo });
  }, []);

  // One settle-frame while the stash is read — navigating first and correcting
  // after would put the wrong page in the history.
  if (stash === null) return null;

  if (stash.returnTo) return <Navigate to={stash.returnTo} replace />;
  if (isPublicDemo()) {
    // Hold for the workspace context rather than landing somewhere else and
    // correcting — kbDirName resolves within the first round-trip.
    if (kbDirName === null) return null;
    return (
      <Navigate
        to={kbFileUrl(DEFAULT_BRANCH, `${kbDirName}/${KNOWLEDGE_BASE_DIR}/${DEMO_HOME_FILE}`)}
        replace
      />
    );
  }
  return <Navigate to={KB_ROUTE_PREFIX} replace />;
}
