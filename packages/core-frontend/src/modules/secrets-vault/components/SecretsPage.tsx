import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw, Trash2, ShieldCheck, ExternalLink, Wrench } from 'lucide-react';
import { PageShell } from '../../../shared/components/PageShell';
import { pathForTool } from '../../library/routes/library-paths';
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
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded p-1.5 hover:bg-hover text-ink-muted"
          aria-label="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      }
    >
      {shownError && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{shownError}</div>
        )}
        {notice && (
          <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {notice}
          </div>
        )}

        <p className="mb-4 max-w-2xl text-xs text-ink-muted">
          Secrets back the <code className="rounded bg-sunken px-1">{'${VARIABLE}'}</code> placeholders in your tool
          manuals. Each tool declares which variables its owner sets once (shared by everyone) and which each user sets
          for themselves. Values are never displayed after saving.
        </p>

        {loading ? (
          <div className="text-xs text-ink-faint">Loading…</div>
        ) : tools.length === 0 ? (
          <div className="rounded border border-dashed border-line px-4 py-6 text-center text-xs text-ink-faint">
            No tools you can access declare secrets yet.
          </div>
        ) : (
          <ul className="mb-6 max-w-2xl space-y-3">
            {tools.map((tool) => (
              <li key={tool.slug} className="rounded border border-line p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Wrench size={13} className="text-ink-muted" />
                  {/* The tool's own page is where its description, capabilities
                      and owner-side setup live — this panel only shows the
                      values. */}
                  <Link
                    to={pathForTool(tool.slug)}
                    className="text-xs font-semibold text-ink hover:underline"
                    aria-label={`Open ${tool.name}`}
                  >
                    {tool.name}
                  </Link>
                  <span className="text-[10px] text-ink-faint">{tool.path}</span>
                  {tool.canWrite && (
                    <span className="ml-auto rounded bg-sunken px-1.5 py-0.5 text-[10px] text-ink-muted">
                      you can edit shared secrets
                    </span>
                  )}
                </div>
                <ToolSecretsPanel tool={tool} onChanged={() => void refresh()} />
              </li>
            ))}
          </ul>
        )}

        <details className="max-w-2xl">
          <summary className="cursor-pointer text-xs font-medium text-ink-muted">Advanced — OAuth credentials</summary>
          <div className="mt-3 space-y-4">
            <p className="text-[11px] text-ink-faint">
              OAuth secrets are per-user. Name the variable key exactly as the tool references it —
              <code className="rounded bg-sunken px-1">{'<Manual>_<VAR>'}</code> — then click Authorize to complete
              the flow.
            </p>
            {oauthSecrets.length > 0 && (
              <ul className="divide-y divide-line rounded border border-line">
                {oauthSecrets.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                    <code className="rounded bg-sunken px-1.5 py-0.5 text-xs font-medium text-ink">
                      {`\${${s.key}}`}
                    </code>
                    {s.authorized ? (
                      <span className="flex items-center gap-1 text-[11px] text-emerald-600">
                        <ShieldCheck size={12} /> authorized
                      </span>
                    ) : (
                      <span className="text-[11px] text-amber-600">not authorized</span>
                    )}
                    <div className="ml-auto flex items-center gap-1">
                      <button
                        onClick={() => void onAuthorize(s.id)}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                      >
                        <ExternalLink size={12} /> {s.authorized ? 'Re-authorize' : 'Authorize'}
                      </button>
                      <button
                        onClick={() => void onDelete(s.id)}
                        className="rounded p-1 text-ink-faint hover:bg-red-50 hover:text-red-600"
                        aria-label="Delete secret"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="rounded border border-line p-4">
              <OAuthSecretForm onSaved={() => void refresh()} onError={setError} />
            </div>
          </div>
        </details>
    </PageShell>
  );
}

const inputCls =
  'w-full rounded border border-line-strong px-2 py-1.5 text-xs focus:border-accent focus:outline-none';

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
    <div className="space-y-2">
      <Field label="Variable key (Manual_VAR)">
        <input className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} placeholder="github_GITHUB_TOKEN" />
      </Field>
      <Field label="Authorization URL">
        <input className={inputCls} value={authorizationUrl} onChange={(e) => setAuthorizationUrl(e.target.value)} />
      </Field>
      <Field label="Token URL">
        <input className={inputCls} value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} />
      </Field>
      <Field label="Client ID">
        <input className={inputCls} value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </Field>
      <Field label="Client secret (optional)">
        <input className={inputCls} type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} />
      </Field>
      <Field label="Scopes (space or comma separated)">
        <input className={inputCls} value={scopes} onChange={(e) => setScopes(e.target.value)} />
      </Field>
      <p className="text-[11px] text-ink-faint">Save first, then click “Authorize” on the secret to complete the flow.</p>
      <button
        onClick={() => void submit()}
        disabled={busy || !key.trim() || !authorizationUrl.trim() || !tokenUrl.trim() || !clientId.trim()}
        className="rounded bg-ink px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
      >
        Save OAuth secret
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  );
}
