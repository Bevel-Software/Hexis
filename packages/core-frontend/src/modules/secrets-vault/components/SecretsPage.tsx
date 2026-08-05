import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Banner, Button, Surface, TextField } from '../../../shared/components';
import { PageShell } from '../../../shared/components/PageShell';
import { pathForTool } from '../../library/routes/library-paths';
import { ToolLogo } from '../../library/components/ToolLogo';
import {
  listSecrets,
  createOAuthSecret,
  deleteSecret,
  startOAuth,
  type SecretSummary,
} from '../services/secrets.api';
import { listToolSecrets, type ToolSecrets } from '../services/tool-secrets.api';
import { ToolSecretsPanel } from './ToolSecretsPanel';

/**
 * The Secrets page, routed standalone at `/secrets` (below the persistent
 * toolbar). Primary surface is PER-TOOL: each `.tool` manual declares which
 * `${VAR}`s are set by the tool owner (shared) vs by each user, and the panels
 * let the right people fill the right values. OAuth credentials (per-user)
 * live under "Advanced" — the callback/refresh flow is keyed by secret id.
 *
 * `/secrets` is also the standalone-secret OAuth landing: the backend
 * callback returns the browser here with the outcome in the URL fragment
 * (`#authorized` / `#error`), which the page surfaces and then strips.
 *
 * Visually this is the Library's sibling: tool logos lead the cards, statuses
 * say `Connected` / `Set` / `Needs …` in the same grammar, and everything sits
 * on the shared components rather than hand-rolled borders.
 */
/**
 * The OAuth-callback outcome carried in the URL fragment
 * (`#authorized` / `#error=<message>`), or null when there is none.
 * `URLSearchParams` already percent-decodes, so the value is used as-is (a
 * second `decodeURIComponent` would corrupt messages containing `%`).
 */
function readHashOutcome(): { kind: 'authorized' | 'error'; text: string } | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  if (params.has('authorized')) return { kind: 'authorized', text: 'Authorization complete.' };
  if (params.has('error'))
    return { kind: 'error', text: params.get('error') || 'Authorization failed.' };
  return null;
}

