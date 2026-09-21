import { useState } from 'react';
import { Badge, Banner, Button, TextField } from '../../../shared/components';
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
import { SavedKeyProbeResult } from '../probe/SavedKeyProbeResult';
import { useSavedKeyProbe, type SavedKeyProbe } from '../probe/useSavedKeyProbe';
import { announceToolCredentialsChanged } from '../../../core/events';

/**
 * Configure one tool's secrets, split by who provisions each variable:
 *  - "Set by the tool owner" (admin scope) — one shared value; editable only if
 *    the caller has write access to the `.tool` file (`tool.canWrite`).
 *  - "Set by you" (user scope) — the caller's own value.
 * Reused by the `.tool` editor sidebar and the Secrets page.
 *
 * Speaks the Library's status vocabulary — `Connected`, `Set`, `Needs …` —
 * because a person arrives here FROM a card or a tool page that used those
 * words, and the fix-it surface must not describe the same state differently.
 * Values are write-only throughout: fields start empty, saving replaces.
 *
 * Every save here is followed by the manual's health check, and the answer
 * lands on the row that was saved (`SavedKeyProbeResult`). The vault used to
 * store a value and stop, which made it the quietest place in the app to
 * install a key the provider would refuse.
 */
export function ToolSecretsPanel({ tool, onChanged }: { tool: ToolSecrets; onChanged: () => void }) {
  const adminVars = tool.variables.filter((v) => v.scope === 'admin');
  const userVars = tool.variables.filter((v) => v.scope === 'user');

  /**
   * ONE probe for the whole panel, shared by every row.
   *
   * That is what a probe is: a single call carrying the tool's whole
   * credential set, not a test of one `${VAR}`. Giving each row its own would
   * leave the admin key's row still saying `Connected` after the user key
   * below it changed the very credentials that answer was about.
   *
   * The slug is not merely WHAT to call: it is part of the identity of every
   * answer the hook holds. This panel is not always remounted when the tool
   * under it changes — the workspace's `.tool` renderer swaps `tool` on a
   * mounted panel — and the hook is where that is handled, so no host of this
   * component has to remember to key it.
   */
  const probe = useSavedKeyProbe(tool.slug);

  /**
   * Every write in this panel funnels through here, which is why the Library
   * is told from the panel rather than from each of its three hosts (the
   * Secrets page, the `.tool` editor's sidebar, and whatever mounts it next):
   * a host that forgot would leave the cards and the plugin banners reading
   * the state from before the save until a browser reload.
   */
  const changed = () => {
    announceToolCredentialsChanged();
    onChanged();
  };

  if (tool.variables.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <SetupBanner setup={tool.setup} declared={tool.variables.some((v) => v.oauth)} />
        {tool.setup?.kind !== 'oauth-manual' && (
          <p className="text-detail text-ink-muted">
            {tool.setup?.kind === 'open' ? (
              <>No setup needed: this server is open and needs no credentials.</>
            ) : (
              <>
                This tool declares no <Chip>variables</Chip>. Add a <Chip>variables</Chip> block to
                the <Chip>.tool</Chip> file to make its <Chip>{'${VAR}'}</Chip> placeholders
                configurable here.
              </>
            )}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5">
      <SetupBanner setup={tool.setup} declared={tool.variables.some((v) => v.oauth)} />
      {adminVars.length > 0 && (
        <VarPlugin
          title="Set by the tool owner"
          hint={tool.canWrite ? 'Shared by everyone who uses this tool.' : 'Only a tool writer can set these.'}
          slug={tool.slug}
          vars={adminVars}
          editable={tool.canWrite}
          configured={(v) => v.adminConfigured}
          onSave={(v, value) => setAdminVar(tool.slug, v.name, value)}
          onDelete={(v) => deleteAdminVar(tool.slug, v.name)}
          onChanged={changed}
          probe={probe}
        />
      )}
      {userVars.length > 0 && (
        <VarPlugin
          title="Set by you"
          hint="Your own value: not shared with other users."
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
          onChanged={changed}
          probe={probe}
        />
      )}
    </div>
  );
}

/** A `${VAR}`-style inline token, on the sunken well every code chip sits in. */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-sm bg-sunken px-1 py-0.5 font-mono text-meta text-ink">{children}</code>
  );
}

