import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plug, RefreshCw, ShieldCheck, ExternalLink, Wrench, Check, ArrowRight } from 'lucide-react';
import { pathForTool } from '../../library/routes/library-paths';
import { startOAuth } from '../services/secrets.api';
import { setUserVar, deleteUserVar } from '../services/tool-secrets.api';
import {
  getConnectPending,
  startToolOAuth,
  getMcpOAuthRequest,
  completeMcpOAuth,
  type ConnectTool,
  type ConnectOAuth,
  type ConnectToolOAuth,
} from '../services/connect.api';

/**
 * Persisted copy of the external-agent authorization state (`?oauth=<state>`).
 * A tool sign-in mid-flow bounces the browser to the provider and back, which
 * strips the query string — the session copy is what keeps the Finish flow
 * alive across that round-trip. Cleared on Finish or when the state goes stale.
 */
const MCP_OAUTH_STATE_KEY = 'mcp-oauth-state';

/**
 * "Connect your tools" — the page a person lands on from the needs-authorization
 * link surfaced by their external agent. It consolidates every per-user
 * credential they still owe across all the tools they can reach: an input for
 * each personal API key, an "Authorize" button for each OAuth sign-in. Shared
 * (owner-set) values are intentionally not shown here — they are the admin's job.
 *
 * Two modes:
 *  - Plain (default): configure credentials, go back to the agent by hand.
 *  - Agent-connect (`?oauth=<state>`): an external agent is waiting on the
 *    other end of an authorization flow. Each tool gets an include/skip
 *    toggle — skipping wipes its saved per-user credentials so the tool won't
 *    be available to the agent — and a Finish button completes the flow and
 *    sends the browser back to the agent.
 */
