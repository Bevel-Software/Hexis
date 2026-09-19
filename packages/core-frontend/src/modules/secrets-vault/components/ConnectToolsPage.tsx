import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Banner, Button, Surface, TextField } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { LIBRARY_ROOT, pathForTool } from '../../library/routes/library-paths';
import { ToolLogo } from '../../library/components/ToolLogo';
import { startOAuth } from '../services/secrets.api';
import { setUserVar, setAdminVar, deleteUserVar, setOAuthClientSecret } from '../services/tool-secrets.api';
import { announceToolCredentialsChanged } from '../../../core/events';
import {
  getConnectPending,
  startToolOAuth,
  getMcpOAuthRequest,
  completeMcpOAuth,
  type ConnectTool,
  type ConnectOAuth,
  type ConnectToolOAuth,
} from '../services/connect.api';
import { isActionable, outstandingCount, ownerReason } from '../utils/connect-status';

/**
 * Persisted copy of the external-agent authorization state (`?oauth=<state>`).
 * A tool sign-in mid-flow bounces the browser to the provider and back, which
 * strips the query string — the session copy is what keeps the Finish flow
 * alive across that round-trip. Cleared on Finish or when the state goes stale.
 */
const MCP_OAUTH_STATE_KEY = 'mcp-oauth-state';