/**
 * When a `type: mcp` server needs a sign-in with an owner-registered OAuth app
 * (auto-discovery couldn't register one — Google, HubSpot — or the declaration
 * already names a client id), the tool would otherwise look like it needs
 * nothing until the owner finishes. Make the remaining step explicit, and
 * surface the discovery `reason` so the admin knows what still blocks it.
 * The `open` / `oauth-auto` cases need no banner — they're either self-evident
 * (a sign-in variable appears below) or nothing-to-do.
 */
function SetupBanner({ setup, declared }: { setup: ToolSetup | null; declared: boolean }) {
  if (setup?.kind !== 'oauth-manual') return null;
  return (
    <Banner tone="wait" role="status">
      <span className="font-semibold">Sign-in setup needed.</span>{' '}
      {declared ? (
        <>The sign-in is declared — a tool writer sets its client secret here to finish.</>
      ) : (
        <>
          This server needs users to sign in, but Bevel couldn&apos;t set that up automatically. A
          tool writer must register an OAuth app with the provider and declare its client id on a
          user-scoped sign-in variable — under <Chip>Edit server</Chip> on the tool&apos;s page for
          an MCP server, or in the <Chip>.tool</Chip> file&apos;s <Chip>variables</Chip> block —
          then set its client secret here.
        </>
      )}
      {setup.reason && <em className="mt-1 block text-detail">{setup.reason}</em>}
    </Banner>
  );
}

