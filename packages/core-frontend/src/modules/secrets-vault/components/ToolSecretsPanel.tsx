import { useState } from 'react';
import { Check, Trash2, Lock, ShieldCheck, ExternalLink, KeyRound } from 'lucide-react';
import {
  type ToolSecrets,
  type ToolSetup,
  type ToolVarStatus,
  setAdminVar,
  setUserVar,
  setOAuthClientSecret,
  deleteAdminVar,
  deleteUserVar,
} from '../services/tool-secrets.api';
import { startToolOAuth } from '../services/connect.api';

/**
 * Configure one tool's secrets, split by who provisions each variable:
 *  - "Set by the tool owner" (admin scope) — one shared value; editable only if
 *    the caller has write access to the `.tool` file (`tool.canWrite`).
 *  - "Set by you" (user scope) — the caller's own value.
 * Reused by the `.tool` editor sidebar and the Secrets page.
 */
export function ToolSecretsPanel({ tool, onChanged }: { tool: ToolSecrets; onChanged: () => void }) {
  const adminVars = tool.variables.filter((v) => v.scope === 'admin');
  const userVars = tool.variables.filter((v) => v.scope === 'user');

  if (tool.variables.length === 0) {
    return (
      <div className="space-y-3">
        <SetupBanner setup={tool.setup} />
        {tool.setup?.kind !== 'oauth-manual' && (
          <p className="text-[11px] text-ink-faint">
            {tool.setup?.kind === 'open' ? (
              <>No setup needed — this server is open and needs no credentials.</>
            ) : (
              <>
                This tool declares no <code className="rounded bg-sunken px-1">variables</code>. Add a{' '}
                <code className="rounded bg-sunken px-1">variables</code> block to the <code>.tool</code> file to make
                its <code>{'${VAR}'}</code> placeholders configurable here.
              </>
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <SetupBanner setup={tool.setup} />
      {adminVars.length > 0 && (
        <VarGroup
          title="Set by the tool owner"
          hint={tool.canWrite ? 'Shared by everyone who uses this tool.' : 'Only a tool writer can set these.'}
          slug={tool.slug}
          vars={adminVars}
          editable={tool.canWrite}
          configured={(v) => v.adminConfigured}
          onSave={(v, value) => setAdminVar(tool.slug, v.name, value)}
          onDelete={(v) => deleteAdminVar(tool.slug, v.name)}
          onChanged={onChanged}
        />
      )}
      {userVars.length > 0 && (
        <VarGroup
          title="Set by you"
          hint="Your own value — not shared with other users."
          slug={tool.slug}
          vars={userVars}
          editable
          // The client-secret editor applies to FILE-DECLARED sign-in providers
          // only. An auto-discovered sign-in (`oauth-auto`) is a public PKCE
          // client the platform registered itself — there is no client secret,
          // and pasting one would overwrite the discovered provider row.
          ownerCanWrite={tool.canWrite && tool.setup?.kind !== 'oauth-auto'}
          configured={(v) => v.userConfigured}
          onSave={(v, value) => setUserVar(tool.slug, v.name, value)}
          onDelete={(v) => deleteUserVar(tool.slug, v.name)}
          onChanged={onChanged}
        />
      )}
    </div>
  );
}

/**
 * When a `type: mcp` server needs sign-in that auto-discovery COULDN'T set up
 * (typically the provider has no dynamic client registration — e.g. Google),
 * the tool would otherwise look like it needs nothing. Make the required manual
 * setup explicit, and surface the discovery `reason` so the admin knows why.
 * The `open` / `oauth-auto` cases need no banner — they're either self-evident
 * (a sign-in variable appears below) or nothing-to-do.
 */
function SetupBanner({ setup }: { setup: ToolSetup | null }) {
  if (setup?.kind !== 'oauth-manual') return null;
  return (
    <div className="rounded border border-amber-300 bg-amber-50 px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-800">
        <KeyRound size={12} /> Sign-in setup needed
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-amber-700">
        This server needs users to sign in, but Bevel couldn't set that up automatically. A tool writer must register an
        OAuth client with the provider, declare it in the <code className="rounded bg-amber-100 px-1">.tool</code> file's{' '}
        <code className="rounded bg-amber-100 px-1">variables</code> block, then set its client secret here.
      </p>
      {setup.reason && <p className="mt-1 text-[10px] italic text-amber-600">{setup.reason}</p>}
    </div>
  );
}

function VarGroup({
  title,
  hint,
  slug,
  vars,
  editable,
  ownerCanWrite = false,
  configured,
  onSave,
  onDelete,
  onChanged,
}: {
  title: string;
  hint: string;
  slug: string;
  vars: ToolVarStatus[];
  editable: boolean;
  /** The caller may set OWNER-side config (a sign-in's client secret). */
  ownerCanWrite?: boolean;
  configured: (v: ToolVarStatus) => boolean;
  onSave: (v: ToolVarStatus, value: string) => Promise<void>;
  onDelete: (v: ToolVarStatus) => Promise<void>;
  onChanged: () => void;
}) {
  return (
    <div>
      <h4 className="text-[11px] font-semibold text-ink-muted">{title}</h4>
      <p className="mb-1.5 text-[10px] text-ink-faint">{hint}</p>
      <ul className="space-y-1.5">
        {vars.map((v) =>
          v.oauth ? (
            <OAuthVarRow key={v.name} v={v} slug={slug} ownerCanWrite={ownerCanWrite} onChanged={onChanged} />
          ) : (
            <VarRow
              key={v.name}
              v={v}
              editable={editable}
              isSet={configured(v)}
              onSave={(value) => onSave(v, value)}
              onDelete={() => onDelete(v)}
              onChanged={onChanged}
            />
          ),
        )}
      </ul>
    </div>
  );
}

function VarRow({
  v,
  editable,
  isSet,
  onSave,
  onDelete,
  onChanged,
}: {
  v: ToolVarStatus;
  editable: boolean;
  isSet: boolean;
  onSave: (value: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onChanged: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setValue('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded border border-line px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[10px] text-ink">{`\${${v.name}}`}</code>
        {isSet ? (
          <span className="flex items-center gap-0.5 text-[10px] text-emerald-600">
            <Check size={11} /> set
          </span>
        ) : (
          <span className="text-[10px] text-amber-600">not set</span>
        )}
        {!editable && <Lock size={11} className="text-ink-faint" aria-label="You cannot edit this" />}
        {editable && isSet && (
          <button
            onClick={() => void run(onDelete)}
            disabled={busy}
            className="ml-auto rounded p-0.5 text-ink-faint hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
            aria-label="Remove secret"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {v.label && <p className="mt-0.5 text-[10px] text-ink-faint">{v.label}</p>}
      {editable && (
        <div className="mt-1 flex gap-1">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isSet ? 'Replace value…' : 'Enter value…'}
            className="min-w-0 flex-1 rounded border border-line-strong px-1.5 py-1 text-[11px] focus:border-accent focus:outline-none"
          />
          <button
            onClick={() => void run(() => onSave(value))}
            disabled={busy || !value}
            className="rounded bg-ink px-2 py-1 text-[11px] text-white disabled:opacity-40"
          >
            Save
          </button>
        </div>
      )}
      {error && <p className="mt-0.5 text-[10px] text-red-600">{error}</p>}
    </li>
  );
}

/**
 * An OAuth-backed variable — filled by signing in, not typing. Shows what the
 * token can do: connected (covers every declared scope), "new permissions needed"
 * with the specific missing scopes listed, or not connected. The button opens the
 * provider consent screen via the tool-scoped start flow.
 *
 * `adminConfigured` on an oauth var = the OWNER-side setup is done (the shared
 * provider row exists: written automatically for discovered sign-ins, or by
 * saving the client secret below for file-declared ones). Until then, Authorize
 * can't work — users see a waiting note, and a tool writer gets the client-secret
 * field to finish the setup.
 */
function OAuthVarRow({
  v,
  slug,
  ownerCanWrite,
  onChanged,
}: {
  v: ToolVarStatus;
  slug: string;
  ownerCanWrite: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState('');
  const ownerConfigured = v.adminConfigured;

  const authorize = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = await startToolOAuth(slug, v.name);
      window.location.href = url; // provider consent, returns to this app
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const saveSecret = async () => {
    setBusy(true);
    setError(null);
    try {
      await setOAuthClientSecret(slug, v.name, secret);
      setSecret('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded border border-line px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <code className="rounded bg-sunken px-1 py-0.5 font-mono text-[10px] text-ink">{`\${${v.name}}`}</code>
        {v.needsReauth ? (
          <span className="text-[10px] text-amber-600">new permissions needed</span>
        ) : v.authorized ? (
          <span className="flex items-center gap-0.5 text-[10px] text-emerald-600">
            <ShieldCheck size={11} /> connected
          </span>
        ) : (
          <span className="text-[10px] text-amber-600">not connected</span>
        )}
        <button
          onClick={() => void authorize()}
          disabled={busy || !ownerConfigured}
          title={ownerConfigured ? undefined : "The tool owner hasn't finished the sign-in setup yet."}
          className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50 disabled:opacity-40"
        >
          <ExternalLink size={11} /> {v.authorized ? 'Reconnect' : 'Authorize'}
        </button>
      </div>
      {v.label && <p className="mt-0.5 text-[10px] text-ink-faint">{v.label}</p>}
      {v.needsReauth && v.missingScopes && v.missingScopes.length > 0 && (
        <p className="mt-0.5 text-[10px] text-amber-600">
          Missing: {v.missingScopes.join(', ')}
        </p>
      )}
      {!ownerConfigured && !ownerCanWrite && (
        <p className="mt-0.5 text-[10px] text-amber-600">
          Waiting for the tool owner to finish the sign-in setup.
        </p>
      )}
      {ownerCanWrite && (
        <div className="mt-1.5 border-t border-line pt-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-medium text-ink-muted">Client secret</span>
            {ownerConfigured ? (
              <span className="flex items-center gap-0.5 text-[10px] text-emerald-600">
                <Check size={11} /> set
              </span>
            ) : (
              <span className="text-[10px] text-amber-600">not set</span>
            )}
          </div>
          <p className="mt-0.5 text-[10px] text-ink-faint">
            From the OAuth app you registered with the provider — shared by everyone, users then sign in themselves.
          </p>
          <div className="mt-1 flex gap-1">
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={ownerConfigured ? 'Replace client secret…' : 'Paste client secret…'}
              className="min-w-0 flex-1 rounded border border-line-strong px-1.5 py-1 text-[11px] focus:border-accent focus:outline-none"
            />
            <button
              onClick={() => void saveSecret()}
              disabled={busy || !secret}
              className="rounded bg-ink px-2 py-1 text-[11px] text-white disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-0.5 text-[10px] text-red-600">{error}</p>}
    </li>
  );
}
