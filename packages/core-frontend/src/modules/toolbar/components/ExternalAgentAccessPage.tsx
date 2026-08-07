import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Copy, Wrench, ExternalLink } from 'lucide-react';
import { Dialog } from '../../../shared/components/Dialog';
import { PageShell } from '../../../shared/components/PageShell';
import {
  type ExternalApiKeySummary,
  type MintedExternalApiKey,
  createExternalApiKey,
  deleteExternalApiKey,
  disconnectExternalApiKey,
  listExternalApiKeys,
} from '../services/external-api-keys.api';

/**
 * "Copied" affordance with a 1500ms auto-reset. Owns the timer + its teardown
 * (so an unmounting page can't fire a stale setState), shared by the reveal
 * modal and every CopyBlock. `copy(text)` writes to the clipboard and flags
 * copied; a rejected write (insecure context / denied permission) leaves the
 * textarea selectable for manual copy and shows no false "Copied".
 */
function useCopyFeedback(): { copied: boolean; copy: (text: string) => void } {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timerId = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timerId);
  }, [copied]);
  const copy = useCallback((text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => {});
  }, []);
  return { copied, copy };
}

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
  // top, never-used ones last within that group), with disconnected keys sunk
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
              Connect your own agent: Claude Code, Claude Desktop, Cursor and similar. No key
              needed: the first time the agent connects, your browser opens so you can sign in and
              choose which tools to share with it. Everything it saves appears under your name.
            </p>
            <Link
              to="/connect"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 rounded border border-line px-2 py-1.5 text-xs text-ink hover:bg-hover"
            >
              <Wrench size={12} />
              Configure your tools
              <ExternalLink size={11} className="opacity-60" />
            </Link>
            <CopyBlock
              label="Connect Claude Code"
              value={`claude mcp add --transport http knowledge-base ${window.location.origin}/api/mcp`}
              rows={2}
            />
            <div>
              <div className="text-xs font-medium text-ink mb-1">claude.ai / Claude Desktop</div>
              <p className="text-[11px] text-ink-muted mb-1 leading-snug">
                Settings → Connectors → Add custom connector, then paste this URL. When asked to
                authorize, your browser opens this app to finish connecting.
              </p>
              <CopyBlock label={null} value={`${window.location.origin}/api/mcp`} rows={1} />
            </div>
            <div>
              <div className="text-xs font-medium text-ink mb-1">Other agents (JSON config)</div>
              <p className="text-[11px] text-ink-muted mb-1 leading-snug">
                Works with Cursor, Windsurf, Cline, and most clients that load servers from a JSON
                config and support signing in.
              </p>
              <CopyBlock
                label={null}
                value={JSON.stringify(
                  {
                    mcpServers: {
                      'knowledge-base': {
                        type: 'http',
                        url: `${window.location.origin}/api/mcp`,
                      },
                    },
                  },
                  null,
                  2,
                )}
                rows={9}
              />
            </div>
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
                  Connect Claude Code
                </div>
                <textarea
                  readOnly
                  value={`claude mcp add --transport http knowledge-base ${window.location.origin}/api/mcp --header "Authorization: Bearer ${reveal.plaintext}"`}
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
                  value={`URL: ${window.location.origin}/api/mcp\nHeader name: Authorization\nHeader value: Bearer ${reveal.plaintext}`}
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
                  Works with Claude Desktop, Cursor, Windsurf, Cline, and most clients that load servers from a JSON config.
                </p>
                <textarea
                  readOnly
                  value={JSON.stringify(
                    {
                      mcpServers: {
                        'knowledge-base': {
                          type: 'http',
                          url: `${window.location.origin}/api/mcp`,
                          headers: {
                            Authorization: `Bearer ${reveal.plaintext}`,
                          },
                        },
                      },
                    },
                    null,
                    2,
                  )}
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

/** Read-only snippet with a copy button, for the no-key connection configs. */
function CopyBlock({ label, value, rows }: { label: string | null; value: string; rows: number }) {
  const { copied, copy } = useCopyFeedback();

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        {label !== null && <div className="text-xs font-medium text-ink">{label}</div>}
        <button
          onClick={() => copy(value)}
          className="ml-auto p-1 rounded hover:bg-hover text-ink-muted"
          aria-label={label ? `Copy: ${label}` : 'Copy to clipboard'}
          title="Copy to clipboard"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <textarea
        readOnly
        value={value}
        rows={rows}
        className="w-full font-mono text-[11px] bg-sunken border border-line rounded px-2 py-1.5 resize-none"
        onFocus={(e) => e.currentTarget.select()}
      />
    </div>
  );
}
