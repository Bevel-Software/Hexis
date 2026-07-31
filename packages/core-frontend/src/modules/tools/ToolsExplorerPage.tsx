import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JsonSchema, Tool as UtcpTool } from '@utcp/sdk';
import { authFetch } from '../../lib/api';

/**
 * A read-only explorer for the tools Bevel exposes to external agents — it
 * fetches the UTCP manual and renders every tool: its description, transport
 * (HTTP path / streaming / whatever the call template says), input + output
 * schemas, and a one-line "how to call" note. No in-browser runner: tools span
 * transports (HTTP, MCP, streaming, …) and we don't reimplement a UTCP client
 * here — invoke them via a real UTCP client or the MCP server.
 *
 * The page lives behind the app login (see `AuthGate` in `App.tsx`). By default
 * it loads the catalog with the user's SESSION: `GET /api/agent/utcp` accepts a
 * browser JWT for this read-only manual (a spec, no secrets), so a logged-in user
 * browses with zero pasting and nothing write-scoped or bearer-portable ever
 * reaches the browser. The optional key box below hits the SAME endpoint with a
 * pasted `<tenant>_…` external API key instead — useful for verifying exactly what a
 * specific key can see. (Internal `<tenant>-int_…` tokens are server-minted for the
 * agent's loopback and never surfaced to users, so the UI doesn't offer them.)
 * Tool EXECUTION is unchanged: it always requires a key / internal token at the
 * tool endpoints (a JWT is admitted on the manual only, never to invoke a tool).
 */

/**
 * `${API_URL}/api/agent/tools/x` → `/api/agent/tools/x`; undefined unless this is
 * an http tool pointing at a path on this server. The base `CallTemplate` from
 * the SDK only guarantees `call_template_type`; the http variant's `url` /
 * `http_method` ride its open index signature, so we read them under the
 * `'http'` guard without coupling the page to `@utcp/http`. Non-http transports
 * (MCP, streaming, …) fall through to undefined and render the generic note.
 */
function httpPath(t: UtcpTool): { method: string; path: string } | undefined {
  const tpl = t.tool_call_template;
  if (tpl?.call_template_type !== 'http') return undefined;
  const url = typeof tpl.url === 'string' ? tpl.url : undefined;
  if (!url) return undefined;
  const path = url.replace(/^\$\{API_URL\}/, '');
  if (!path.startsWith('/')) return undefined;
  const method = typeof tpl.http_method === 'string' ? tpl.http_method : 'POST';
  return { method: method.toUpperCase(), path };
}

/** A schema's item shape; the SDK types `items` as `JsonSchema | JsonSchema[]`, so collapse to one. */
function itemSchema(s: JsonSchema): JsonSchema | undefined {
  return Array.isArray(s.items) ? s.items[0] : s.items;
}

/** Unwrap the `{ body: <flat> }` envelope the manual adds — the real request body is the flat schema. */
function unwrapBody(inputs: JsonSchema): JsonSchema {
  return inputs?.properties?.body ?? inputs;
}

function typeLabel(s: JsonSchema): string {
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : s.type ?? 'any';
  const item = itemSchema(s);
  if (t === 'array' && item) return `${typeLabel(item)}[]`;
  return t;
}

/** A runnable placeholder value for a field, so the example body is copy-and-edit-ready. */
function sampleValue(s: JsonSchema): unknown {
  if (s.enum && s.enum.length) return s.enum[0];
  const t = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (t) {
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'array': {
      const item = itemSchema(s);
      return item ? [sampleValue(item)] : [];
    }
    case 'object':
      return sampleBody(s);
    default:
      return `<${typeLabel(s)}>`;
  }
}

/** Build a skeleton request body from an (already-unwrapped) input schema. */
function sampleBody(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(schema.properties ?? {})) out[name] = sampleValue(sub);
  return out;
}

/**
 * A ready-to-run curl for an HTTP tool. The manual carries `${API_URL}` /
 * `${CONNECTION_KEY}` placeholders; we resolve the URL to THIS server's origin
 * and leave the key as a `$Bevel_KEY` shell var. The request body is the flat
 * input (the def's `body_field: 'body'` rides the `body` arg's value straight
 * into the JSON body), so the example is the unwrapped input schema, not the
 * `{ body: … }` envelope.
 */
