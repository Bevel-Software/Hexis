import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Banner, Button, Dialog } from '../../../../shared/components';
import {
  getMcpServer,
  putMcpServer,
  type McpServerVariable,
  type McpServerView,
  type McpTransport,
} from '../../services/tools.api';
import { pathForTool } from '../../routes/library-paths';

/**
 * The server-scoped editor for an mcp.json-backed tool — the form that
 * replaces dropping a writer into raw JSON. It shows nothing for `.tool`
 * manuals (the GET 404s: those edit as files) and renders read-only facts for
 * non-writers, whose editing surface this page has never been.
 *
 * WHAT THE FILES SAY IS WHAT THE PAGE SHOWS. One server's truth spans two
 * files (mcp.json for the portable half, plugin.json's extensions block for
 * ours), and the reader should not have to open either to know what is
 * configured: the read-only view lists every stored fact — headers, declared
 * variables, a sign-in's client id and endpoints — and the editor edits
 * exactly those, so a save changes nothing the view didn't show.
 *
 * RENAME CONFIRMS, WITH THE COST NAMED. The server's name is the namespace
 * its vault secrets bind to (`<name>_<VAR>`), so renaming disconnects every
 * configured value and completed sign-in under the old name. The page already
 * knows how many that is; the dialog says the number instead of "are you
 * sure".
 */
