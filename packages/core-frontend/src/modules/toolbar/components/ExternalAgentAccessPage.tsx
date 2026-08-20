import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Wrench, ExternalLink } from 'lucide-react';
import { Dialog } from '../../../shared/components/Dialog';
import { PageShell } from '../../../shared/components/PageShell';
import { buttonClasses } from '../../../shared/components';
import {
  ConnectionInstructions,
  CopyBlock,
  claudeCodeCommand,
  hexisMcpClaudeCommand,
  hexisMcpJsonSnippet,
  jsonConfigSnippet,
  langdockSnippet,
  mcpEndpointUrl,
  useCopyFeedback,
  workspaceBaseUrl,
} from '../../../shared/mcp';
import {
  type ExternalApiKeySummary,
  type MintedExternalApiKey,
  createExternalApiKey,
  deleteExternalApiKey,
  disconnectExternalApiKey,
  listExternalApiKeys,
} from '../services/external-api-keys.api';

const MAX_LABEL_LEN = 200;

function formatRelative(ts: number | null): string {
  if (ts === null) return 'never';
  const diff = Date.now() - ts;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(ts).toLocaleDateString();
}

/**
 * The External agent access page, routed standalone at
 * `/external-agent-access` (below the persistent toolbar), in two tabs:
 *
 *  - "Your agent" (default) — connecting the user's own interactive agent
 *    (Claude Code, Claude Desktop, Cursor…). No key: the agent gets only the
 *    server URL, and on first connect the browser opens our authorization
 *    flow (sign in + choose tools on /connect). Copy-paste configs only.
 *  - "Autonomous agents" — the external-API-key surface for pipelines/CI
 *    that can't open a browser: lists existing keys, mints new ones,
 *    disconnects revoked ones, permanently deletes disconnected ones. The
 *    plaintext of a minted key is only shown once — there is no read-it-back
 *    endpoint.
 *
 * Glossary terms used in copy: "External API key", "Disconnect" (= revoke),
 * "External agent" (= MCP client). See docs/glossary.md.
 */
