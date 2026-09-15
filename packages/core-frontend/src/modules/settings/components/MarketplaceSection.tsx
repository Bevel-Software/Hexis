import { useEffect, useState } from 'react';
import { Banner, Button, Surface } from '../../../shared/components';
import { ClaudeRegistrationSteps } from '../../toolbar/components/ClaudeRegistrationSteps';
import {
  fetchMarketplaceRegistration,
  setMarketplaceRegistration,
} from '../services/github-facade.api';

interface Props {
  /**
   * Where the section stands. `setup` is the first-run screen, where it is
   * optional and can be skipped; `settings` is Deployment settings, where it
   * waits for whenever an admin gets to it.
   */
  variant: 'setup' | 'settings';
}

/**
 * The Marketplace section of Deployment configuration: registering this
 * deployment with a Claude organization, so people can add its marketplace in
 * Cowork and on claude.ai. ONE component in both hosts — the first-run setup
 * screen and Deployment settings — so the steps cannot drift between them.
 *
 * It holds what used to be the admin branch of the External agent access
 * tutorial: the registration steps, the generated credentials (inside the
 * drawer, fetched only once it is open), and the GitHub Enterprise Server
 * steps. Plus the one thing Claude never reports back: whether the
 * registration happened. An admin says so here, and External agent access
 * shows everyone the tutorial from then on.
 */
export function MarketplaceSection({ variant }: Props) {
  // Controlled, both attributes together: the credentials wait on `open`, and
  // the element must not be able to disagree with the state gating them.
  const [open, setOpen] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchMarketplaceRegistration()
      .then((r) => {
        if (live) setRegistered(r);
      })
      .catch((err: unknown) => {
        if (live) setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  // External agent access links admins to `/deployment#marketplace`. The
  // section mounts after the settings load, long after the router would have
  // looked for the anchor, so it brings itself into view.
  useEffect(() => {
    // By id: `Surface` takes no ref, and the id is the anchor anyway.
    if (window.location.hash === '#marketplace') {
      document.getElementById('marketplace')?.scrollIntoView?.({ block: 'start' });
    }
  }, []);

  const mark = async (next: boolean) => {
    setSaving(true);
    setSaveError(null);
    try {
      setRegistered(await setMarketplaceRegistration(next));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (skipped) {
    return (
      <Surface
        as="section"
        tone="surface"
        radius="lg"
        elevation="card"
        className="mt-10 p-6"
        data-testid="marketplace-deployment-section"
      >
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-detail text-ink-muted">
            Marketplace skipped. It is in Deployment settings whenever you want it.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => setSkipped(false)}>
            Set it up now
          </Button>
        </div>
      </Surface>
    );
  }

  return (
    <Surface
      as="section"
      id="marketplace"
      aria-labelledby="marketplace-heading"
      tone="surface"
      radius="lg"
      elevation="card"
      className="mt-10 p-6 space-y-4"
      data-testid="marketplace-deployment-section"
    >
      <div>
        <div className="flex items-baseline gap-2.5">
          <h2 id="marketplace-heading" className="text-title font-semibold text-ink">
            Marketplace
          </h2>
          {variant === 'setup' && <span className="text-meta text-ink-faint">Optional</span>}
        </div>
        <p className="mt-1 max-w-[60ch] text-detail text-ink-muted">
          Lets people add this deployment's skills as plugins in Cowork and on claude.ai. Register it
          once with your Claude organization, then mark it registered below: until then, External
          agent access tells people an admin still has to set it up. Claude Code and Codex need none
          of this.
        </p>
        {variant === 'setup' && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={() => setSkipped(true)}>
              Skip for now
            </Button>
            <span className="text-meta text-ink-faint">
              Nothing else waits on it; it stays in Deployment settings.
            </span>
          </div>
        )}
      </div>

      <details
        className="rounded-md border border-line"
        open={open}
        onToggle={(e) => setOpen(e.currentTarget.open)}
      >
        <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink">
          Register this deployment with Claude
        </summary>
        <div className="px-3 pb-3">
          <ClaudeRegistrationSteps opened={open} />
        </div>
      </details>

      <div className="space-y-2">
        {loadError && (
          <Banner tone="danger" role="alert">
            {loadError}
          </Banner>
        )}
        {registered !== null && (
          <div className="flex flex-wrap items-center gap-3">
            {/* Not a live region: the setup screen's save notices are, and
                this line only changes under the button the reader pressed. */}
            <p className="text-detail text-ink-muted">
              {registered
                ? 'Registered. Everyone sees the Cowork and claude.ai steps on External agent access.'
                : 'Not registered yet. People are told an admin has to set this up.'}
            </p>
            <Button
              type="button"
              variant={registered ? 'outline' : 'primary'}
              size="sm"
              disabled={saving}
              onClick={() => void mark(!registered)}
            >
              {saving ? 'Saving…' : registered ? 'Mark as not registered' : 'Mark as registered'}
            </Button>
          </div>
        )}
        {saveError && (
          <Banner tone="danger" role="alert">
            {saveError}
          </Banner>
        )}
      </div>
    </Surface>
  );
}
