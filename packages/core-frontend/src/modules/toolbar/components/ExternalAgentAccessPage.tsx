import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { Dialog } from '../../../shared/components/Dialog';
import { PageShell } from '../../../shared/components/PageShell';
import { Banner, Button, TextField } from '../../../shared/components';
import { formatRelativeTime } from '../../../lib/utils';
import {
  MoreRow,
  SnippetBlock,
  claudeCodeCommand,
  hexisMcpClaudeCommand,
  hexisMcpJsonSnippet,
  jsonConfigSnippet,
  langdockSnippet,
  mcpEndpointUrl,
  workspaceBaseUrl,
} from '../../../shared/mcp';
import { CODEX_LOGIN_NOTE, GITHUB_LINK_KIND, marketplaceCommands } from '../../../shared/marketplace-url';
import { CoworkSetupSteps } from './CoworkSetupSteps';
import { useAdmin } from '../../admin';
import { fetchMarketplaceRegistration } from '../../settings';
import { connectedAsLabel, listAgentChoices, useConnectAsChoice } from '../../agents';
import { ConnectAsChoice } from '../../agents/components/ConnectAsChoice';
import { useAgentConnection } from '../../onboarding';
import { AgentConnectionStatus } from '../../onboarding/components/AgentConnectionStatus';
import { AgentClientPicker } from '../../onboarding/components/AgentClientPicker';
import {
  type ExternalApiKeySummary,
  type MintedExternalApiKey,
  createExternalApiKey,
  deleteExternalApiKey,
  disconnectExternalApiKey,
  listExternalApiKeys,
} from '../services/external-api-keys.api';

const MAX_LABEL_LEN = 200;

/**
 * The shared formatter, plus the one word it deliberately leaves to the caller:
 * a key that has never been used has no instant to describe.
 */
function formatRelative(ts: number | null): string {
  return formatRelativeTime(ts) || 'never';
}

/** A white card on the settings canvas, as on the sibling settings pages. */
const CARD = 'rounded-lg border border-line bg-white';
/** A closed row's title: a card that is its title until it is opened. */
const ROW = 'flex cursor-pointer list-none items-center gap-2 rounded-lg px-4 py-3 text-ui font-semibold text-ink transition-colors hover:bg-hover [&::-webkit-details-marker]:hidden';
/** The arrow that says a row opens, turned when it is open. */
const CHEVRON = 'flex-none text-ink-faint transition-transform group-open:rotate-90';
/** A line that says what to do: the reading size, never the size of a date. */
const HINT = 'text-detail leading-normal text-ink-muted';

