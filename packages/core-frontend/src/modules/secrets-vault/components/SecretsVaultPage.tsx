import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2, ShieldCheck, ExternalLink, Wrench } from 'lucide-react';
import { Dialog } from '../../../shared/components/Dialog';
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
 * The Secrets Vault, as a gear-menu dialog. Primary surface is PER-TOOL: each
 * `.tool` manual declares which `${VAR}`s are set by the tool owner (shared) vs
 * by each user, and the panels let the right people fill the right values.
 * OAuth credentials (per-user) live under "Advanced" — the callback/refresh
 * flow is keyed by secret id. Also mounted on the `/secrets` landing route,
 * which is where the OAuth callback returns the browser (`#authorized`/`#error`
 * in the fragment).
 */
export function SecretsVaultPage({ open, onClose }: { open: boolean; onClose(): void }) {
  const [tools, setTools] = useState<ToolSecrets[]>([]);
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // Surface the OAuth-callback outcome carried in the URL fragment.
  useEffect(() => {
    if (!open) return;
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.has('authorized')) setNotice('Authorization complete.');
    // `URLSearchParams` already percent-decodes, so use the value as-is (a second
    // `decodeURIComponent` would corrupt messages containing `%`).
    else if (params.has('error')) setError(params.get('error') || 'Authorization failed.');
    if (params.has('authorized') || params.has('error')) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [open]);

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
    <Dialog
      open={open}
      onClose={onClose}
      title="Secrets Vault"
      size="2xl"
      headerActions={
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded p-1.5 hover:bg-slate-100"
          aria-label="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      }
    >
      {error && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
        )}
        {notice && (
          <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {notice}
          </div>
        )}

        <p className="mb-4 max-w-2xl text-xs text-slate-500">
          Secrets back the <code className="rounded bg-slate-100 px-1">{'${VARIABLE}'}</code> placeholders in your tool
          manuals. Each tool declares which variables its owner sets once (shared by everyone) and which each user sets
          for themselves. Values are never displayed after saving.
        </p>

        {loading ? (
          <div className="text-xs text-slate-400">Loading…</div>
        ) : tools.length === 0 ? (
          <div className="rounded border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-400">
            No tools you can access declare secrets yet.
          </div>
        ) : (
          <ul className="mb-6 max-w-2xl space-y-3">
            {tools.map((tool) => (
              <li key={tool.slug} className="rounded border border-slate-200 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <Wrench size={13} className="text-slate-500" />
                  <span className="text-xs font-semibold text-slate-700">{tool.name}</span>
                  <span className="text-[10px] text-slate-400">{tool.path}</span>
                  {tool.canWrite && (
                    <span className="ml-auto rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
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
          <summary className="cursor-pointer text-xs font-medium text-slate-600">Advanced — OAuth credentials</summary>
          <div className="mt-3 space-y-4">
            <p className="text-[11px] text-slate-400">
              OAuth secrets are per-user. Name the variable key exactly as the tool references it —
              <code className="rounded bg-slate-100 px-1">{'<Manual>_<VAR>'}</code> — then click Authorize to complete
              the flow.
            </p>
            {oauthSecrets.length > 0 && (
              <ul className="divide-y divide-slate-100 rounded border border-slate-200">
                {oauthSecrets.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2">
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
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
                        className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        aria-label="Delete secret"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="rounded border border-slate-200 p-4">
              <OAuthSecretForm onSaved={() => void refresh()} onError={setError} />
            </div>
          </div>
        </details>
    </Dialog>
  );
}

const inputCls =
  'w-full rounded border border-slate-300 px-2 py-1.5 text-xs focus:border-slate-500 focus:outline-none';

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
      <p className="text-[11px] text-slate-400">Save first, then click “Authorize” on the secret to complete the flow.</p>
      <button
        onClick={() => void submit()}
        disabled={busy || !key.trim() || !authorizationUrl.trim() || !tokenUrl.trim() || !clientId.trim()}
        className="rounded bg-slate-800 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
      >
        Save OAuth secret
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}
