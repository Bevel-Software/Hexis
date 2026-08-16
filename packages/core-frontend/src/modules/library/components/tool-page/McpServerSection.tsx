import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Banner, Button, Dialog } from '../../../../shared/components';
import {
  getMcpServer,
  putMcpServer,
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
 * RENAME CONFIRMS, WITH THE COST NAMED. The server's name is the namespace
 * its vault secrets bind to (`<name>_<VAR>`), so renaming disconnects every
 * configured value and completed sign-in under the old name. The page already
 * knows how many that is; the dialog says the number instead of "are you
 * sure".
 */
export function McpServerSection({
  slug,
  configuredCount,
  onSaved,
  onError,
}: {
  slug: string;
  /** Configured secrets + sign-ins under this server's name — what a rename disconnects. */
  configuredCount: number;
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
  const [variables, setVariables] = useState<McpServerView['variables']>([]);

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
  }, [slug]);

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
          ? { command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean) }
          : { url: url.trim() }),
        literalHeaders: linesToHeaders(literalHeaders),
        authHeaders: linesToHeaders(authHeaders),
        variables: variables
          .map((v) => ({ ...v, name: v.name.trim(), label: v.label?.trim() || undefined }))
          .filter((v) => v.name.length > 0),
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
          <dl className="min-w-0 text-detail text-ink-muted">
            <div className="flex gap-2">
              <dt className="shrink-0 font-semibold">Transport</dt>
              <dd>{server.transport}</dd>
            </div>
            {server.url && (
              <div className="flex gap-2">
                <dt className="shrink-0 font-semibold">URL</dt>
                <dd className="truncate">{server.url}</dd>
              </div>
            )}
            {server.command && (
              <div className="flex gap-2">
                <dt className="shrink-0 font-semibold">Command</dt>
                <dd className="truncate">
                  {server.command} {(server.args ?? []).join(' ')}
                </dd>
              </div>
            )}
            {server.local && (
              <div className="mt-1 text-ink-faint">
                Runs locally — served by hexis-mcp on each member's machine, never by the workspace.
              </div>
            )}
          </dl>
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
          <VariablesEditor variables={variables} onChange={setVariables} />
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
 */
function VariablesEditor({
  variables,
  onChange,
}: {
  variables: McpServerView['variables'];
  onChange(next: McpServerView['variables']): void;
}) {
  const update = (i: number, patch: Partial<McpServerView['variables'][number]>) =>
    onChange(variables.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <div className="flex flex-col gap-1 text-detail">
      <span className="font-semibold text-ink">Variables</span>
      {variables.map((v, i) => (
        // Index keys are correct here: rows are edited in place and have no
        // identity beyond their position until saved.
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="flex items-center gap-2">
          <input
            aria-label={`Variable ${i + 1} name`}
            className="w-40 rounded-md border border-line bg-white px-2 py-1 font-mono text-ui"
            value={v.name}
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <select
            aria-label={`Variable ${i + 1} scope`}
            className="rounded-md border border-line bg-white px-2 py-1 text-ui"
            value={v.scope}
            onChange={(e) => update(i, { scope: e.target.value as 'admin' | 'user' })}
          >
            <option value="admin">admin — one shared value</option>
            <option value="user">user — each member their own</option>
          </select>
          <input
            aria-label={`Variable ${i + 1} label`}
            className="min-w-0 flex-1 rounded-md border border-line bg-white px-2 py-1 text-ui"
            placeholder="Label shown in the secrets UI"
            value={v.label ?? ''}
            onChange={(e) => update(i, { label: e.target.value || undefined })}
          />
          <Button variant="quiet" size="sm" onClick={() => onChange(variables.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
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