/** The name of a key made for an install command: found again by what it is for and when. */
function pluginKeyName(): string {
  return `Plugins, ${new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

/** What a new key was made for: decides what its dialog leads with. */
type KeyUse = 'key' | 'plugins';

/**
 * The External agent access page, routed at `/external-agent-access` inside
 * the settings layout, in the settings pages' own shell.
 *
 * One task is open: connect your agent (`AgentClientPicker`, the same picker
 * the welcome page shows). Everything else is a closed row, a card that is
 * its title until someone opens it:
 *
 *  - "API keys": for agents that cannot open a browser. Lists existing keys,
 *    mints new ones, disconnects live ones, permanently deletes disconnected
 *    ones. The plaintext of a minted key is shown once.
 *  - "Install skills as native plugins": a plugin command carries a key, so the row starts
 *    one and the key dialog shows the command with the key filled in. The
 *    Cowork and claude.ai tutorial opens from the same row, in a dialog.
 *
 * What agents are told (`AgentInstructionsCard`) is a workspace setting and
 * lives on the Deployment page.
 *
 * Glossary terms used in copy: "External API key", "Disconnect" (= revoke),
 * "External agent" (= MCP client). See docs/glossary.md.
 */
export function ExternalAgentAccessPage() {
  const labelInputId = useId();
  /** Where focus was when a key was made, to hand it back when its dialog closes. */
  const returnFocus = useRef<HTMLElement | null>(null);

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

  const [coworkOpen, setCoworkOpen] = useState(false);
  // Whether this deployment is registered with Claude, asked when the plugins
  // row is opened. Until it is, the Cowork route leads a member only to a
  // notice about something they cannot change, so they are not sent there.
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [coworkRegistered, setCoworkRegistered] = useState(false);
  // A failed check is said, with a way to ask again: hiding the route would
  // read as "not set up" when nobody knows.
  const [registrationError, setRegistrationError] = useState(false);
  const [registrationAsk, setRegistrationAsk] = useState(0);
  useEffect(() => {
    if (!pluginsOpen) return;
    let live = true;
    fetchMarketplaceRegistration().then(
      (registered) => {
        if (!live) return;
        setRegistrationError(false);
        setCoworkRegistered(registered);
      },
      () => {
        if (live) setRegistrationError(true);
      },
    );
    return () => {
      live = false;
    };
  }, [pluginsOpen, registrationAsk]);
  const [keyUse, setKeyUse] = useState<KeyUse>('key');
  // The reader followed the link or copied the snippet: only then does the
  // page wait for their agent.
  const [acted, setActed] = useState(false);
  // Connected, the card shows the connection. The picker comes back when the
  // reader asks to connect another agent.
  const [another, setAnother] = useState(false);
  // "Did it work?", answered in the card. Asked always here: this page is
  // where someone comes back to connect, whether or not their onboarding is
  // still open.
  const agent = useAgentConnection();
  // Admins get the way to set Cowork up; the tutorial is the same for everyone.
  const { isAdmin } = useAdmin();
  const [keys, setKeys] = useState<ExternalApiKeySummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  // "Connect as" for a new key: Everything unless an agent is picked. Until
  // the agents answer, a key would be minted as Everything by default; when
  // they could not be loaded, an Everything key waits to be confirmed.
  const connectAs = useConnectAsChoice();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** Which action the error belongs to, so it shows beside that one only. */
  const [createErrorFor, setCreateErrorFor] = useState<KeyUse>('key');

  // The plaintext of a freshly minted key. Held in state for the lifetime
  // of the reveal modal — never persisted, and cleared when the user
  // dismisses the reveal step.
  const [reveal, setReveal] = useState<MintedExternalApiKey | null>(null);

  // The key awaiting a confirmation. Disconnect and Delete both end a key's
  // use for good (a disconnected key cannot be connected again), so both ask
  // first, in the same dialog. `acting` keeps the request in flight so the
  // confirm can't be dismissed mid-way; a failure stays IN the dialog, beside
  // the action that failed, instead of surfacing under an unrelated control.
  const [pending, setPending] = useState<{
    id: string;
    label: string;
    action: 'disconnect' | 'delete';
    /** A Claude account's link: it can be resumed by connecting again from Claude. */
    claudeLink?: boolean;
  } | null>(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoadError(null);
    try {
      setKeys(await listExternalApiKeys());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load external API keys.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load; refresh sets state once it answers
    void refresh();
  }, [refresh]);

  // The agents a key may be minted as. A failure costs only the choice —
  // Everything is always on offer — and is shown, not passed off as none.
  const settleConnectAs = connectAs.settle;
  useEffect(() => {
    let cancelled = false;
    listAgentChoices().then(
      (agents) => {
        if (!cancelled) settleConnectAs({ agents });
      },
      () => {
        if (!cancelled) settleConnectAs({ agents: [], failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [settleConnectAs]);

  /** Mint a key and show it once, opened on the place it is meant for. */
  async function createKey(name: string, use: KeyUse) {
    // A key for plugins always loads everything you may read: the Connect-as
    // choice belongs to the API keys row, which the reader of this row cannot
    // see, so it neither narrows this key nor holds its button back.
    const plugins = use === 'plugins';
    if (name.length === 0 || name.length > MAX_LABEL_LEN || creating || (!plugins && !connectAs.mayConnect)) return;
    setCreating(true);
    setCreateError(null);
    setCreateErrorFor(use);
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    try {
      const minted = await createExternalApiKey(name, plugins ? null : connectAs.value);
      setReveal(minted);
      setKeyUse(use);
      if (!plugins) {
        setLabel('');
        connectAs.setValue(null);
      }
      // Optimistic-ish: refresh the list so the new row shows up underneath
      // the reveal modal.
      void refresh();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Couldn't create external API key.");
    } finally {
      setCreating(false);
    }
  }

  const handleCreate = () => createKey(label.trim(), 'key');

  async function confirmPending() {
    if (!pending || acting) return;
    setActing(true);
    setActionError(null);
    try {
      if (pending.action === 'delete') await deleteExternalApiKey(pending.id);
      else await disconnectExternalApiKey(pending.id);
      setPending(null);
      await refresh();
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : pending.action === 'delete'
            ? "Couldn't delete this key."
            : "Couldn't disconnect this key.",
      );
    } finally {
      setActing(false);
    }
  }

  /** Done on the key dialog. Focus goes back to where the key was made. */
  function closeReveal() {
    setReveal(null);
    const target = returnFocus.current;
    requestAnimationFrame(() => {
      if (target?.isConnected && !(target as HTMLButtonElement).disabled) target.focus();
      else document.getElementById(labelInputId)?.focus();
    });
  }

  function closePending() {
    setPending(null);
    setActionError(null);
  }

  const trimmed = label.trim();
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_LABEL_LEN && !creating && connectAs.mayConnect;

  // Surface the keys that matter: active keys first (most-recently-used at the
  // top, never-used ones last among the active), with disconnected keys sunk
  // to the bottom. Non-destructive — nothing is hidden or deleted, just ordered
  // so a long list of stale/test keys doesn't bury the ones in use.
  // ONE list from the server, two views of it: live Claude links belong to
  // the Cowork steps (they were minted by a connection, not created here),
  // everything else (hand-made keys, and Claude links once disconnected, so
  // they can be deleted) to API keys. Told apart by the stored kind, never
  // the label.
  const isClaudeLink = (k: ExternalApiKeySummary) => k.kind === GITHUB_LINK_KIND;
  const claudeLinks = keys.filter((k) => isClaudeLink(k) && k.revokedAt === null);
  const sortedKeys = keys.filter((k) => !isClaudeLink(k) || k.revokedAt !== null).sort((a, b) => {
    const aRevoked = a.revokedAt !== null;
    const bRevoked = b.revokedAt !== null;
    if (aRevoked !== bRevoked) return aRevoked ? 1 : -1;
    return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0);
  });

  const sectionIds = { agent: useId(), keys: useId() };
  const activeKeys = sortedKeys.filter((k) => k.revokedAt === null).length;

  return (
    <>
      {/* The settings pages' own shell: the same canvas, title and cards as
          Secrets, Account and the rest, so this page is one of them. */}
      <PageShell title="External agent access" card={false}>
        {/* The one open task. Everything else on the page is a closed row. */}
        <section aria-labelledby={sectionIds.agent} className={`${CARD} p-4`} data-testid="agent-connection-section">
          <h2 id={sectionIds.agent} className="text-ui font-semibold text-ink">
            {agent.connected ? 'Your agent' : 'Connect your agent'}
          </h2>
          {agent.connected ? (
            <>
              {/* The job is done, so the result leads and no button asks for it again. */}
              <AgentConnectionStatus agent={agent} detail className="mt-2.5" />
              {another ? (
                <AgentClientPicker mcpUrl={mcpUrl} className="mt-3.5" />
              ) : (
                <Button size="sm" className="mt-3" onClick={() => setAnother(true)}>
                  Connect another agent
                </Button>
              )}
            </>
          ) : (
            <>
              <AgentClientPicker mcpUrl={mcpUrl} onAct={() => setActed(true)} className="mt-3" />
              <AgentConnectionStatus agent={agent} waiting={acted} className="mt-3.5 empty:hidden" />
            </>
          )}
        </section>

        <details
          name="access-rows"
          className={`group mt-3 ${CARD}`}
          data-testid="keys-section"
          aria-labelledby={sectionIds.keys}
        >
          <summary className={ROW}>
            <span id={sectionIds.keys}>API keys</span>
            <span className="ml-auto text-meta font-normal text-ink-muted">{activeKeys > 0 && `${activeKeys} active`}</span>
            <ChevronRight size={14} aria-hidden className={CHEVRON} />
          </summary>
          <div className="px-4 pb-4">
            <p className={HINT}>
              For pipelines and scheduled jobs that cannot sign in through a browser. A key acts as you.
            </p>
            {/* What the key may load comes before the button that makes it. */}
            <div className="mt-3 empty:hidden">
              <ConnectAsChoice
                agents={connectAs.agents}
                value={connectAs.value}
                disabled={creating}
                onChange={connectAs.setValue}
                unavailable={connectAs.unavailable}
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <TextField
                id={labelInputId}
                aria-label="Name of the new API key"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Name, e.g. Nightly pipeline"
                maxLength={MAX_LABEL_LEN}
                className="py-[7px]"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSubmit) void handleCreate();
                }}
              />
              <Button onClick={() => void handleCreate()} disabled={!canSubmit} className="flex-none">
                {creating ? 'Creating…' : 'Create key'}
              </Button>
            </div>
            <div className="mt-3 space-y-3 empty:hidden">
              {createError && createErrorFor === 'key' && (
                <Banner tone="danger" role="alert">
                  {createError}
                </Banner>
              )}
              {/* Once, where the list would be, with the way out beside it. */}
              {loadError && (
                <Banner tone="danger" role="alert">
                  <div className="flex items-center justify-between gap-3">
                    <span>Could not load your keys. {loadError}</span>
                    <Button size="tiny" onClick={() => void refresh()} className="flex-none">
                      Retry
                    </Button>
                  </div>
                </Banner>
              )}
            </div>

            {sortedKeys.length > 0 && (
              <ul className="mt-3 divide-y divide-line rounded-md border border-line" aria-label="Your API keys">
                {sortedKeys.map((k) => {
                  const revoked = k.revokedAt !== null;
                  const usage = !revoked ? k.llmUsage : undefined;
                  const cap = usage?.dailyTokenCap ?? 0;
                  const used = usage?.usedTodayTokens ?? 0;
                  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
                  const overCap = cap > 0 && used >= cap;
                  return (
                    <li key={k.id} className={`flex items-center gap-3 px-3 py-2.5 ${revoked ? 'opacity-60' : ''}`}>
                      <div className="min-w-0 flex-1">
                        {/* The full name on hover: a long one is cut to the row. */}
                        <div className="truncate text-ui font-medium text-ink" title={k.label}>
                          {k.label}
                        </div>
                        <div className="text-meta text-ink-muted">
                          {/* Only a key made as an agent says so; Everything is what a key
                              is unless it says otherwise, and needs no tag. */}
                          {k.agentPath && (
                            <>
                              <span title={k.agentPath}>As {connectedAsLabel(k.agentPath)}</span> ·{' '}
                            </>
                          )}
                          Created {formatRelative(k.createdAt)} ·{' '}
                          {k.lastUsedAt === null ? 'Never used' : `Last used ${formatRelative(k.lastUsedAt)}`}
                          {/* A key an admin took is not one you can reconnect: say so,
                              or people try. Your own disconnect keeps its word. */}
                          {revoked && (k.revokedBy === 'admin' ? ' · Revoked by an admin' : ' · Disconnected')}
                        </div>
                        {/* No bar without a cap: "0 / 0 tokens" measures nothing. */}
                        {usage && cap > 0 && (
                          <div className="mt-1 max-w-xs">
                            <div
                              className={`flex items-center justify-between text-meta ${
                                overCap ? 'text-danger' : 'text-ink-muted'
                              }`}
                            >
                              <span>Model usage today</span>
                              <span>
                                {used.toLocaleString()} / {cap.toLocaleString()} tokens
                              </span>
                            </div>
                            {/* Not the accent: blue on this page means "do this". */}
                            <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-sunken">
                              <div
                                className={`h-full ${overCap ? 'bg-danger' : 'bg-ink-muted'}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                      {revoked ? (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => setPending({ id: k.id, label: k.label, action: 'delete' })}
                        >
                          Delete
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => setPending({ id: k.id, label: k.label, action: 'disconnect' })}
                        >
                          Disconnect
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </details>

        {/* A plugin command carries a key, so the way to the command is to make
            the key: the dialog then shows it with the key filled in, and
            nothing here can be copied half-made. */}
        <details
          name="access-rows"
          className={`group mt-3 ${CARD}`}
          data-testid="plugins-row"
          onToggle={(e) => setPluginsOpen(e.currentTarget.open)}
        >
          <summary className={ROW}>
            Install skills as native plugins
            <span className="text-meta font-normal text-ink-muted">Optional</span>
            <ChevronRight size={14} aria-hidden className={`ml-auto ${CHEVRON}`} />
          </summary>
          <div className="px-4 pb-4">
            <p className={HINT}>
              A connected agent already has your skills. This also installs them as plugins in Claude Code or Codex,
              with a command that includes a new API key.
            </p>
            {/* What the reader gets is the command; the key behind it is made
                for them and named so it can be found among their keys. */}
            <Button
              className="mt-3"
              onClick={() => void createKey(pluginKeyName(), 'plugins')}
              disabled={creating}
            >
              {creating ? 'Creating…' : 'Create install command'}
            </Button>
            {createError && createErrorFor === 'plugins' && (
              <Banner tone="danger" role="alert" className="mt-3">
                {createError}
              </Banner>
            )}
            {/* Cowork and claude.ai install from a marketplace an admin sets
                up once. Registered: the steps. Not registered: an admin is
                sent where it is set up, and a member sees nothing to do. */}
            {registrationError ? (
              <p className={`mt-3 ${HINT}`} role="alert">
                Could not check whether Cowork and claude.ai are set up.{' '}
                <button type="button" className="underline hover:text-ink" onClick={() => setRegistrationAsk((n) => n + 1)}>
                  Try again
                </button>
              </p>
            ) : coworkRegistered ? (
              <p className={`mt-3 ${HINT}`}>
                In Cowork and claude.ai:{' '}
                <button type="button" className="underline hover:text-ink" onClick={() => setCoworkOpen(true)}>
                  show the steps
                </button>
                .
              </p>
            ) : (
              isAdmin && (
                <p className={`mt-3 ${HINT}`}>
                  Cowork and claude.ai need a marketplace first:{' '}
                  <Link to="/deployment#marketplace" className="underline hover:text-ink">
                    set it up in Deployment
                  </Link>
                  .
                </p>
              )
            )}
          </div>
        </details>
      </PageShell>

      {/* The Cowork and claude.ai tutorial, with the Claude accounts it has
          connected. Mounted steps read the registration state when the dialog
          opens, never for everyone who merely opens the page. */}
      <Dialog open={coworkOpen} onClose={() => setCoworkOpen(false)} title="Skills in Cowork and claude.ai" size="xl">
        <div className="space-y-3.5" data-testid="cowork-section">
          <CoworkSetupSteps isAdmin={isAdmin} opened={coworkOpen} />
          {claudeLinks.length > 0 && (
            <div>
              <div className="mb-1.5 text-meta text-ink-muted">Your Claude connections</div>
              <ul className="divide-y divide-line rounded-lg border border-line">
                {claudeLinks.map((k) => (
                  <li key={k.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-ui font-medium text-ink" title={k.label}>
                        {k.label}
                      </div>
                      <div className="text-meta text-ink-faint">
                        Connected {formatRelative(k.createdAt)} ·{' '}
                        {k.lastUsedAt === null ? 'Never used' : `Last used ${formatRelative(k.lastUsedAt)}`}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => setPending({ id: k.id, label: k.label, action: 'disconnect', claudeLink: true })}
                    >
                      Disconnect
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={pending !== null}
        onClose={closePending}
        title={pending?.action === 'delete' ? 'Delete API key' : pending?.claudeLink ? 'Disconnect Claude account' : 'Disconnect API key'}
        size="sm"
        busy={acting}
        footer={
          <>
            <Button variant="quiet" onClick={closePending} disabled={acting}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void confirmPending()} disabled={acting}>
              {pending?.action === 'delete'
                ? acting
                  ? 'Deleting…'
                  : 'Delete'
                : acting
                  ? 'Disconnecting…'
                  : 'Disconnect'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-detail leading-snug text-ink">
            {pending?.action === 'delete' ? (
              <>
                Permanently delete <span className="font-medium">&ldquo;{pending?.label}&rdquo;</span>? This
                removes it and its usage history for good.
              </>
            ) : pending?.claudeLink ? (
              <>
                Disconnect <span className="font-medium">&ldquo;{pending?.label}&rdquo;</span>? Its
                marketplace stops updating. Connect again from Claude to resume.
              </>
            ) : (
              <>
                Disconnect <span className="font-medium">&ldquo;{pending?.label}&rdquo;</span>? The agent
                using it loses access now, and this key cannot be connected again.
              </>
            )}
          </p>
          {actionError && (
            <Banner tone="danger" role="alert">
              {actionError}
            </Banner>
          )}
        </div>
      </Dialog>

      {/* The app's own Dialog, so focus moves into it, stays in it and goes
          back to the name field after Done. `busy` is the dialog's switch for
          "a one-time key still being shown": Escape, the backdrop and the
          cross are inert, and Done is the only way out. The body has one
          height, so choosing where the key goes never moves the title, the
          choice or Done. */}
      <Dialog
        open={reveal !== null}
        onClose={closeReveal}
        title={keyUse === 'plugins' ? 'Install your skills' : 'Save this key now'}
        size="xl"
        busy
        hideClose
        footer={
          <Button variant="primary" onClick={closeReveal}>
            {keyUse === 'plugins' ? 'Done' : 'Done: I’ve saved it'}
          </Button>
        }
      >
        {reveal && (
          <>
            {keyUse === 'plugins' ? (
              <div className="space-y-3">
                {/* Made for plugins: the command is the thing to copy. It holds the key. */}
                <p className={HINT}>Run this in your terminal. It is shown only now, and running it once is enough.</p>
                <SnippetBlock
                  value={marketplaceCommands(reveal.plaintext).claude}
                  copyLabel="Copy: Claude Code marketplace command"
                  wrap
                />
                <MoreRow summary="Codex" group="key-use">
                  <p className="leading-normal">Add the marketplace, install the plugin, sign in, check. {CODEX_LOGIN_NOTE}</p>
                  <SnippetBlock value={marketplaceCommands(reveal.plaintext).codex} copyLabel="Copy: Codex marketplace command" />
                </MoreRow>
                <MoreRow summary="Any other agent, through the skills CLI" group="key-use">
                  <SnippetBlock value={marketplaceCommands(reveal.plaintext).skills} copyLabel="Copy: skills CLI command" />
                </MoreRow>
                <MoreRow summary="The key alone" group="key-use">
                  <SnippetBlock value={reveal.plaintext} copyLabel="Copy API key" />
                </MoreRow>
              </div>
            ) : (
              <div className="space-y-3">
                {/* The key is the thing to copy. Where it goes is a closed row each. */}
                <p className={HINT}>Shown only now. If you lose it, disconnect it and create a new one.</p>
                <SnippetBlock value={reveal.plaintext} copyLabel="Copy API key" />
                <MoreRow summary="Use it in a pipeline or CI" group="key-use">
                  <SnippetBlock value={jsonConfigSnippet(mcpUrl, reveal.plaintext)} copyLabel="Copy: JSON configuration" />
                </MoreRow>
                <MoreRow summary="Use it in Claude Code" group="key-use">
                  <SnippetBlock value={claudeCodeCommand(mcpUrl, reveal.plaintext)} copyLabel="Copy: Claude Code" />
                </MoreRow>
                <MoreRow summary="Use it in Langdock" group="key-use">
                  <p className="leading-normal">MCP servers → Add server → HTTP, then this URL and header.</p>
                  <SnippetBlock value={langdockSnippet(mcpUrl, reveal.plaintext)} copyLabel="Copy: Langdock" />
                </MoreRow>
                <MoreRow summary="Use it in a coding agent on your machine" group="key-use">
                  <SnippetBlock
                    value={hexisMcpJsonSnippet(workspaceUrl, reveal.plaintext)}
                    copyLabel="Copy: JSON configuration (local server)"
                  />
                  <p className="leading-normal">Or, in Claude Code on macOS, Linux or WSL:</p>
                  <SnippetBlock
                    value={hexisMcpClaudeCommand(workspaceUrl, reveal.plaintext)}
                    copyLabel="Copy: Claude Code (local server)"
                  />
                </MoreRow>
              </div>
            )}
          </>
        )}
      </Dialog>
    </>
  );
}