export function McpServerSection({
  slug,
  configuredCount,
  reloadSignal,
  onSaved,
  onError,
}: {
  slug: string;
  /** Configured secrets + sign-ins under this server's name — what a rename disconnects. */
  configuredCount: number;
  /**
   * Changes on every page reload, including one that keeps the same slug.
   * Saving a server without renaming it leaves `slug` untouched, and the page
   * no longer remounts on reload — so without this in the dependency list the
   * fetch below never re-runs and the section renders its cleared view.
   */
  reloadSignal: number;
  /** Called after a save lands; the new slug when the server was renamed. */
  onSaved(newSlug?: string): void;
  onError(message: string): void;
}) {
  const navigate = useNavigate();
  const [server, setServer] = useState<McpServerView | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingRename, setConfirmingRename] = useState(false);

  // Draft fields, seeded from the loaded view when editing opens.
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('streamable-http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [literalHeaders, setLiteralHeaders] = useState('');
  const [authHeaders, setAuthHeaders] = useState('');
  const [local, setLocal] = useState(false);
  const [variables, setVariables] = useState<McpServerVariable[]>([]);

  useEffect(() => {
    let live = true;
    getMcpServer(slug)
      .then((view) => {
        if (live) setServer(view);
      })
      .catch((err: unknown) => {
        // A 404 already came back as null (a .tool-backed manual). Anything
        // ELSE is a real failure, and vanishing silently would make it
        // indistinguishable from that expected case.
        if (live) onError(err instanceof Error ? err.message : 'Could not load the server configuration.');
      });
    return () => {
      live = false;
    };
  }, [slug, reloadSignal]);

  if (!server) return null;

  const openEditor = () => {
    setName(server.name);
    setTransport(server.transport);
    setUrl(server.url ?? '');
    setCommand(server.command ?? '');
    setArgs((server.args ?? []).join('\n'));
    setLiteralHeaders(headersToLines(server.literalHeaders));
    setAuthHeaders(headersToLines(server.authHeaders));
    setLocal(server.local);
    setVariables(server.variables);
    setEditing(true);
  };

  /**
   * A sign-in's token has to reach the server somehow — turning one on
   * pre-fills the `Authorization` header the variable loader will fill,
   * VISIBLY, in the auth-headers field the writer is already looking at.
   * Never over an Authorization header that's already there.
   */
  const suggestAuthHeader = (varName: string) => {
    if (!varName) return;
    const has = Object.keys(linesToHeaders(authHeaders)).some((h) => h.toLowerCase() === 'authorization');
    if (has) return;
    const line = `Authorization: Bearer \${${varName}}`;
    setAuthHeaders((prev) => (prev.trim() ? `${prev.replace(/\n+$/, '')}\n${line}` : line));
  };

  const save = async () => {
    const renaming = name.trim() !== server.name;
    // EVERY rename confirms: this caller's page only knows their own and the
    // shared credentials — other members' user-scoped values and sign-ins are
    // invisible here, so a zero count proves nothing about what disconnects.
    if (renaming && !confirmingRename) {
      setConfirmingRename(true);
      return;
    }
    setSaving(true);
    setConfirmingRename(false);
    try {
      const result = await putMcpServer(slug, {
        ...(renaming ? { newName: name.trim() } : {}),
        transport,
        ...(transport === 'stdio'
          ? {
              command: command.trim(),
              args: args.split('\n').map((a) => a.trim()).filter(Boolean),
              // `cwd`/`env` have no fields in this form. The PUT preserves
              // omitted fields, but echoing them as read keeps values a
              // hand-edited mcp.json carries safe on any backend semantics.
              ...(server.cwd ? { cwd: server.cwd } : {}),
              ...(server.env ? { env: server.env } : {}),
            }
          : { url: url.trim() }),
        literalHeaders: linesToHeaders(literalHeaders),
        authHeaders: linesToHeaders(authHeaders),
        variables: variables.map(normalizeVariable).filter((v) => v.name.length > 0),
        ...(server.description ? { description: server.description } : {}),
        local,
      });
      setEditing(false);
      if (result.name !== server.name) {
        // The slug IS the name — the old page no longer exists.
        navigate(pathForTool(result.name), { replace: true });
        onSaved(result.name);
      } else {
        setServer(null); // refetch on next render via onSaved's reload
        onSaved();
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="mt-8">
      <h2 className="mb-2.5 flex items-center gap-2 text-label font-semibold uppercase text-ink-faint">
        Server
        <Badge tone="outline" size="xs" className="uppercase">
          MCP server
        </Badge>
      </h2>

      {!editing && (
        <div className="flex items-start justify-between gap-4 rounded-md border border-line px-3.5 py-2.5">
          <ServerFacts server={server} />
          {server.canWrite && (
            <Button variant="outline" size="sm" onClick={openEditor}>
              Edit server
            </Button>
          )}
        </div>
      )}

      {editing && (
        <div className="flex flex-col gap-3 rounded-md border border-line px-3.5 py-3">
          <LabeledInput label="Name" value={name} onChange={setName} mono
            hint="The name is this server's secret namespace — renaming disconnects configured secrets." />
          <label className="flex flex-col gap-1 text-detail">
            <span className="font-semibold text-ink">Transport</span>
            <select
              className="rounded-md border border-line bg-white px-2.5 py-1.5 text-ui"
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpTransport)}
            >
              <option value="streamable-http">streamable-http</option>
              <option value="sse">sse (legacy)</option>
              <option value="stdio">stdio — runs on each member's machine</option>
            </select>
          </label>
          {transport === 'stdio' ? (
            <>
              <LabeledInput label="Command" value={command} onChange={setCommand} mono
                hint="A bare executable name, or a ./ path inside the plugin." />
              <LabeledTextarea label="Arguments" value={args} onChange={setArgs}
                hint="One argument per line — spaces inside an argument survive. ${PLUGIN_ROOT} and ${PLUGIN_DATA} expand at launch." />
            </>
          ) : (
            <LabeledInput label="URL" value={url} onChange={setUrl} mono />
          )}
          <LabeledTextarea label="Headers (portable)" value={literalHeaders} onChange={setLiteralHeaders}
            hint="One `Header: value` per line. Visible package data — no secrets here." />
          <LabeledTextarea label="Auth headers" value={authHeaders} onChange={setAuthHeaders}
            hint="One per line; values may use ${VAR} vault references, e.g. `Authorization: Bearer ${API_KEY}`." />
          <VariablesEditor variables={variables} onChange={setVariables} onSignInEnabled={suggestAuthHeader} />
          {transport !== 'stdio' && (
            <label className="flex items-center gap-2 text-detail text-ink-muted">
              <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
              Local-only — reachable only from a member's own machine (e.g. localhost)
            </label>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="quiet" size="sm" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {confirmingRename && (
        <Dialog open onClose={() => setConfirmingRename(false)} title="Rename this server?">
          <Banner tone="danger" role="alert" className="mb-3">
            Renaming <b>{server.name}</b> to <b>{name.trim()}</b> disconnects every secret and
            sign-in stored under the old name
            {configuredCount > 0
              ? ` — at least ${configuredCount === 1 ? 'one is' : `${configuredCount} are`} configured from your view alone, and other members' sign-ins disconnect too.`
              : " — including other members' values, which this page cannot see."}
          </Banner>
          <div className="flex justify-end gap-2">
            <Button variant="quiet" size="sm" onClick={() => setConfirmingRename(false)}>
              Keep the name
            </Button>
            <Button size="sm" onClick={() => void save()}>
              Rename anyway
            </Button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

/**
 * Everything the two files store about this server, read-only. Facts are
 * grouped the way the files split them — portable (mcp.json) first, then
 * ours (plugin.json) — so a reader can tell where an edit by hand would land.
 * Nothing is elided: a header, a declared variable, a sign-in's endpoints all
 * appear here exactly as saved, or the editor would be changing invisible state.
 */
function ServerFacts({ server }: { server: McpServerView }) {
  const literal = Object.entries(server.literalHeaders);
  const auth = Object.entries(server.authHeaders);
  return (
    <dl className="min-w-0 flex-1 text-detail text-ink-muted" aria-label="Server configuration">
      <Fact label="Transport">{server.transport}</Fact>
      {server.url && <Fact label="URL" mono>{server.url}</Fact>}
      {server.command && (
        <Fact label="Command" mono>
          {server.command} {(server.args ?? []).join(' ')}
        </Fact>
      )}
      {server.description && <Fact label="Description">{server.description}</Fact>}
      {literal.length > 0 && (
        <Fact label="Headers">
          <HeaderList entries={literal} />
        </Fact>
      )}
      {auth.length > 0 && (
        <Fact label="Auth headers">
          <HeaderList entries={auth} />
        </Fact>
      )}
      {server.variables.length > 0 && (
        <Fact label="Variables">
          <ul className="flex flex-col gap-1">
            {server.variables.map((v) => (
              <li key={v.name}>
                <code className="rounded-sm bg-sunken px-1 py-0.5 font-mono text-meta text-ink">{`\${${v.name}}`}</code>{' '}
                <span>{v.scope === 'user' ? 'each member their own' : 'one shared value'}</span>
                {v.label && <span className="text-ink-faint"> — {v.label}</span>}
                {v.oauth && <SignInFacts oauth={v.oauth} />}
              </li>
            ))}
          </ul>
        </Fact>
      )}
      {server.local && (
        <div className="mt-1 text-ink-faint">
          Runs locally — served by the local knowledge server on each member's machine, never by the workspace.
        </div>
      )}
    </dl>
  );
}

/** A declared sign-in, as stored: client id, where the endpoints come from, scopes, PKCE. */
function SignInFacts({ oauth }: { oauth: NonNullable<McpServerVariable['oauth']> }) {
  const discovered = !oauth.authorizationUrl || !oauth.tokenUrl;
  return (
    <ul className="ml-4 mt-0.5 flex list-disc flex-col gap-0.5 text-ink-faint">
      <li>
        OAuth sign-in · client id <code className="font-mono text-ink-muted">{oauth.clientId}</code>
      </li>
      <li>
        {discovered ? (
          <>Endpoints: discovered from the server</>
        ) : (
          <>
            Authorize <code className="font-mono">{oauth.authorizationUrl}</code> · Token{' '}
            <code className="font-mono">{oauth.tokenUrl}</code>
          </>
        )}
      </li>
      {oauth.scopes && oauth.scopes.length > 0 && <li>Scopes: {oauth.scopes.join(' ')}</li>}
      <li>PKCE: {oauth.pkce === false ? 'off' : 'on'}</li>
      {oauth.resource && (
        <li>
          Resource <code className="font-mono">{oauth.resource}</code>
        </li>
      )}
    </ul>
  );
}

function Fact({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 font-semibold">{label}</dt>
      <dd className={`min-w-0 ${mono ? 'truncate font-mono' : ''}`}>{children}</dd>
    </div>
  );
}

function HeaderList({ entries }: { entries: [string, string][] }) {
  return (
    <ul className="flex flex-col">
      {entries.map(([k, v]) => (
        <li key={k} className="truncate font-mono">
          {k}: {v}
        </li>
      ))}
    </ul>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  hint,
  mono,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1 text-detail">
      <span className="font-semibold text-ink">{label}</span>
      <input
        className={`rounded-md border border-line bg-white px-2.5 py-1.5 text-ui ${mono ? 'font-mono' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="text-ink-faint">{hint}</span>}
    </label>
  );
}

function LabeledTextarea({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-detail">
      <span className="font-semibold text-ink">{label}</span>
      <textarea
        className="min-h-16 rounded-md border border-line bg-white px-2.5 py-1.5 font-mono text-ui"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="text-ink-faint">{hint}</span>}
    </label>
  );
}

/**
 * Declared `${VAR}`s and who provisions each: `admin` (one shared value, set
 * by a tool writer) or `user` (each member their own, on the Connect page).
 * The names must match the `${VAR}` references in the auth headers — the vault
 * key is `<server>_<VAR>`, derived from exactly these names.
 *
 * A user-scoped variable can be an OAuth SIGN-IN instead of a typed value:
 * the owner's OAuth app's client id, endpoints discovered from the server
 * (or entered by hand for a provider that publishes none), scopes, PKCE. The
 * fields mirror the `oauth` block plugin.json stores, one to one — what an
 * agent would write into the file is what this form writes.
 */
function VariablesEditor({
  variables,
  onChange,
  onSignInEnabled,
}: {
  variables: McpServerVariable[];
  onChange(next: McpServerVariable[]): void;
  /** A sign-in was just switched on for this variable name — the parent may wire its header. */
  onSignInEnabled(varName: string): void;
}) {
  const update = (i: number, patch: Partial<McpServerVariable>) =>
    onChange(variables.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const updateOAuth = (i: number, patch: Partial<NonNullable<McpServerVariable['oauth']>>) =>
    onChange(
      variables.map((v, j) =>
        j === i && v.oauth ? { ...v, oauth: { ...v.oauth, ...patch } } : v,
      ),
    );
  return (
    <div className="flex flex-col gap-1 text-detail">
      <span className="font-semibold text-ink">Variables</span>
      {variables.map((v, i) => {
        const n = i + 1;
        const oauth = v.oauth;
        const manualEndpoints = oauth !== undefined && oauth.authorizationUrl !== undefined;
        return (
          // Index keys are correct here: rows are edited in place and have no
          // identity beyond their position until saved.
          // eslint-disable-next-line react/no-array-index-key
          <div key={i} className="flex flex-col gap-1.5 rounded-md border border-line px-2.5 py-2">
            <div className="flex items-center gap-2">
              <input
                aria-label={`Variable ${n} name`}
                className="w-40 rounded-md border border-line bg-white px-2 py-1 font-mono text-ui"
                value={v.name}
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <select
                aria-label={`Variable ${n} scope`}
                className="rounded-md border border-line bg-white px-2 py-1 text-ui"
                value={v.scope}
                onChange={(e) => {
                  const scope = e.target.value as 'admin' | 'user';
                  // A sign-in is per-caller by nature; a shared token would
                  // hand one member's grant to everyone. Dropping it here is
                  // the same rule the save enforces, made visible early.
                  const next: McpServerVariable = { ...v, scope };
                  if (scope !== 'user') delete next.oauth;
                  onChange(variables.map((x, j) => (j === i ? next : x)));
                }}
              >
                <option value="admin">admin — one shared value</option>
                <option value="user">user — each member their own</option>
              </select>
              <input
                aria-label={`Variable ${n} label`}
                className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1 text-ui"
                placeholder="Label shown in the secrets UI"
                value={v.label ?? ''}
                onChange={(e) => update(i, { label: e.target.value || undefined })}
              />
              <Button variant="quiet" size="sm" onClick={() => onChange(variables.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
            {v.scope === 'user' && (
              <label className="flex items-center gap-2 text-ink-muted">
                <input
                  type="checkbox"
                  aria-label={`Variable ${n} OAuth sign-in`}
                  checked={oauth !== undefined}
                  onChange={(e) => {
                    if (e.target.checked) {
                      update(i, { oauth: { clientId: '' } });
                      onSignInEnabled(v.name.trim());
                    } else {
                      const next = { ...v };
                      delete next.oauth;
                      onChange(variables.map((x, j) => (j === i ? next : x)));
                    }
                  }}
                />
                OAuth sign-in — members sign in with the provider instead of pasting a value
              </label>
            )}
            {oauth && (
              <div className="ml-5 flex flex-col gap-1.5 border-l-2 border-line pl-3">
                <label className="flex flex-col gap-1">
                  <span className="font-semibold text-ink">Client ID</span>
                  <input
                    aria-label={`Variable ${n} client id`}
                    className="rounded-md border border-line bg-white px-2 py-1 font-mono text-ui"
                    value={oauth.clientId}
                    onChange={(e) => updateOAuth(i, { clientId: e.target.value })}
                  />
                  <span className="text-ink-faint">
                    From the OAuth app you registered with the provider. Its client secret is
                    pasted on this page after saving — never in a file.
                  </span>
                </label>
                <div className="flex flex-col gap-1">
                  <span className="font-semibold text-ink">Endpoints</span>
                  <label className="flex items-center gap-2 text-ink-muted">
                    <input
                      type="radio"
                      name={`variable-${n}-endpoints`}
                      aria-label={`Variable ${n} endpoints discovered`}
                      checked={!manualEndpoints}
                      onChange={() => {
                        const next = { ...oauth };
                        delete next.authorizationUrl;
                        delete next.tokenUrl;
                        update(i, { oauth: next });
                      }}
                    />
                    Discover from the server (MCP servers publish them)
                  </label>
                  <label className="flex items-center gap-2 text-ink-muted">
                    <input
                      type="radio"
                      name={`variable-${n}-endpoints`}
                      aria-label={`Variable ${n} endpoints by hand`}
                      checked={manualEndpoints}
                      onChange={() =>
                        updateOAuth(i, {
                          authorizationUrl: oauth.authorizationUrl ?? '',
                          tokenUrl: oauth.tokenUrl ?? '',
                        })
                      }
                    />
                    Enter by hand (the provider publishes no OAuth metadata)
                  </label>
                  {manualEndpoints && (
                    <div className="ml-5 flex flex-col gap-1.5">
                      <input
                        aria-label={`Variable ${n} authorization URL`}
                        className="rounded-md border border-line bg-white px-2 py-1 font-mono text-ui"
                        placeholder="https://provider.example/oauth/authorize"
                        value={oauth.authorizationUrl ?? ''}
                        onChange={(e) => updateOAuth(i, { authorizationUrl: e.target.value })}
                      />
                      <input
                        aria-label={`Variable ${n} token URL`}
                        className="rounded-md border border-line bg-white px-2 py-1 font-mono text-ui"
                        placeholder="https://provider.example/oauth/token"
                        value={oauth.tokenUrl ?? ''}
                        onChange={(e) => updateOAuth(i, { tokenUrl: e.target.value })}
                      />
                    </div>
                  )}
                </div>
                <label className="flex flex-col gap-1">
                  <span className="font-semibold text-ink">Scopes</span>
                  <input
                    aria-label={`Variable ${n} scopes`}
                    className="rounded-md border border-line bg-white px-2 py-1 font-mono text-ui"
                    placeholder="space-separated, e.g. crm.objects.contacts.read"
                    value={(oauth.scopes ?? []).join(' ')}
                    onChange={(e) => {
                      // Split on save-shaped boundaries but keep the field
                      // typeable: a trailing space is a scope being started.
                      const scopes = e.target.value.split(/[\s,]+/);
                      updateOAuth(i, { scopes: scopes.length === 1 && scopes[0] === '' ? undefined : scopes });
                    }}
                  />
                </label>
                <label className="flex items-center gap-2 text-ink-muted">
                  <input
                    type="checkbox"
                    aria-label={`Variable ${n} PKCE`}
                    checked={oauth.pkce !== false}
                    onChange={(e) => {
                      const next = { ...oauth };
                      if (e.target.checked) delete next.pkce;
                      else next.pkce = false;
                      update(i, { oauth: next });
                    }}
                  />
                  PKCE (S256) — required by MCP servers; harmless for providers that ignore it
                </label>
              </div>
            )}
          </div>
        );
      })}
      <div>
        <Button variant="outline" size="sm" onClick={() => onChange([...variables, { name: '', scope: 'admin' }])}>
          Add variable
        </Button>
      </div>
      <span className="text-ink-faint">
        Names must match the {'`${VAR}`'} references in the auth headers; secrets are stored under{' '}
        <code>&lt;server&gt;_&lt;VAR&gt;</code>.
      </span>
    </div>
  );
}

/**
 * The stored shape of one row: trimmed, empties dropped, the sign-in's
 * endpoints sent as typed (a half pair is the backend's 422 to give, not
 * something to silently complete or discard here).
 */
function normalizeVariable(v: McpServerVariable): McpServerVariable {
  const label = v.label?.trim();
  const base: McpServerVariable = { name: v.name.trim(), scope: v.scope, ...(label ? { label } : {}) };
  if (!v.oauth || v.scope !== 'user') return base;
  const o = v.oauth;
  const authorizationUrl = o.authorizationUrl?.trim();
  const tokenUrl = o.tokenUrl?.trim();
  const scopes = (o.scopes ?? []).map((s) => s.trim()).filter(Boolean);
  return {
    ...base,
    oauth: {
      ...(authorizationUrl ? { authorizationUrl } : {}),
      ...(tokenUrl ? { tokenUrl } : {}),
      clientId: o.clientId.trim(),
      ...(scopes.length > 0 ? { scopes } : {}),
      ...(o.authParams ? { authParams: o.authParams } : {}),
      ...(o.pkce === false ? { pkce: false } : {}),
      ...(o.resource ? { resource: o.resource } : {}),
    },
  };
}

function headersToLines(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}

function linesToHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}
