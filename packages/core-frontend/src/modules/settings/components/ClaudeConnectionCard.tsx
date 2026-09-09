import { useCallback, useEffect, useRef, useState } from 'react';
import { Banner, Button } from '../../../shared/components';
import { Dialog } from '../../../shared/components/Dialog';
import { CopyBlock } from '../../../shared/mcp';
import { ClaudeConnectionFields } from './ClaudeConnectionFields';
import {
  fetchGitHubFacade,
  rotateGitHubFacade,
  type GitHubFacadeCredentials,
} from '../services/github-facade.api';

/**
 * The admin's half of "add this marketplace in Cowork or claude.ai".
 *
 * Those surfaces sync marketplaces only from hosts they know, and the one
 * kind of host an organization can add itself is a GitHub Enterprise Server.
 * Hexis presents itself as one: an Owner registers this deployment once in
 * Claude's admin settings, pasting the fields below, and from then on every
 * person connects their own claude.ai account through the ordinary hexis
 * sign-in and gets the marketplace compiled for what they may read.
 *
 * The fields are exactly the ones the "Add manually" form asks for, in its
 * order, so the card reads as a copy source, not a form of its own. Rotate
 * replaces the generated ones: the registration on the Claude side stops
 * matching until an Owner re-enters them, while people's existing
 * connections — connection keys, ours — keep working.
 *
 * What is on screen is always the LATEST answer the server gave: a load
 * that was in flight when a rotation returned is discarded, never applied
 * over the new set — an admin copying pre-rotation values into Claude would
 * register a secret that no longer exists.
 */
export function ClaudeConnectionCard() {
  const [creds, setCreds] = useState<GitHubFacadeCredentials | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  // Every request takes a number; only the newest one's answer is applied.
  const latest = useRef(0);

  const refresh = useCallback(() => {
    const seq = ++latest.current;
    fetchGitHubFacade()
      .then((c) => {
        if (seq !== latest.current) return;
        setCreds(c);
        setError(null);
      })
      .catch((err: unknown) => {
        if (seq !== latest.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seq === latest.current) setLoaded(true);
      });
  }, []);

  useEffect(refresh, [refresh]);

  const rotate = async () => {
    const seq = ++latest.current;
    setRotating(true);
    setRotateError(null);
    try {
      const next = await rotateGitHubFacade();
      if (seq !== latest.current) return;
      setCreds(next);
      setError(null);
      setConfirmRotate(false);
    } catch (err) {
      // Inside the dialog, where the person is looking — not behind its scrim.
      if (seq === latest.current) setRotateError(err instanceof Error ? err.message : String(err));
    } finally {
      setRotating(false);
    }
  };

  const closeRotate = () => {
    setConfirmRotate(false);
    setRotateError(null);
  };

  return (
    <section aria-labelledby="claude-connection-heading" className="space-y-3">
      <div>
        <h2 id="claude-connection-heading" className="text-title font-semibold text-ink">
          Claude connection
        </h2>
        <p className="mt-1 text-xs text-ink-muted leading-snug">
          Lets people add this deployment's skills marketplace in Cowork and on claude.ai, which
          accept marketplaces only from a GitHub Enterprise Server their organization registered.
          Hexis answers as one. Register it once (Owner role, Team or Enterprise plan): in Claude's
          admin settings, under Claude Code, GitHub Enterprise Server, choose <b>Add manually</b>{' '}
          and paste the fields below. When it asks you to connect your GitHub Enterprise account,
          you sign in here.
        </p>
      </div>

      {!loaded && <div className="text-xs text-ink-muted">Loading…</div>}

      {error && (
        <Banner tone="danger" role="alert">
          {error}
          <Button variant="outline" size="sm" className="ml-3" onClick={refresh}>
            Try again
          </Button>
        </Banner>
      )}

      {creds && (
        <div className="border border-line rounded p-3 space-y-3">
          <ClaudeConnectionFields creds={creds} />
          <p className="text-meta text-ink-muted leading-snug">
            The webhook URL Claude generates after saving can be ignored: nothing here sends
            webhooks yet. The private key is required by the form but not used by the
            user-added marketplace flow.
          </p>
          <CopyBlock label="Marketplace URL people add" value={creds.marketplaceUrl} rows={1} />
          <div className="flex items-center justify-between gap-3">
            <span className="text-meta text-ink-muted">
              {creds.rotatedAt
                ? `Rotated ${new Date(creds.rotatedAt).toLocaleString()}`
                : `Generated ${new Date(creds.createdAt).toLocaleString()}`}
            </span>
            <Button variant="outline" size="sm" onClick={() => setConfirmRotate(true)}>
              Rotate credentials
            </Button>
          </div>
        </div>
      )}

      <Dialog
        open={confirmRotate}
        onClose={closeRotate}
        title="Rotate the Claude connection credentials?"
        size="sm"
        busy={rotating}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={closeRotate} disabled={rotating}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={() => void rotate()} disabled={rotating}>
              {rotating ? 'Rotating…' : rotateError ? 'Try again' : 'Rotate'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink">
          The App ID, Client ID, client secret, webhook secret and private key change; the
          hostname and the marketplace URL stay the same. The registration in Claude's admin
          settings stops working until an Owner enters the new values there. People who already
          connected keep their connection.
        </p>
        {rotateError && (
          <Banner tone="danger" role="alert" className="mt-3">
            {rotateError}
          </Banner>
        )}
      </Dialog>
    </section>
  );
}
