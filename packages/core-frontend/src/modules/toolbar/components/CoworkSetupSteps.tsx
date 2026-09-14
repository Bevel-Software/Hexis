import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Banner } from '../../../shared/components';
import { CopyBlock } from '../../../shared/mcp';
import { marketplaceGitUrl } from '../../../shared/marketplace-url';
import { fetchMarketplaceRegistration } from '../../settings/services/github-facade.api';
import { ClaudeMarketplaceCarousel } from './ClaudeMarketplaceCarousel';
import { Prose } from './setup-step-parts';
import { deploymentHost } from './deployment-address';

/**
 * How a person installs this deployment's skills as plugins in Cowork and on
 * claude.ai — the SAME tutorial for everyone, admin or not.
 *
 * Registering the deployment with a Claude organization is not a step anyone
 * takes from here any more: it lives in the Marketplace section of Deployment
 * configuration. What this page needs to know is only whether that happened,
 * a boolean any signed-in person may read:
 *
 *  - registered — the personal tutorial, identical for admins and everyone.
 *  - not registered — no tutorial, because its first screen would list no
 *    deployment. Everyone is told an admin has to configure the marketplace;
 *    an admin is also sent to the section that does it.
 *
 * `isAdmin` decides only the wording of that notice, never what the tutorial
 * shows. The state is read on mount, so completing registration and coming
 * back here (or reloading) is all it takes to see the tutorial.
 */
export function CoworkSetupSteps({ isAdmin }: { isAdmin: boolean }) {
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchMarketplaceRegistration()
      .then((r) => {
        if (live) setRegistered(r);
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  if (error) {
    return (
      <Banner tone="danger" role="alert">
        {error}
      </Banner>
    );
  }
  if (registered === null) return <div className="text-meta text-ink-muted">Loading…</div>;

  if (!registered) {
    return (
      <Banner tone="wait" role="status" data-testid="marketplace-not-configured">
        {isAdmin ? (
          <>
            Cowork and claude.ai are not set up for this deployment yet. Register it with your
            Claude organization in the{' '}
            <Link to="/deployment#marketplace" className="underline">
              Marketplace section of Deployment settings
            </Link>
            , then mark it registered there. The steps for adding the marketplace appear here, for
            everyone, once it is.
          </>
        ) : (
          <>
            Cowork and claude.ai are not set up for this deployment yet. An admin has to configure
            the marketplace before you can add it there. Claude Code and Codex work already, below.
          </>
        )}
      </Banner>
    );
  }

  return (
    <div className="space-y-3">
      <Prose>
        Cowork and claude.ai install marketplaces only from GitHub, or from a GitHub Enterprise
        Server your Claude organization has registered. This deployment answers as one. An admin
        here registers it once. If the first step does not list this deployment, ask an admin to
        register it.
      </Prose>
      <CopyBlock label="Marketplace URL" value={marketplaceGitUrl()} rows={2} />
      <ClaudeMarketplaceCarousel host={deploymentHost()} />
    </div>
  );
}