export function SecretsPage() {
  const [tools, setTools] = useState<ToolSecrets[]>([]);
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Read ONCE, synchronously, before the fragment is stripped below. Kept in
  // its own slot (not the API `error` above) so the initial refresh() — whose
  // success path clears the API error — can't race the outcome away.
  const [oauthOutcome] = useState(readHashOutcome);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [t, s] = await Promise.all([listToolSecrets(), listSecrets()]);
      setTools(t);
      setSecrets(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Strip the consumed fragment so a refresh doesn't re-announce the outcome.
  useEffect(() => {
    if (oauthOutcome) window.history.replaceState(null, '', window.location.pathname);
  }, [oauthOutcome]);

  // A live API error wins over the (historical) callback outcome; otherwise
  // the callback error stays visible even after the list load succeeds.
  const shownError = error ?? (oauthOutcome?.kind === 'error' ? oauthOutcome.text : null);
  const notice = oauthOutcome?.kind === 'authorized' ? oauthOutcome.text : null;

  const oauthSecrets = secrets.filter((s) => s.kind === 'oauth');

  const onDelete = async (id: string) => {
    try {
      await deleteSecret(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onAuthorize = async (id: string) => {
    try {
      const url = await startOAuth(id);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <PageShell
      title="Secrets"
      actions={
        <Button variant="quiet" size="sm" disabled={loading} onClick={() => void refresh()}>
          Refresh
        </Button>
      }
    >
      {shownError && (
        <Banner role="alert" tone="danger" className="mb-3">
          {shownError}
        </Banner>
      )}
      {notice && (
        <Banner role="status" tone="ok" className="mb-3">
          {notice}
        </Banner>
      )}

      <p className="mb-5 text-ui text-ink-muted">
        Secrets back the{' '}
        <code className="rounded-sm bg-sunken px-1 py-0.5 font-mono text-meta text-ink">
          {'${VARIABLE}'}
        </code>{' '}
        placeholders in your tool manuals. Each tool declares which variables its owner sets once
        (shared by everyone) and which each user sets for themselves. Values are never displayed
        after saving.
      </p>

      {loading ? (
        <p className="py-10 text-center text-ui text-ink-faint">Loading…</p>
      ) : tools.length === 0 ? (
        <p className="py-10 text-center text-ui text-ink-faint">
          No tools you can access declare secrets yet.
        </p>
      ) : (
        <ul className="mb-6 flex flex-col gap-2.5">
          {tools.map((tool) => (
            <li key={tool.slug}>
              <Surface tone="surface" radius="xl" elevation="card" padded>
              <div className="mb-3 flex items-center gap-2.5">
                <ToolLogo slug={tool.slug} name={tool.name} />
                {/* The tool's own page is where its description, capabilities
                    and owner-side setup live — this panel only shows the
                    values. */}
                <Link
                  to={pathForTool(tool.slug)}
                  className="truncate rounded-xs text-ui font-semibold text-ink hover:underline"
                  aria-label={`Open ${tool.name}`}
                >
                  {tool.name}
                </Link>
                <span className="truncate text-meta text-ink-faint">{tool.path}</span>
                {tool.canWrite && (
                  <Badge tone="outline" size="xs" className="ml-auto shrink-0">
                    You can edit shared secrets
                  </Badge>
                )}
              </div>
                <ToolSecretsPanel tool={tool} onChanged={() => void refresh()} />
              </Surface>
            </li>
          ))}
        </ul>
      )}

      <details>
        <summary className="cursor-pointer text-detail font-semibold text-ink-muted">
          Advanced — OAuth credentials
        </summary>
        <div className="mt-3 flex flex-col gap-3.5">
          <p className="text-detail text-ink-muted">
            OAuth secrets are per-user. Name the variable key exactly as the tool references it —{' '}
            <code className="rounded-sm bg-sunken px-1 py-0.5 font-mono text-meta text-ink">
              {'<Manual>_<VAR>'}
            </code>{' '}
            — then sign in to complete the flow.
          </p>
          {oauthSecrets.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {oauthSecrets.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2.5"
                >
                  <code className="rounded-sm bg-sunken px-1.5 py-0.5 font-mono text-meta text-ink">
                    {`\${${s.key}}`}
                  </code>
                  <Badge tone={s.authorized ? 'ok' : 'wait'} size="xs" className="shrink-0">
                    {s.authorized ? 'Connected' : 'Needs your sign-in'}
                  </Badge>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <Button variant="outline" size="tiny" onClick={() => void onAuthorize(s.id)}>
                      {s.authorized ? 'Reconnect' : 'Sign in'}
                    </Button>
                    {/* The accessible name has to START with the visible word
                        (WCAG 2.5.3): "Delete secret" meant voice control could
                        not act on a button that reads "Remove". The key is what
                        makes it unambiguous in a list of otherwise identical
                        rows, so it comes after. */}
                    <Button
                      variant="quiet"
                      size="tiny"
                      aria-label={`Remove ${s.key}`}
                      onClick={() => void onDelete(s.id)}
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Surface tone="sunken" radius="lg" elevation="none" padded>
            <OAuthSecretForm onSaved={() => void refresh()} onError={setError} />
          </Surface>
        </div>
      </details>
    </PageShell>
  );
}

function OAuthSecretForm({ onSaved, onError }: { onSaved: () => void; onError: (m: string) => void }) {
  const [key, setKey] = useState('');
  const [authorizationUrl, setAuthorizationUrl] = useState('');
  const [tokenUrl, setTokenUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [scopes, setScopes] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await createOAuthSecret({
        key: key.trim(),
        provider: {
          authorizationUrl: authorizationUrl.trim(),
          tokenUrl: tokenUrl.trim(),
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim() || undefined,
          scopes: scopes.split(/[\s,]+/).filter(Boolean),
        },
      });
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Field label="Variable key (Manual_VAR)">
        <TextField
          className="w-full"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="github_GITHUB_TOKEN"
        />
      </Field>
      <Field label="Authorization URL">
        <TextField className="w-full" value={authorizationUrl} onChange={(e) => setAuthorizationUrl(e.target.value)} />
      </Field>
      <Field label="Token URL">
        <TextField className="w-full" value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} />
      </Field>
      <Field label="Client ID">
        <TextField className="w-full" value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </Field>
      <Field label="Client secret (optional)">
        <TextField
          className="w-full"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
        />
      </Field>
      <Field label="Scopes (space or comma separated)">
        <TextField className="w-full" value={scopes} onChange={(e) => setScopes(e.target.value)} />
      </Field>
      <p className="text-detail text-ink-muted">
        Save first, then click “Sign in” on the secret to complete the flow.
      </p>
      <div>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !key.trim() || !authorizationUrl.trim() || !tokenUrl.trim() || !clientId.trim()}
          onClick={() => void submit()}
        >
          Save OAuth secret
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-detail font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  );
}