function VarPlugin({
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
  probe,
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
  /** The panel's one probe — both groups of rows share it. */
  probe: SavedKeyProbe;
}) {
  return (
    <div>
      <h4 className="text-label uppercase text-ink-faint">{title}</h4>
      <p className="mb-1.5 mt-0.5 text-detail text-ink-muted">{hint}</p>
      <ul className="flex flex-col gap-1.5">
        {vars.map((v) =>
          v.oauth ? (
            <OAuthVarRow
              key={v.name}
              v={v}
              slug={slug}
              ownerCanWrite={ownerCanWrite}
              onChanged={onChanged}
              probe={probe}
            />
          ) : (
            <VarRow
              key={v.name}
              v={v}
              editable={editable}
              isSet={configured(v)}
              onSave={(value) => onSave(v, value)}
              onDelete={() => onDelete(v)}
              onChanged={onChanged}
              probe={probe}
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
  probe,
}: {
  v: ToolVarStatus;
  editable: boolean;
  isSet: boolean;
  onSave: (value: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onChanged: () => void;
  /** Shared with the panel's other rows; it answers for whichever saved last. */
  probe: SavedKeyProbe;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * @param saved a value was WRITTEN, so there is something to test. A delete
   *   goes through here too and has nothing to prove — it only orphans
   *   whatever the last probe was about to say, since that described a value
   *   this row no longer holds.
   */
  const run = async (fn: () => Promise<void>, saved = false) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      // Stored and cleared first; the probe cannot fail or delay any of this.
      setValue('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    } finally {
      setBusy(false);
    }
    // Outside the try: a probe's trouble is never reported as the save's, and
    // the save is already done by the time either is decided. Naming the
    // variable moves the panel's shared answer onto THIS row.
    if (saved) probe.probeSaved(v.name);
    else probe.forget();
  };

  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Chip>{`\${${v.name}}`}</Chip>
        <Badge tone={isSet ? 'ok' : 'wait'} size="xs" className="shrink-0">
          {isSet ? 'Set' : 'Needs a key'}
        </Badge>
        {editable && isSet && (
          <Button
            variant="quiet"
            size="tiny"
            className="ml-auto"
            disabled={busy}
            onClick={() => void run(onDelete)}
          >
            Remove
          </Button>
        )}
      </div>
      {v.label && <p className="mt-1 text-detail text-ink-muted">{v.label}</p>}
      {editable && (
        <div className="mt-1.5 flex gap-1.5">
          {/* Write-only: starts empty even when a value exists; saving replaces
              rather than reveals. */}
          <TextField
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isSet ? 'Replace value…' : 'Enter value…'}
            aria-label={`Value for ${v.name}`}
            className="min-w-0 flex-1"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !value}
            onClick={() => void run(() => onSave(value), true)}
          >
            Save
          </Button>
        </div>
      )}
      {/* What the provider made of the value just saved here. Only on the row
          that asked: the answer is the tool's, and the newest save is the only
          place it is still current. */}
      {probe.subject === v.name && <SavedKeyProbeResult probe={probe} className="mt-1.5" />}
      {error && (
        <p role="alert" className="mt-1 text-detail text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

/**
 * An OAuth-backed variable — filled by signing in, not typing. Shows what the
 * token can do: connected (covers every declared scope), needs signing in again
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
  probe,
}: {
  v: ToolVarStatus;
  slug: string;
  ownerCanWrite: boolean;
  onChanged: () => void;
  /** Shared with the panel's other rows; it answers for whichever saved last. */
  probe: SavedKeyProbe;
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
      return;
    } finally {
      setBusy(false);
    }
    // Also a credential change: a replaced client secret can invalidate the
    // tokens minted under the old one, so the tool's health is now unknown and
    // worth testing — the same rule the tool page's rows follow.
    probe.probeSaved(v.name);
  };

  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Chip>{`\${${v.name}}`}</Chip>
        <Badge
          tone={v.authorized && !v.needsReauth ? 'ok' : 'wait'}
          size="xs"
          className="shrink-0"
        >
          {/* "Signed in", not "Connected": at variable level all we know is that
              a token is stored. Only the tool page runs a probe, and only a
              probe may claim the connection works. */}
          {v.needsReauth
            ? 'Needs signing in again'
            : v.authorized
              ? 'Signed in'
              : 'Needs your sign-in'}
        </Badge>
        <Button
          variant="outline"
          size="tiny"
          className="ml-auto"
          disabled={busy || !ownerConfigured}
          title={ownerConfigured ? undefined : "The tool owner hasn't finished the sign-in setup yet."}
          onClick={() => void authorize()}
        >
          {v.authorized ? 'Reconnect' : 'Sign in'}
        </Button>
      </div>
      {v.label && <p className="mt-1 text-detail text-ink-muted">{v.label}</p>}
      {v.needsReauth && v.missingScopes && v.missingScopes.length > 0 && (
        <p className="mt-1 text-detail text-wait">Missing: {v.missingScopes.join(', ')}</p>
      )}
      {!ownerConfigured && !ownerCanWrite && (
        <p className="mt-1 text-detail text-ink-muted">
          Waiting for the tool owner to finish the sign-in setup.
        </p>
      )}
      {ownerCanWrite && (
        <div className="mt-2 border-t border-line pt-2">
          <div className="flex items-center gap-2">
            <span className="text-detail font-semibold text-ink-muted">Client secret</span>
            <Badge tone={ownerConfigured ? 'ok' : 'wait'} size="xs">
              {ownerConfigured ? 'Set' : 'Needs setup'}
            </Badge>
          </div>
          <p className="mt-0.5 text-detail text-ink-muted">
            From the OAuth app you registered with the provider. Shared by everyone, users then
            sign in themselves.
          </p>
          <div className="mt-1.5 flex gap-1.5">
            <TextField
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={ownerConfigured ? 'Replace client secret…' : 'Paste client secret…'}
              aria-label={`Client secret for ${v.name}`}
              className="min-w-0 flex-1"
            />
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !secret}
              onClick={() => void saveSecret()}
            >
              Save
            </Button>
          </div>
        </div>
      )}
      {/* What the provider made of the client secret just saved here. */}
      {probe.subject === v.name && <SavedKeyProbeResult probe={probe} className="mt-1.5" />}
      {error && (
        <p role="alert" className="mt-1 text-detail text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