function curlSnippet(http: { method: string; path: string }, input: JsonSchema): string {
  const url = `${window.location.origin}${http.path}`;
  const body = JSON.stringify(sampleBody(input), null, 2);
  return [
    `curl -X ${http.method} '${url}' \\`,
    `  -H 'Authorization: Bearer '"$Bevel_KEY" \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '${body}'`,
  ].join('\n');
}

function CopyButton({ text }: { text: string }) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset to 'idle' after a delay, cancelling any pending reset first so rapid
  // clicks don't queue overlapping timers.
  const scheduleReset = () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus('idle'), 1500);
  };

  // Clear a pending timer on unmount so it never fires after teardown.
  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  return (
    <button
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setStatus('copied');
            scheduleReset();
          })
          .catch(() => {
            // Clipboard can reject (insecure context / denied permission) — surface
            // it on the button instead of silently swallowing the rejection.
            setStatus('failed');
            scheduleReset();
          });
      }}
      className="text-[10px] font-medium px-2 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
    >
      {status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy'}
    </button>
  );
}

function SchemaView({ schema, depth = 0 }: { schema: JsonSchema; depth?: number }) {
  const props = schema.properties;
  if (!props || Object.keys(props).length === 0) {
    return <div className="text-xs text-slate-400 italic">no fields</div>;
  }
  const required = new Set(schema.required ?? []);
  return (
    <div className={depth > 0 ? 'pl-3 border-l border-slate-200 space-y-1.5' : 'space-y-1.5'}>
      {Object.entries(props).map(([name, sub]) => (
        <div key={name} className="text-xs">
          <div className="flex items-baseline gap-2 flex-wrap">
            <code className="font-medium text-slate-800">{name}</code>
            <span className="text-slate-400 font-mono">{typeLabel(sub)}</span>
            {required.has(name) ? (
              <span className="text-[10px] uppercase tracking-wide text-amber-600">required</span>
            ) : (
              <span className="text-[10px] uppercase tracking-wide text-slate-300">optional</span>
            )}
          </div>
          {sub.description && <div className="text-slate-500 leading-snug mt-0.5">{sub.description}</div>}
          {sub.type === 'object' && sub.properties && <SchemaView schema={sub} depth={depth + 1} />}
          {sub.type === 'array' && itemSchema(sub)?.properties && (
            <SchemaView schema={itemSchema(sub)!} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}

function ToolCard({ tool }: { tool: UtcpTool }) {
  const [open, setOpen] = useState(false);
  const http = httpPath(tool);
  const input = unwrapBody(tool.inputs);
  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <button onClick={() => setOpen((v) => !v)} className="w-full text-left px-4 py-3 flex items-start gap-3">
        <span className="text-slate-300 mt-0.5">{open ? '▾' : '▸'}</span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2 flex-wrap">
            <code className="text-sm font-semibold text-slate-800">{tool.name}</code>
            <span className="text-[10px] font-mono uppercase tracking-wide text-slate-400">
              {http ? `${http.method} ${http.path}` : tool.tool_call_template?.call_template_type ?? 'unknown'}
            </span>
            {tool.tags?.map((t) => (
              <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{t}</span>
            ))}
          </span>
          <span className="block text-xs text-slate-500 leading-snug mt-1 line-clamp-2">{tool.description}</span>
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-slate-100">
          <p className="text-xs text-slate-600 leading-snug whitespace-pre-wrap">{tool.description}</p>
          <section>
            <h4 className="text-xs font-semibold text-slate-700 mb-1.5">Input</h4>
            <SchemaView schema={input} />
          </section>
          {tool.outputs && (
            <section>
              <h4 className="text-xs font-semibold text-slate-700 mb-1.5">Output</h4>
              <SchemaView schema={tool.outputs} />
            </section>
          )}
          <section>
            <h4 className="text-xs font-semibold text-slate-700 mb-1.5">How to call</h4>
            {http ? (
              <div className="space-y-2">
                <p className="text-xs text-slate-500 leading-snug">
                  <code className="text-emerald-700 font-semibold">{http.method}</code>{' '}
                  <code className="text-slate-600">{http.path}</code> with{' '}
                  <code className="text-slate-600">Authorization: Bearer &lt;key&gt;</code> and the input above as the JSON
                  body. Or call it through any UTCP client / the MCP server at <code>/api/mcp</code>.
                </p>
                <div className="relative">
                  <div className="absolute top-1.5 right-1.5">
                    <CopyButton text={curlSnippet(http, input)} />
                  </div>
                  <pre className="text-[11px] font-mono text-slate-700 bg-slate-50 border border-slate-200 rounded p-2.5 overflow-auto whitespace-pre">
                    {curlSnippet(http, input)}
                  </pre>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500 leading-snug">
                Transport <code>{tool.tool_call_template?.call_template_type ?? 'unknown'}</code> — invoke it with a UTCP
                client (or via the MCP server at <code>/api/mcp</code>), not a plain HTTP request.
              </p>
            )}
          </section>
          <section>
            <div className="flex items-center justify-between mb-1.5">
              <h4 className="text-xs font-semibold text-slate-700">Raw UTCP schema</h4>
              <CopyButton text={JSON.stringify(tool, null, 2)} />
            </div>
            <p className="text-[11px] text-slate-400 leading-snug mb-1.5">
              The full tool definition served by <code>/api/agent/utcp</code> — inputs, outputs and the{' '}
              <code>tool_call_template</code> (endpoint, method, headers, body wrapping). Resolve{' '}
              <code>${'{API_URL}'}</code> to this server&apos;s origin and <code>${'{CONNECTION_KEY}'}</code> to your{' '}
              <code>{'<tenant>_…'}</code> key to call it from a script.
            </p>
            <pre className="text-[11px] font-mono text-slate-700 bg-slate-50 border border-slate-200 rounded p-2.5 overflow-auto whitespace-pre max-h-80">
              {JSON.stringify(tool, null, 2)}
            </pre>
          </section>
        </div>
      )}
    </div>
  );
}

export function ToolsExplorerPage() {
  const [bearer, setBearer] = useState('');
  const [tools, setTools] = useState<UtcpTool[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    if (!bearer.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/agent/utcp', { headers: { Authorization: `Bearer ${bearer.trim()}` } });
      if (!r.ok) {
        setError(`Could not load the catalog (HTTP ${r.status}). Check your external API key.`);
        setTools(null);
        return;
      }
      const manual = (await r.json()) as { tools?: UtcpTool[] };
      setTools(manual.tools ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTools(null);
    } finally {
      setLoading(false);
    }
  }, [bearer]);

  // Default load: the read-only manual gated by the user's own session (the same
  // `/api/agent/utcp` endpoint also accepts a browser JWT) — no key to paste, no
  // write-scoped/portable credential in the browser.
  const loadViaSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch('/api/agent/utcp');
      if (!r.ok) {
        setError(`Could not load the catalog (HTTP ${r.status}).`);
        setTools(null);
        return;
      }
      const manual = (await r.json()) as { tools?: UtcpTool[] };
      setTools(manual.tools ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setTools(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadViaSession();
  }, [loadViaSession]);

  const shown = useMemo(() => {
    if (!tools) return [];
    const q = filter.trim().toLowerCase();
    return q
      ? tools.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || (t.tags ?? []).some((x) => x.toLowerCase().includes(q)))
      : tools;
  }, [tools, filter]);

  return (
    <div className="h-full overflow-auto bg-slate-50">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold text-slate-800">Bevel tools</h1>
          <p className="text-sm text-slate-500">
            Every tool Bevel exposes to external agents — the same surface available over MCP at{' '}
            <code className="text-slate-600">/api/mcp</code>. Loaded with your session below; or browse as a specific
            external API key to see exactly what it can reach.
          </p>
        </header>

        <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2">
          <label className="block text-xs font-medium text-slate-700">
            Browse as a specific external API key (<code>{'<tenant>_…'}</code>) — optional
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={bearer}
              onChange={(e) => setBearer(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !loading && void load()}
              placeholder="<tenant>_…"
              spellCheck={false}
              className="flex-1 text-xs font-mono border border-slate-200 rounded px-2 py-1.5 text-slate-800"
            />
            <button
              onClick={() => void load()}
              disabled={loading || !bearer.trim()}
              className="text-xs font-medium px-3 py-1.5 rounded bg-slate-800 text-white disabled:opacity-40"
            >
              {loading ? 'Loading…' : 'Load'}
            </button>
          </div>
          {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">{error}</div>}
        </div>

        {tools && (
          <>
            <div className="flex items-center justify-between">
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter tools…"
                className="text-xs border border-slate-200 rounded px-2 py-1.5 text-slate-800 w-56"
              />
              <span className="text-xs text-slate-400">{shown.length} of {tools.length} tools</span>
            </div>
            <div className="space-y-2">
              {shown.map((t) => (
                <ToolCard key={t.name} tool={t} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