export function ConnectToolsPage() {
  const [tools, setTools] = useState<ConnectTool[]>([]);
  const [oauth, setOauth] = useState<ConnectOAuth[]>([]);
  const [toolOAuth, setToolOAuth] = useState<ConnectToolOAuth[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Agent-connect mode: the signed authorization state + who is asking.
  const [agentState, setAgentState] = useState<string | null>(null);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  // Entries the user explicitly ticked while still unconfigured (reveals the
  // inputs). Configured entries are implicitly ticked; unticking one wipes it.
  const [included, setIncluded] = useState<Set<string>>(new Set());
  const [wiping, setWiping] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const pending = await getConnectPending();
      setTools(pending.tools);
      setOauth(pending.oauth);
      setToolOAuth(pending.toolOAuth);
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

  // Pick up (and persist) the external-agent authorization state.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('oauth');
    if (fromUrl) {
      sessionStorage.setItem(MCP_OAUTH_STATE_KEY, fromUrl);
      setAgentState(fromUrl);
    } else {
      setAgentState(sessionStorage.getItem(MCP_OAUTH_STATE_KEY));
    }
  }, []);

  // Resolve who is asking; a stale/expired state silently drops the mode (the
  // agent restarts the flow if the user takes too long).
  useEffect(() => {
    if (!agentState) return;
    let cancelled = false;
    getMcpOAuthRequest(agentState)
      .then((r) => {
        if (!cancelled) setAgentName(r.clientName);
      })
      .catch(() => {
        if (cancelled) return;
        sessionStorage.removeItem(MCP_OAUTH_STATE_KEY);
        setAgentState(null);
        setAgentName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [agentState]);

  // Surface the OAuth-callback outcome carried in the URL fragment (same contract
  // the Secrets page uses — the callback lands on whichever page started it).
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.has('authorized')) setNotice('Connected. You can go back to your agent and try again.');
    else if (params.has('error')) setError(params.get('error') || 'Authorization failed.');
    if (params.has('authorized') || params.has('error')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }, []);

  const onAuthorize = async (id: string) => {
    try {
      const url = await startOAuth(id);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onAuthorizeTool = async (slug: string, varName: string) => {
    try {
      const url = await startToolOAuth(slug, varName);
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onFinish = async () => {
    if (!agentState) return;
    setFinishing(true);
    try {
      const redirectTo = await completeMcpOAuth(agentState);
      sessionStorage.removeItem(MCP_OAUTH_STATE_KEY);
      window.location.href = redirectTo;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setFinishing(false);
    }
  };

  /**
   * Include/skip toggle. `id` keys the local opt-in set; `configured` says
   * whether any per-user value exists; `wipe` removes them all. Unticking a
   * configured entry wipes it (that's what "skip" means — the tool must not
   * register for the agent); unticking an unconfigured one just hides inputs.
   */
  const onToggle = async (id: string, configured: boolean, wipe: () => Promise<void>) => {
    const isOn = configured || included.has(id);
    if (!isOn) {
      setIncluded((s) => new Set(s).add(id));
      return;
    }
    setIncluded((s) => {
      const nextSet = new Set(s);
      nextSet.delete(id);
      return nextSet;
    });
    if (configured) {
      setWiping((s) => new Set(s).add(id));
      try {
        await wipe();
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setWiping((s) => {
          const nextSet = new Set(s);
          nextSet.delete(id);
          return nextSet;
        });
      }
    }
  };

  const agentMode = agentState != null;
  const toolId = (t: ConnectTool) => `tool:${t.slug}`;
  const signInId = (o: ConnectToolOAuth) => `signin:${o.key}`;
  const toolConfigured = (t: ConnectTool) => t.variables.some((v) => v.configured);
  const isIncluded = (id: string, configured: boolean) => configured || included.has(id);

  // Outstanding counts only what the user is actually including — a skipped
  // tool owes nothing.
  const outstanding =
    tools.reduce(
      (n, t) =>
        isIncluded(toolId(t), toolConfigured(t))
          ? n + t.variables.filter((v) => !v.configured).length
          : n,
      0,
    ) +
    oauth.filter((o) => !o.authorized).length +
    // Not-yet-connected OR connected-but-under-scoped (needs reconnect) both count.
    toolOAuth.filter(
      (o) => isIncluded(signInId(o), o.authorized) && (!o.authorized || o.needsReauth),
    ).length;
  const nothingToDo =
    !loading && tools.length === 0 && oauth.length === 0 && toolOAuth.length === 0;

  return (
    <div className="flex h-full flex-col bg-white">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
        <Plug size={16} className="text-ink-muted" />
        <h1 className="text-sm font-semibold text-ink">Connect your tools</h1>
        <button
          onClick={() => void refresh()}
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-ink-muted hover:bg-hover"
        >
          <RefreshCw size={12} /> Refresh
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {agentMode && (
          <div className="mb-4 flex max-w-2xl items-center gap-3 rounded border border-blue-200 bg-blue-50 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-blue-900">
                {agentName ? `“${agentName}” wants to connect` : 'An external agent wants to connect'}
              </div>
              <div className="mt-0.5 text-[11px] text-blue-800">
                Choose which tools it may use. Skipping a tool removes your saved keys and sign-ins
                for it. When you're done, finish to send it back to your agent.
              </div>
            </div>
            <button
              onClick={() => void onFinish()}
              disabled={finishing}
              className="flex shrink-0 items-center gap-1 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {finishing ? 'Finishing…' : 'Finish & return to your agent'} <ArrowRight size={12} />
            </button>
          </div>
        )}

        {error && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</div>
        )}
        {notice && (
          <div className="mb-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
            {notice}
          </div>
        )}

        {!nothingToDo && (
          <p className="mb-4 max-w-2xl text-xs text-ink-muted">
            These tools need your own sign-in or keys before they will work in your agent. Authorize each connection and
            enter any keys below, then head back to your agent and run the tool again. Your values are stored securely and
            never shown again after saving.
          </p>
        )}

        {loading ? (
          <div className="text-xs text-ink-faint">Loading…</div>
        ) : nothingToDo ? (
          agentMode ? (
            // In agent-connect mode an empty list is SUCCESS, not absence:
            // every shared tool works without a personal credential, so the
            // user's only job is to finish.
            <div className="flex max-w-2xl items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              <Check size={13} /> You're all set — none of your tools need a personal sign-in or
              key. Click “Finish &amp; return to your agent” above to complete the connection.
            </div>
          ) : (
            <div className="rounded border border-dashed border-line px-4 py-6 text-center text-xs text-ink-faint">
              You have no tools that need a personal sign-in or key.
            </div>
          )
        ) : (
          <>
            {outstanding === 0 && (
              <div className="mb-4 flex max-w-2xl items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                <Check size={13} /> Everything is connected. You can use your tools in your agent.
              </div>
            )}

            {(toolOAuth.length > 0 || oauth.length > 0) && (
              <section className="mb-6 max-w-2xl">
                <h2 className="mb-2 text-xs font-semibold text-ink">Sign-ins</h2>
                <ul className="divide-y divide-line rounded border border-line">
                  {/* OAuth-backed tool variables — authorized via the tool-scoped flow. */}
                  {toolOAuth.map((o) => {
                    const id = signInId(o);
                    const on = isIncluded(id, o.authorized);
                    const busy = wiping.has(id);
                    return (
                      <li key={o.key} className="flex items-center gap-3 px-3 py-2">
                        <IncludeToggle
                          on={on}
                          busy={busy}
                          onChange={() => void onToggle(id, o.authorized, () => deleteUserVar(o.slug, o.varName))}
                        />
                        {/* The label names the SIGN-IN; the link goes to the
                            tool that declared it, which is what the accessible
                            name has to say. */}
                        <Link
                          to={pathForTool(o.slug)}
                          aria-label={`Open ${o.toolName}`}
                          className={`text-xs font-medium hover:underline ${on ? 'text-ink' : 'text-ink-faint'}`}
                        >
                          {o.label || o.toolName}
                        </Link>
                        {on ? (
                          o.needsReauth ? (
                            <span className="text-[11px] text-amber-600">new permissions needed</span>
                          ) : o.authorized ? (
                            <span className="flex items-center gap-1 text-[11px] text-emerald-600">
                              <ShieldCheck size={12} /> connected
                            </span>
                          ) : (
                            <span className="text-[11px] text-amber-600">not connected</span>
                          )
                        ) : (
                          <span className="text-[11px] text-ink-faint">skipped</span>
                        )}
                        {on && (
                          <button
                            onClick={() => void onAuthorizeTool(o.slug, o.varName)}
                            className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                          >
                            <ExternalLink size={12} /> {o.authorized ? 'Reconnect' : 'Authorize'}
                          </button>
                        )}
                      </li>
                    );
                  })}
                  {/* Standalone OAuth secrets (registered directly, not via a tool). */}
                  {oauth.map((o) => (
                    <li key={o.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="text-xs font-medium text-ink">{o.label || o.key}</span>
                      {o.authorized ? (
                        <span className="flex items-center gap-1 text-[11px] text-emerald-600">
                          <ShieldCheck size={12} /> connected
                        </span>
                      ) : (
                        <span className="text-[11px] text-amber-600">not connected</span>
                      )}
                      <button
                        onClick={() => void onAuthorize(o.id)}
                        className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                      >
                        <ExternalLink size={12} /> {o.authorized ? 'Reconnect' : 'Authorize'}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {tools.length > 0 && (
              <section className="max-w-2xl">
                <h2 className="mb-2 text-xs font-semibold text-ink">Keys</h2>
                <ul className="space-y-3">
                  {tools.map((tool) => {
                    const id = toolId(tool);
                    const configured = toolConfigured(tool);
                    const on = isIncluded(id, configured);
                    const busy = wiping.has(id);
                    return (
                      <li key={tool.slug} className="rounded border border-line p-3">
                        <div className="mb-2 flex items-center gap-2">
                          <IncludeToggle
                            on={on}
                            busy={busy}
                            onChange={() =>
                              void onToggle(id, configured, async () => {
                                for (const v of tool.variables.filter((x) => x.configured)) {
                                  await deleteUserVar(tool.slug, v.name);
                                }
                              })
                            }
                          />
                          <Wrench size={13} className={on ? 'text-ink-muted' : 'text-ink-faint'} />
                          <Link
                            to={pathForTool(tool.slug)}
                            aria-label={`Open ${tool.name}`}
                            className={`text-xs font-semibold hover:underline ${on ? 'text-ink' : 'text-ink-faint'}`}
                          >
                            {tool.name}
                          </Link>
                          {!on && <span className="text-[11px] text-ink-faint">skipped</span>}
                        </div>
                        {on && (
                          <ul className="space-y-2">
                            {tool.variables.map((v) => (
                              <KeyRow
                                key={v.key}
                                slug={tool.slug}
                                name={v.name}
                                label={v.label}
                                configured={v.configured}
                                onSaved={() => void refresh()}
                                onError={setError}
                              />
                            ))}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Include/skip checkbox for a tool or sign-in row. */
function IncludeToggle({
  on,
  busy,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  onChange: () => void;
}) {
  return (
    <input
      type="checkbox"
      checked={on}
      disabled={busy}
      onChange={onChange}
      title={on ? 'Skip this tool (removes your saved keys and sign-ins for it)' : 'Include this tool'}
      aria-label={on ? 'Skip this tool (removes your saved keys and sign-ins for it)' : 'Include this tool'}
      className="h-3.5 w-3.5 shrink-0 accent-blue-600 disabled:opacity-40"
    />
  );
}

function KeyRow({
  slug,
  name,
  label,
  configured,
  onSaved,
  onError,
}: {
  slug: string;
  name: string;
  label: string | null;
  configured: boolean;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await setUserVar(slug, name, value.trim());
      setValue('');
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-xs text-ink-muted">{label || name}</span>
        {configured ? (
          <span className="flex items-center gap-1 text-[11px] text-emerald-600">
            <Check size={11} /> set
          </span>
        ) : (
          <span className="text-[11px] text-amber-600">not set</span>
        )}
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={configured ? 'Replace…' : 'Enter value'}
        className="w-40 rounded border border-line-strong px-2 py-1 text-xs focus:border-accent focus:outline-none"
      />
      <button
        onClick={() => void save()}
        disabled={busy || !value.trim()}
        className="rounded bg-ink px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
      >
        Save
      </button>
    </li>
  );
}