/**
 * "Connect your tools" — the page a person lands on from the needs-authorization
 * link surfaced by their external agent, and from the plugin banner that says
 * how many integrations need setup. It lists everything standing between them
 * and the tools they can reach: an input for each personal API key, an
 * "Authorize" button for each OAuth sign-in.
 *
 * It also lists what they CANNOT act on, which is the whole point of the list
 * agreeing with the banner that sent them. Three states, and the page owes the
 * reader the reason for each of the two that are not theirs to fix:
 *
 *  - actionable — their own key or sign-in, or a workspace value they own;
 *  - owner-only — a workspace value somebody else has to set, greyed, naming
 *    the variable so they know what to ask for;
 *  - skipped — a tool they took out themselves, greyed, with Include to put it
 *    back.
 *
 * All three are counted. A banner saying four and a page showing two was the
 * bug; a page that showed four and counted two would be the same bug with more
 * steps. What is NOT here is a tool the reader may not read — the server never
 * sends one, so there is no state in which this page names it.
 *
 * Two modes:
 *  - Plain (default): configure credentials, go back to the agent by hand.
 *  - Agent-connect (`?oauth=<state>`): an external agent is waiting on the
 *    other end of an authorization flow. Each tool gets an include/skip
 *    toggle — skipping wipes its saved per-user credentials so the tool won't
 *    be available to the agent — and a Finish button completes the flow and
 *    sends the browser back to the agent.
 *
 * DESIGN: this page speaks the Library's vocabulary, because it is the other
 * half of the same job. Every state reads what is STORED — `Signed in`,
 * `Key saved` — or `Needs …` (never a third phrasing; `Connected` is
 * reserved for the tool page, whose probe actually earns the word), nothing
 * that needs a person is grey, and a tool is
 * identified by its mark before its name — the same `ToolLogo` the gallery
 * cards use. It went through the design system wholesale: no raw palette, no
 * off-scale type, no ad-hoc bordered `div`s pretending to be Surfaces.
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
  // Entries the user took OUT. Everything the server sent is in by default —
  // it used to be the other way round, and an unconfigured tool the reader had
  // never seen rendered grey and uncounted, which is exactly how a page reached
  // from "4 integrations need setup" came to show two.
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
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
    // "Signed in", not "Connected": the sign-in landing here proves a token was
    // issued, not that a call with it will succeed.
    if (params.has('authorized')) setNotice('Signed in. You can go back to your agent and try again.');
    else if (params.has('error')) setError(params.get('error') || 'Authorization failed.');
    if (params.has('authorized') || params.has('error')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      // Whichever way the round-trip went, a provider has just had its say
      // about a sign-in this page did not perform itself — so the Library's
      // view of the tool is from before the browser left.
      announceToolCredentialsChanged();
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
   * Include/skip toggle. `id` keys the local opt-out set; `configured` says
   * whether any per-user value exists; `wipe` removes them all. Unticking a
   * configured entry wipes it (that's what "skip" means — the tool must not
   * register for the agent); unticking an unconfigured one just hides inputs.
   * Either way the row STAYS, greyed and still counted: skipping is a decision
   * about what the agent may use, not a claim the tool is set up.
   *
   * `wipe` calls the `removed` callback it is handed after each DELETE that
   * lands. A tool with several saved keys is several round-trips, and the
   * second one can fail after the first succeeded: that key is gone for real,
   * so the Library's copy went stale at the FIRST success, not at the last.
   * Announcing only on a clean wipe would leave the catalog showing a key
   * nobody has any more.
   */
  const onToggle = async (
    id: string,
    configured: boolean,
    wipe: (removed: () => void) => Promise<void>,
  ) => {
    if (skipped.has(id)) {
      setSkipped((s) => {
        const nextSet = new Set(s);
        nextSet.delete(id);
        return nextSet;
      });
      return;
    }
    setSkipped((s) => new Set(s).add(id));
    if (configured) {
      setWiping((s) => new Set(s).add(id));
      let removedAny = false;
      try {
        await wipe(() => {
          removedAny = true;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (removedAny) {
          // Before this page's own refetch, not after it: the Library is a
          // different store with a different round-trip, and there is nothing
          // for it to wait on.
          announceToolCredentialsChanged();
          await refresh();
        }
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
  const isOn = (id: string) => !skipped.has(id);

  // One integration, one unit — and every state of it, including the two the
  // reader cannot act on. See `outstandingCount`: this number exists to equal
  // the plugin banner's, and the rules that make it do so are written down
  // beside the rule the banner itself uses.
  const outstanding = outstandingCount({ tools, oauth, toolOAuth });
  const nothingToDo =
    !loading && tools.length === 0 && oauth.length === 0 && toolOAuth.length === 0;

  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-8 py-4">
        {/* The one page that had NO way back: it is reached from the library's
            "Finish setup" and from tool pages, and stranded everyone it
            helped. The Library is where every one of those journeys starts. */}
        <Link
          to={LIBRARY_ROOT}
          className="rounded-xs text-detail text-ink-muted hover:text-ink"
        >
          {'‹ Skills & tools'}
        </Link>
        <h1 className="text-strong font-semibold text-ink">Connect your tools</h1>
        <Button variant="quiet" size="sm" className="ml-auto" onClick={() => void refresh()}>
          Refresh
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-2xl">
          {agentMode && (
            <Surface tone="surface" radius="xl" elevation="card" padded className="mb-4">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <p className="text-strong font-semibold text-ink">
                    {agentName
                      ? `“${agentName}” wants to connect`
                      : 'An external agent wants to connect'}
                  </p>
                  <p className="mt-1 text-detail text-ink-muted">
                    Choose which tools it may use. Skipping a tool removes your saved keys and
                    sign-ins for it. When you&apos;re done, finish to send it back to your agent.
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  className="shrink-0"
                  disabled={finishing}
                  onClick={() => void onFinish()}
                >
                  {finishing ? 'Finishing…' : 'Finish & return to your agent'}
                </Button>
              </div>
            </Surface>
          )}

          {error && (
            <Banner role="alert" tone="danger" className="mb-3">
              {error}
            </Banner>
          )}
          {notice && (
            <Banner role="status" tone="ok" className="mb-3">
              {notice}
            </Banner>
          )}

          {/* The third sentence is the one that earns the list its length: the
              page shows more than the reader's own homework, so it has to say
              so before they wonder why a row has no field. */}
          {!nothingToDo && (
            <p className="mb-5 text-ui text-ink-muted">
              These tools need a sign-in or a key before they will work in your agent. Authorize
              each connection and enter any keys below, then head back to your agent and run the
              tool again. Anything greyed out is not yours to do — it is waiting on the tool&apos;s
              owner, or you took it out yourself. Your values are stored securely and never shown
              again after saving.
            </p>
          )}

          {loading ? (
            <p className="py-16 text-center text-ui text-ink-faint">Loading…</p>
          ) : nothingToDo ? (
            agentMode ? (
              // In agent-connect mode an empty list is SUCCESS, not absence:
              // every shared tool works without a personal credential, so the
              // user's only job is to finish.
              <Banner role="status" tone="ok">
                You&apos;re all set: none of your tools need a personal sign-in or key. Click
                “Finish &amp; return to your agent” above to complete the connection.
              </Banner>
            ) : (
              <p className="py-16 text-center text-ui text-ink-faint">
                You have no tools that need a personal sign-in or key.
              </p>
            )
          ) : (
            <>
              {outstanding === 0 && (
                <Banner role="status" tone="ok" className="mb-5">
                  {/* Not "everything is connected": nothing on this page has
                      called a provider, so every row above is stored-but-untested.
                      The banner has to make the same claim its rows do. */}
                  Everything is set up. You can use your tools in your agent.
                </Banner>
              )}

              {(toolOAuth.length > 0 || oauth.length > 0) && (
                <Section title="Sign-ins">
                  {/* OAuth-backed tool variables — authorized via the tool-scoped flow. */}
                  {toolOAuth.map((o) => {
                    const id = signInId(o);
                    const on = isOn(id);
                    // The provider was never registered, so there is no consent
                    // screen for Authorize to open. Whose job that is decides
                    // whether this is a greyed reason or a field.
                    if (!o.ownerConfigured) {
                      return o.ownerOnly ? (
                        <ConnectRow
                          key={o.key}
                          slug={o.slug}
                          name={o.toolName}
                          label={o.label || o.toolName}
                          on
                          dim
                          busy={false}
                          state="owner-only"
                          reason={ownerReason(o.varName)}
                        />
                      ) : (
                        <Surface
                          key={o.key}
                          tone="surface"
                          radius="lg"
                          elevation="none"
                          padded
                          className="border border-line"
                        >
                          <ConnectRowHead
                            slug={o.slug}
                            name={o.toolName}
                            label={o.label || o.toolName}
                            on
                            dim={false}
                            busy={false}
                            state="needs-key"
                          />
                          <ul className="mt-3 flex flex-col gap-2">
                            {/* The owner's half of a sign-in is the client
                                secret, set here so the person who CAN unblock
                                everyone else does not have to go and find the
                                tool page to do it. */}
                            <KeyRow
                              name={o.varName}
                              label={`${o.varName} (client secret)`}
                              configured={false}
                              ownerOnly={false}
                              save={(value) => setOAuthClientSecret(o.slug, o.varName, value)}
                              onSaved={() => {
                                announceToolCredentialsChanged();
                                void refresh();
                              }}
                              onError={setError}
                            />
                          </ul>
                        </Surface>
                      );
                    }
                    return (
                      <ConnectRow
                        key={o.key}
                        slug={o.slug}
                        name={o.toolName}
                        label={o.label || o.toolName}
                        on={on}
                        dim={!on}
                        busy={wiping.has(id)}
                        state={
                          !on
                            ? 'skipped'
                            : o.needsReauth
                              ? 'needs-reauth'
                              : o.authorized
                                ? 'signed-in'
                                : 'needs-signin'
                        }
                        onToggle={() =>
                          void onToggle(id, o.authorized, async (removed) => {
                            await deleteUserVar(o.slug, o.varName);
                            removed();
                          })
                        }
                        action={
                          on ? (
                            <Button
                              variant="outline"
                              size="tiny"
                              onClick={() => void onAuthorizeTool(o.slug, o.varName)}
                            >
                              {o.authorized ? 'Reconnect' : 'Authorize'}
                            </Button>
                          ) : (
                            <IncludeButton onClick={() => void onToggle(id, false, async () => {})} />
                          )
                        }
                      />
                    );
                  })}
                  {/* Standalone OAuth secrets (registered directly, not via a tool). */}
                  {oauth.map((o) => (
                    <ConnectRow
                      key={o.id}
                      slug={o.id}
                      name={o.label || o.key}
                      label={o.label || o.key}
                      on
                      dim={false}
                      busy={false}
                      state={o.authorized ? 'signed-in' : 'needs-signin'}
                      action={
                        <Button
                          variant="outline"
                          size="tiny"
                          onClick={() => void onAuthorize(o.id)}
                        >
                          {o.authorized ? 'Reconnect' : 'Authorize'}
                        </Button>
                      }
                    />
                  ))}
                </Section>
              )}

              {tools.length > 0 && (
                <Section title="Keys">
                  {tools.map((tool) => {
                    const id = toolId(tool);
                    const configured = toolConfigured(tool);
                    // A tool whose every remaining variable belongs to somebody
                    // else offers nothing to opt into, so it gets no toggle —
                    // and cannot be "skipped by you", because you never had it.
                    const actionable = tool.variables.filter(isActionable);
                    const on = actionable.length === 0 || isOn(id);
                    const unset = actionable.filter((v) => !v.configured).length;
                    const ownerVar = tool.variables.find((v) => v.ownerOnly);
                    const state = !on
                      ? ('skipped' as const)
                      : unset > 0
                        ? ('needs-key' as const)
                        : ownerVar
                          ? ('owner-only' as const)
                          : ('key-saved' as const);
                    return (
                      <Surface
                        key={tool.slug}
                        tone="surface"
                        radius="xl"
                        elevation="card"
                        padded
                        className={cn((!on || state === 'owner-only') && 'opacity-60')}
                      >
                        <ConnectRowHead
                          slug={tool.slug}
                          name={tool.name}
                          label={tool.name}
                          on={on}
                          dim={!on || state === 'owner-only'}
                          busy={wiping.has(id)}
                          state={state}
                          reason={state === 'owner-only' && ownerVar ? ownerReason(ownerVar.name) : undefined}
                          onToggle={
                            actionable.length === 0
                              ? undefined
                              : () =>
                                  void onToggle(id, configured, async (removed) => {
                                    for (const v of actionable.filter((x) => x.configured)) {
                                      await deleteUserVar(tool.slug, v.name);
                                      removed();
                                    }
                                  })
                          }
                          action={
                            on ? undefined : (
                              <IncludeButton onClick={() => void onToggle(id, false, async () => {})} />
                            )
                          }
                        />
                        {on && (
                          <ul className="mt-3 flex flex-col gap-2">
                            {tool.variables.map((v) => (
                              <KeyRow
                                key={v.key}
                                name={v.name}
                                label={v.label}
                                configured={v.configured}
                                ownerOnly={v.ownerOnly}
                                save={(value) =>
                                  v.scope === 'admin'
                                    ? setAdminVar(tool.slug, v.name, value)
                                    : setUserVar(tool.slug, v.name, value)
                                }
                                onSaved={() => {
                                  announceToolCredentialsChanged();
                                  void refresh();
                                }}
                                onError={setError}
                              />
                            ))}
                          </ul>
                        )}
                      </Surface>
                    );
                  })}
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-7">
      <h2 className="mb-2.5 text-label uppercase text-ink-faint">{title}</h2>
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}

/**
 * The things a row can be — and the words for each.
 *
 * The same vocabulary the Library uses, because this is the page you land on to
 * FIX what the Library told you was broken and the two must not disagree about
 * what is wrong. "skipped" is the one non-status here: it is a choice you made,
 * not a state of the tool, so it stays grey.
 *
 * Two of the six are GREY on purpose, against the Library's rule that nothing
 * needing a person is grey — because the rule is about the person READING. A
 * workspace key only an owner can set, and a tool you took out yourself, both
 * need somebody; neither needs you, and drawing them amber beside the rows you
 * can actually fix is what makes a list of four unusable. They keep their place
 * in the count regardless: grey says "not yours", never "not counted".
 *
 * Note what is NOT here: `Connected`. This page knows only what is STORED, and
 * the one word that asserts a working connection is reserved for a probe that
 * actually called the provider — which only the tool page does. Two states
 * rather than one, because "signed in" and "key saved" describe two different
 * things the reader did, and telling someone a key was saved when they signed
 * in is a small lie of exactly the kind this vocabulary exists to stop.
 */
const ROW_STATE: Record<
  | 'signed-in'
  | 'key-saved'
  | 'needs-signin'
  | 'needs-reauth'
  | 'needs-key'
  | 'owner-only'
  | 'skipped',
  { text: string; tone: 'ok' | 'wait' | 'outline' }
> = {
  'signed-in': { text: 'Signed in', tone: 'ok' },
  'key-saved': { text: 'Key saved', tone: 'ok' },
  'needs-signin': { text: 'Needs your sign-in', tone: 'wait' },
  'needs-reauth': { text: 'Needs signing in again', tone: 'wait' },
  'needs-key': { text: 'Needs a key from you', tone: 'wait' },
  // The default for a row whose `reason` names no variable; every one this page
  // renders does name it, because "an owner" without "to set what" leaves the
  // reader with nothing to ask for.
  'owner-only': { text: 'Needs an owner', tone: 'outline' },
  skipped: { text: 'Skipped by you', tone: 'outline' },
};

interface RowHeadProps {
  slug: string;
  name: string;
  label: string;
  /** The include/skip toggle's position — what the agent may use. */
  on: boolean;
  /** Greyed: nothing here is the reader's to do. Not the same question as `on`. */
  dim: boolean;
  busy: boolean;
  state: keyof typeof ROW_STATE;
  /** Overrides the state's stock wording — used to name the awaited variable. */
  reason?: string;
  onToggle?: () => void;
  action?: React.ReactNode;
}

/** Mark, name, state, and (optionally) the control that fixes it. */
function ConnectRowHead({
  slug,
  name,
  label,
  on,
  dim,
  busy,
  state,
  reason,
  onToggle,
  action,
}: RowHeadProps) {
  const s = ROW_STATE[state];
  return (
    <div className="flex items-center gap-2.5">
      {onToggle && <IncludeToggle on={on} busy={busy} onChange={onToggle} />}
      <ToolLogo slug={slug} name={name} className={cn(dim && 'grayscale')} />
      <Link
        to={pathForTool(slug)}
        aria-label={`Open ${name}`}
        className={cn(
          'truncate rounded-xs text-ui font-semibold hover:underline',
          dim ? 'text-ink-faint' : 'text-ink',
        )}
      >
        {label}
      </Link>
      <Badge tone={s.tone} size="xs" className="shrink-0">
        {reason ?? s.text}
      </Badge>
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  );
}

/**
 * Put a skipped tool back. The checkbox beside the name does the same thing,
 * and this is here anyway: an unticked box in a greyed row reads as a record of
 * what happened, not as the way to undo it.
 */
function IncludeButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="outline" size="tiny" onClick={onClick}>
      Include
    </Button>
  );
}

function ConnectRow(props: RowHeadProps) {
  return (
    <Surface tone="surface" radius="lg" elevation="none" padded className="border border-line">
      <ConnectRowHead {...props} />
    </Surface>
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
  const label = on
    ? 'Skip this tool (removes your saved keys and sign-ins for it)'
    : 'Include this tool';
  return (
    <input
      type="checkbox"
      checked={on}
      disabled={busy}
      onChange={onChange}
      title={label}
      aria-label={label}
      className="size-3.5 shrink-0 accent-accent disabled:opacity-40"
    />
  );
}

/**
 * One variable of a tool: the field that sets it, or — when it is a workspace
 * value the reader may not write — the name of who has to.
 *
 * `save` rather than a slug plus a tier, because the three things a row can
 * write (your own key, the workspace's, a sign-in's client secret) are three
 * different calls and the row's job is the same in all three.
 */
function KeyRow({
  name,
  label,
  configured,
  ownerOnly,
  save: persist,
  onSaved,
  onError,
}: {
  name: string;
  label: string | null;
  configured: boolean;
  /** A workspace value the reader cannot set: no field, just the reason. */
  ownerOnly: boolean;
  save: (value: string) => Promise<void>;
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!value.trim()) return;
    setBusy(true);
    try {
      await persist(value.trim());
      setValue('');
      onSaved();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (ownerOnly) {
    return (
      <li className="flex items-center gap-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate text-detail text-ink-faint">{label || name}</span>
          <Badge tone="outline" size="xs" className="shrink-0">
            {ownerReason(name)}
          </Badge>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate text-detail text-ink-muted">{label || name}</span>
        <Badge tone={configured ? 'ok' : 'wait'} size="xs" className="shrink-0">
          {configured ? 'Set' : 'Needs a key'}
        </Badge>
      </div>
      {/* Write-only. The stored value is never fetched, rendered or logged —
          the field starts empty even for a configured key, and saving replaces
          rather than reveals. */}
      <TextField
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={configured ? 'Replace…' : 'Enter value'}
        aria-label={`${label || name} value`}
        className="w-44"
      />
      <Button
        variant="primary"
        size="sm"
        disabled={busy || !value.trim()}
        onClick={() => void save()}
      >
        Save
      </Button>
    </li>
  );
}