export function ExternalAgentAccessPage() {
  const labelInputId = useId();

  /**
   * What this deployment says its own address is. Read ONCE here and threaded
   * down, so the interactive tab and the key-bearing snippets in the reveal
   * modal cannot end up quoting different servers — which is exactly what
   * happened while six separate sites each rebuilt it from
   * `window.location.origin`.
   */
  const mcpUrl = mcpEndpointUrl();

  /**
   * The LOCAL server's address is the one exception to "everything quotes
   * `mcpUrl`": `hexis-mcp` takes the workspace's base and resolves the MCP
   * endpoint from it itself, so handing it the endpoint would be wrong twice
   * over. See `workspaceBaseUrl` for why the origin is the right base.
   */
  const workspaceUrl = workspaceBaseUrl();

  const [tab, setTab] = useState<'agent' | 'autonomous'>('agent');
  const [keys, setKeys] = useState<ExternalApiKeySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // The plaintext of a freshly minted key. Held in state for the lifetime
  // of the reveal modal — never persisted, and cleared when the user
  // dismisses the reveal step.
  const [reveal, setReveal] = useState<MintedExternalApiKey | null>(null);
  const { copied, copy } = useCopyFeedback();

  // The disconnected key awaiting a permanent-delete confirmation. Non-null
  // drives the themed confirm Dialog below; `deleting` keeps the request in
  // flight so the confirm can't be dismissed mid-delete.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setKeys(await listExternalApiKeys());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load external API keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LEN || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const minted = await createExternalApiKey(trimmed);
      setReveal(minted);
      setLabel('');
      // Optimistic-ish: refresh the list so the new row shows up underneath
      // the reveal modal.
      void refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Couldn't create external API key.");
    } finally {
      setCreating(false);
    }
  }

  async function handleDisconnect(id: string) {
    try {
      await disconnectExternalApiKey(id);
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't disconnect this key.");
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    try {
      await deleteExternalApiKey(pendingDelete.id);
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't delete this key.");
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }

  const trimmed = label.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_LABEL_LEN && !creating;

  // Surface the keys that matter: active keys first (most-recently-used at the
  // top, never-used ones last among the active), with disconnected keys sunk
  // to the bottom. Non-destructive — nothing is hidden or deleted, just ordered
  // so a long list of stale/test keys doesn't bury the ones in use.
  const sortedKeys = [...keys].sort((a, b) => {
    const aRevoked = a.revokedAt !== null;
    const bRevoked = b.revokedAt !== null;
    if (aRevoked !== bRevoked) return aRevoked ? 1 : -1;
    return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
  });

  return (
    <>
      <PageShell title="External agent access" padded={false}>
        <div className="flex border-b border-line px-4 shrink-0" role="tablist">
          {(
            [
              ['agent', 'Your agent'],
              ['autonomous', 'Autonomous agents'],
            ] as const
          ).map(([id, name]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px ${
                tab === id
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-muted hover:text-ink'
              }`}
            >
              {name}
            </button>
          ))}
        </div>

        {tab === 'agent' && (
          <div className="px-4 py-3 space-y-4">
            <p className="text-xs text-ink-muted leading-snug">
              Pick where your agent runs. Everything it saves appears under your name.
            </p>
            {/* LOCAL FIRST. The local server is the recommended connection for
                every agent that can run it — it serves everything the hosted
                endpoint does PLUS the plugins' local-only tools — so its drawer
                leads, and the hosted URL follows for the agents that cannot
                (web assistants, cloud platforms). Two CLOSED drawers, native
                <details> (the SecretsPage "Advanced" precedent): the choice is
                the headline, and neither config wall is worth reading until
                the reader has picked their side of it. */}
            <details className="border border-line rounded">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink">
                Desktop agents: Claude Code, Claude Desktop, Cursor, Windsurf, Cline and similar
              </summary>
              <div className="px-3 pb-3 space-y-2">
                <p className="text-meta text-ink-muted leading-snug">
                  Recommended: runs this workspace as a local MCP server (needs Node), so the
                  agent gets everything the hosted endpoint serves, plus your plugins'
                  local-only tools — the ones{' '}
                  <span className="font-mono">list_local_tools</span> names. No key needed: the
                  first time it starts, your browser opens so you can sign in. (A pipeline that
                  can't open a browser passes an external API key instead — the{' '}
                  <button
                    type="button"
                    onClick={() => setTab('autonomous')}
                    className="underline text-ink-muted hover:text-ink"
                  >
                    Autonomous agents
                  </button>{' '}
                  tab shows that setup.)
                </p>
                {/* "(local server)" disambiguates from the hosted drawer's
                    ConnectionInstructions block, which labels ITS command
                    "Connect Claude Code" — two identically named blocks on one
                    page with different commands is a paste-the-wrong-one trap. */}
                <CopyBlock
                  label="Connect Claude Code (local server)"
                  value={hexisMcpClaudeCommand(workspaceUrl)}
                  rows={3}
                />
                <p className="text-meta text-ink-muted leading-snug">
                  On Windows, prefer the JSON config below — this one-liner assumes a POSIX shell
                  (macOS, Linux, WSL or Git Bash).
                </p>
                <div>
                  <p className="text-meta text-ink-muted mb-1 leading-snug">
                    Cursor, Windsurf and Cline take this JSON in their MCP config. Claude
                    Desktop takes it too, in its config file: Settings → Developer → Edit
                    Config (its Connectors UI only adds remote servers).
                  </p>
                  <CopyBlock label={null} value={hexisMcpJsonSnippet(workspaceUrl)} rows={12} />
                </div>
              </div>
            </details>

            <details className="border border-line rounded">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-ink">
                Any other agent
              </summary>
              <div className="px-3 pb-3 space-y-3">
                <p className="text-meta text-ink-muted leading-snug">
                  claude.ai, ChatGPT and other agents that can't run a process on your machine
                  connect to the hosted endpoint. No key needed: the first time the agent
                  connects, your browser opens so you can sign in and choose which tools to
                  share with it.
                </p>
                {/* `buttonClasses`, not a hand-rolled class string — the one
                    button primitive exists because 171 sites once shared 153
                    variants between them, and its docstring prescribes exactly
                    this shape for links. */}
                <Link
                  to="/connect"
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonClasses({ variant: 'outline', size: 'sm', className: 'w-full' })}
                >
                  <Wrench size={12} />
                  Configure your tools
                  <ExternalLink size={11} className="opacity-60" aria-hidden="true" />
                </Link>
                <ConnectionInstructions mcpUrl={mcpUrl} />
              </div>
            </details>

            <p className="text-[11px] text-ink-muted leading-snug">
              Running an unattended pipeline or CI agent that can't open a browser? Use the{' '}
              <button
                type="button"
                onClick={() => setTab('autonomous')}
                className="underline text-ink-muted hover:text-ink"
              >
                Autonomous agents
              </button>{' '}
              tab instead.
            </p>
          </div>
        )}

        {tab === 'autonomous' && (
          <div className="px-4 py-3 space-y-4">
            <p className="text-xs text-ink-muted leading-snug">
              For autonomous agents and pipelines (CI, scheduled jobs) that can't open a browser to
              sign in. Create an external API key and give it to the agent. Each key carries your
              identity, so any saves the agent makes appear under your name. And it only gets the
              tools you've already connected on the Connect your tools page.
            </p>

            <div className="border border-line rounded p-3 space-y-2">
              <label htmlFor={labelInputId} className="block text-xs font-medium text-ink">
                Create an external API key
              </label>
              <div className="flex gap-2">
                <input
                  id={labelInputId}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Claude Code on my laptop"
                  maxLength={MAX_LABEL_LEN}
                  className="flex-1 bg-white border border-line rounded px-2 py-1.5 text-sm focus:outline-none focus:border-accent"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && canSubmit) handleCreate();
                  }}
                />
                <button
                  onClick={handleCreate}
                  disabled={!canSubmit}
                  className="px-3 py-1.5 text-sm rounded bg-accent hover:bg-accent-hover text-white disabled:opacity-50 disabled:hover:bg-accent"
                >
                  {creating ? 'Creating…' : 'Create key'}
                </button>
              </div>
              {createError && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                  {createError}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium text-ink">Your external API keys</div>
              {loadError && (
                <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                  {loadError}
                </div>
              )}
              {loading ? (
                <div className="text-xs text-ink-muted">Loading…</div>
              ) : keys.length === 0 ? (
                <div className="text-xs text-ink-muted">No external API keys yet.</div>
              ) : (
                <ul className="divide-y divide-line border border-line rounded">
                  {sortedKeys.map((k) => {
                    const revoked = k.revokedAt !== null;
                    const usage = !revoked ? k.llmUsage : undefined;
                    const cap = usage?.dailyTokenCap ?? 0;
                    const used = usage?.usedTodayTokens ?? 0;
                    const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
                    const overCap = cap > 0 && used >= cap;
                    return (
                      <li
                        key={k.id}
                        className={`flex items-center gap-3 px-3 py-2 text-sm ${
                          revoked ? 'opacity-60' : ''
                        }`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate">{k.label}</div>
                          <div className="text-[11px] text-ink-muted">
                            Created {formatRelative(k.createdAt)} · Last used {formatRelative(k.lastUsedAt)}
                            {revoked && ' · Disconnected'}
                          </div>
                          {usage && (
                            <div className="mt-1 max-w-xs">
                              <div
                                className={`flex items-center justify-between text-[11px] ${
                                  overCap ? 'text-red-600' : 'text-ink-muted'
                                }`}
                              >
                                <span>Model usage today</span>
                                <span>
                                  {used.toLocaleString()} / {cap.toLocaleString()} tokens
                                </span>
                              </div>
                              <div className="mt-0.5 h-1 rounded bg-sunken overflow-hidden">
                                <div
                                  className={`h-full ${overCap ? 'bg-red-500' : 'bg-accent'}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                        {revoked ? (
                          <button
                            onClick={() => setPendingDelete({ id: k.id, label: k.label })}
                            className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50 border border-line"
                            title="Permanently delete this disconnected key and its usage history."
                          >
                            Delete
                          </button>
                        ) : (
                          <button
                            onClick={() => handleDisconnect(k.id)}
                            className="text-xs px-2 py-1 rounded text-ink hover:bg-hover border border-line"
                            title="Disconnect this external API key. The external agent using it will lose access."
                          >
                            Disconnect
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        )}
      </PageShell>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete external API key"
        size="sm"
        busy={deleting}
        footer={
          <>
            <button
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
              className="px-3 py-1.5 text-sm rounded text-ink hover:bg-hover border border-line disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-sm rounded bg-red-600 hover:bg-red-700 text-white disabled:opacity-50 disabled:hover:bg-red-600"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </>
        }
      >
        <p className="text-xs text-ink leading-snug">
          Permanently delete{' '}
          <span className="font-medium">&ldquo;{pendingDelete?.label}&rdquo;</span>? This removes it
          and its usage history for good.
        </p>
      </Dialog>

      {reveal && (
        <div
          className="fixed inset-0 z-[60] bg-scrim flex items-center justify-center p-4"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            className="bg-white border border-line rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto"
          >
            <div className="px-4 py-3 border-b border-line">
              <h3 className="text-sm font-semibold">Save this external API key now</h3>
            </div>
            <div className="px-4 py-3 space-y-3">
              <p className="text-xs text-ink leading-snug">
                This is the only time you'll see the full key. If you lose it, disconnect it and create a new one.
              </p>
              <div className="relative">
                <textarea
                  readOnly
                  value={reveal.plaintext}
                  rows={2}
                  className="w-full font-mono text-xs bg-sunken border border-line rounded px-2 py-1.5 pr-10 resize-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  onClick={() => copy(reveal.plaintext)}
                  className="absolute top-1.5 right-1.5 p-1 rounded hover:bg-hover text-ink-muted"
                  aria-label="Copy external API key"
                  title="Copy to clipboard"
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <div>
                <div className="text-xs font-medium text-ink mb-1">
                  Desktop agents — the local server (recommended)
                </div>
                <p className="text-meta text-ink-muted mb-1 leading-snug">
                  For agents that run on your machine: Claude Code, Claude Desktop, Cursor,
                  Windsurf, Cline and similar. Runs this workspace as a local MCP server (needs
                  Node): the agent gets everything the hosted endpoint serves, plus your
                  plugins' local-only tools. In Claude Code:
                </p>
                <textarea
                  readOnly
                  value={hexisMcpClaudeCommand(workspaceUrl, reveal.plaintext)}
                  rows={3}
                  className="w-full font-mono text-meta bg-sunken border border-line rounded px-2 py-1.5 resize-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <p className="text-meta text-ink-muted mt-1 leading-snug">
                  On Windows, prefer the JSON config below — this one-liner assumes a POSIX
                  shell (macOS, Linux, WSL or Git Bash).
                </p>
                <p className="text-meta text-ink-muted mt-2 mb-1 leading-snug">
                  Or as a JSON config, for Claude Desktop, Cursor, Windsurf, Cline and
                  similar:
                </p>
                <textarea
                  readOnly
                  value={hexisMcpJsonSnippet(workspaceUrl, reveal.plaintext)}
                  rows={13}
                  className="w-full font-mono text-meta bg-sunken border border-line rounded px-2 py-1.5 resize-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <div>
                <div className="text-xs font-medium text-ink mb-1">
                  Web agents and pipelines — the hosted endpoint
                </div>
                <p className="text-meta text-ink-muted mb-1 leading-snug">
                  For agents that can't run a process on your machine, and for CI where
                  installing Node is unwanted. Claude Code, via the hosted endpoint:
                </p>
                <textarea
                  readOnly
                  value={claudeCodeCommand(mcpUrl, reveal.plaintext)}
                  rows={3}
                  className="w-full font-mono text-[11px] bg-sunken border border-line rounded px-2 py-1.5 resize-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <div>
                <div className="text-xs font-medium text-ink mb-1">
                  Connect Langdock
                </div>
                <ol className="text-[11px] text-ink-muted mb-1 leading-snug list-decimal pl-4 space-y-0.5">
                  <li>In Langdock, open your workspace settings and go to MCP servers → Add server.</li>
                  <li>Choose <span className="font-medium">HTTP</span> (Streamable HTTP) as the transport.</li>
                  <li>Give it a name (e.g. <span className="font-medium">Bevel</span>), paste the URL below into the server URL field, and add the Authorization header under custom headers.</li>
                  <li>Save, then enable the server in any assistant you want it available in.</li>
                </ol>
                <textarea
                  readOnly
                  value={langdockSnippet(mcpUrl, reveal.plaintext)}
                  rows={3}
                  className="w-full font-mono text-[11px] bg-sunken border border-line rounded px-2 py-1.5 resize-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
              <div>
                <div className="text-xs font-medium text-ink mb-1">
                  Other agents (JSON config)
                </div>
                <p className="text-[11px] text-ink-muted mb-1 leading-snug">
                  The hosted endpoint for most clients that load servers from a JSON config —
                  when the local server above isn't wanted.
                </p>
                <textarea
                  readOnly
                  value={jsonConfigSnippet(mcpUrl, reveal.plaintext)}
                  rows={11}
                  className="w-full font-mono text-[11px] bg-sunken border border-line rounded px-2 py-1.5 resize-none"
                  onFocus={(e) => e.currentTarget.select()}
                />
              </div>
            </div>
            <div className="flex justify-end px-4 py-3 border-t border-line">
              <button
                onClick={() => setReveal(null)}
                className="px-3 py-1.5 text-sm rounded bg-accent hover:bg-accent-hover text-white"
              >
                Done: I've saved it
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
