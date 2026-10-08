import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button, IconButton } from '../../../shared/components';
import { useAuth } from '../../auth/state/auth.context';
import { useLibraryToast } from '../../library/state/toast.context';
import { copyToClipboard, COPY_FAILED_TOAST } from '../../library/utils/clipboard';
import { pathForLibraryFilter } from '../../library/routes/library-paths';
import { useAppRegistry } from '../../../core/registry';
import { displayFirstName } from '../../library/utils/personal-plugin';
import { ChatGptInstallLink, ClaudeInstallLink, mcpEndpointUrl } from '../../../shared/mcp';
import { AGENT_CLIENTS, type AgentClient } from '../agent-clients';
import { useOnboarding } from '../state/onboarding';
import { useAgentConnection } from '../state/agent-connection';

/**
 * The welcome page: how to connect your agent.
 *
 * Three beats and nothing else (prototype `renderWelcome`): your name (so the
 * page is addressed, not broadcast), one sentence of what this place is, and
 * the single action the account still needs. The client picker re-renders in
 * place.
 *
 * Nobody is sent here: `/` lands on Knowledge (see `RootLanding`), so every
 * arrival is a visit — no entrance to play, no sidebar to fold away, no
 * carried link to honour. The page is reached from the sidebar pill, the Get
 * set up list and by URL, and stays reachable after the onboarding is done.
 *
 * "Done" concludes; it does not copy. A button whose word and act disagree
 * teaches people not to read buttons — the copy lives ON the snippet block,
 * and "Go to your skills →" is the honest exit for someone who leaves
 * without connecting (it concludes nothing; the pill stays).
 */
export function WelcomePage() {
  const { user } = useAuth();
  const onboarding = useOnboarding();
  const toast = useLibraryToast();
  const navigate = useNavigate();
  const [clientId, setClientId] = useState<AgentClient['id']>('claude');

  const client = AGENT_CLIENTS.find((c) => c.id === clientId) ?? AGENT_CLIENTS[0]!;
  // The deployment's own address, not the browser's — see `shared/mcp`.
  const mcpUrl = mcpEndpointUrl();
  const snippet = client.snip(mcpUrl);
  // Capitalized here rather than at the call site — "Welcome, juan" is the app
  // misspelling someone to their face on the one page addressed to them.
  const firstName = displayFirstName(user?.name) || 'there';

  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  /**
   * Arrow keys move the choice, because `role="radiogroup"` promised they
   * would. The role is not decoration — it tells a screen reader "these are
   * exclusive, one is always on", and the same standard that defines it also
   * defines how it is driven: arrows select, Tab leaves. Claiming the role
   * while only answering clicks describes a control the keyboard cannot work.
   *
   * Selection FOLLOWS focus, which is the pattern's default for a plugin this
   * cheap to change — picking a client re-renders one snippet, nothing is
   * submitted, so there is no cost to arriving on an option and no reason to
   * make people confirm. Wraps at both ends: four options in a row have no
   * meaningful edge to stop at.
   *
   * Paired with the roving `tabIndex` below — one stop for the whole plugin,
   * not one per option, so Tab moves past the picker rather than through it.
   */
  function onRadioKeyDown(event: React.KeyboardEvent, index: number) {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + AGENT_CLIENTS.length) % AGENT_CLIENTS.length;
    setClientId(AGENT_CLIENTS[next]!.id);
    radios.current[next]?.focus();
  }

  // Both exits land in the same place. Whether you connected an agent or
  // walked past it, where you want to be next is somewhere you can start —
  // by default your own shelf, not the whole company's catalog.
  //
  // `welcomeExit` lets a distribution move that destination, because WHERE a
  // new person should start is a property of the product. A deployment built
  // around the knowledge graph would otherwise greet someone and then leave
  // them in a surface they did not come for. The label travels with the path
  // so the two cannot contradict each other.
  const { welcomeExit } = useAppRegistry();
  const defaultExit = { path: pathForLibraryFilter({ kind: 'ungrouped' }), label: 'Go to your skills' };
  const exit = welcomeExit ?? defaultExit;

  /**
   * The answer to "did it work?", without having to go and check.
   *
   * Asked every few seconds while this page is open (and visible), and never
   * again once an agent has made its first call — which every client does on
   * connecting. Connecting IS the onboarding, so it concludes it: the pill
   * goes and the Get set up step ticks, without asking for Done as well.
   * Once per visit — `markDone` drops its optimism again when the server
   * refuses, and a refusal must not turn into a request on every render.
   *
   * Only while the onboarding is open: someone who finished it and came back
   * to copy a snippet is waiting on nothing, and a page polling every three
   * seconds for them is load with no reader. A connection this session has
   * already seen still shows.
   */
  const { showPill, markDone } = onboarding;
  const agent = useAgentConnection({ poll: true, enabled: showPill });
  const concluded = useRef(false);
  useEffect(() => {
    if (!agent.connected || concluded.current) return;
    concluded.current = true;
    if (showPill) markDone();
  }, [agent.connected, showPill, markDone]);

  /**
   * Conclude the onboarding and leave. The toast says where the setup went,
   * because a page that disappears for good on one click owes you the way
   * back — and the pill is about to vanish with it.
   */
  function done() {
    onboarding.markDone();
    toast('Done. Reopen the setup any time from your profile menu → External agent access.');
    navigate(exit.path);
  }

  return (
    <div className="mx-auto mt-[11vh] max-w-[440px]">
      <h1 className="text-display font-bold">Welcome, {firstName}</h1>
      <div>
        <p className="mt-3 text-lede text-ink-muted">
          This is your company’s shared library of the skills, tools and knowledge your AI
          agents work from. Connect your agent once and access the skills and tools you need in
          one place.
        </p>

        <div className="mt-9 text-label uppercase text-ink-faint">Connect your agent</div>

        {/* One snippet, chosen, instead of three printed at once: which client
            you use is a decision made before this page existed, so it is a
            control rather than something to scroll past.

            A radiogroup, not three `aria-pressed` toggles: these are mutually
            exclusive and one is always chosen, which is what `radio` means and
            what `pressed` does not — three independent toggles tell a screen
            reader that any combination, including none, is possible. */}
        <div
          role="radiogroup"
          aria-label="Your agent"
          className="mt-2.5 flex gap-0.5 rounded-lg bg-sunken p-0.5"
        >
          {AGENT_CLIENTS.map((c, i) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === client.id}
              // Roving: only the chosen option is a tab stop, so the plugin
              // costs ONE Tab rather than one per client.
              tabIndex={c.id === client.id ? 0 : -1}
              ref={(el) => {
                radios.current[i] = el;
              }}
              onKeyDown={(e) => onRadioKeyDown(e, i)}
              onClick={() => setClientId(c.id)}
              className={cn(
                'flex-1 whitespace-nowrap rounded-md px-2 py-1.5 text-detail transition-colors',
                c.id === client.id
                  ? 'bg-surface font-semibold text-ink shadow-card'
                  : 'text-ink-muted hover:text-ink',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>

        {Array.isArray(client.hint) ? (
          <ol className="mt-2.5 list-decimal space-y-0.5 pl-5 text-meta leading-normal text-ink-faint">
            {client.hint.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        ) : (
          <p className="mt-2.5 text-meta leading-normal text-ink-faint">{client.hint}</p>
        )}

        {/* The web assistants only: Claude's link prefills the connector,
            ChatGPT's opens the settings pane it is created in. Both render
            nothing at all when this deployment is one their vendor could not
            reach, rather than offering a shortcut that dead-ends. No
            `showHint`: the reader here is a new employee, and naming an env
            var they cannot change is noise. The copy block below is the route
            that always works. */}
        {client.id === 'claude' && <ClaudeInstallLink mcpUrl={mcpUrl} className="mt-3.5" />}
        {client.id === 'chatgpt' && <ChatGptInstallLink mcpUrl={mcpUrl} className="mt-3.5" />}

        {/* Other tools: the hint ends on "paste this instead:", so the bare
            address comes first, then the configuration it points back to.
            Many tools take a URL and nothing else. */}
        {client.id === 'other' && (
          <SnippetBlock value={mcpUrl} copyLabel="Copy address" className="mt-3.5" />
        )}

        {/* Keyed by client, so a checkmark earned on one option does not
            linger on the next option's snippet. */}
        <SnippetBlock key={client.id} value={snippet} copyLabel="Copy" className="mt-3.5" />

        {/* Quiet while it waits — a dot and a line, not a spinner demanding
            attention while someone is busy in another window — and plain
            about it when the agent arrives. Empty until the first answer is
            in, so someone already connected never sees "Waiting" flash past.
            The region exists from the start: a live region that appears
            together with its text is often not announced at all. */}
        <p role="status" aria-live="polite" className="mt-3.5 flex min-h-5 items-center gap-2 text-detail">
          {agent.connected ? (
            <>
              <Check size={13} aria-hidden className="flex-none text-ok" />
              <span className="text-ok">Connected. Your agent reached this knowledge base.</span>
            </>
          ) : agent.settled ? (
            <>
              <span aria-hidden className="size-1.5 flex-none rounded-full bg-wait-dot motion-safe:animate-pulse" />
              <span className="text-ink-faint">Waiting for your agent…</span>
            </>
          ) : null}
        </p>

        <div className="mt-4 flex items-center gap-4">
          <Button
            variant="primary"
            onClick={done}
            className="motion-safe:animate-onboarding-pulse"
          >
            Done
          </Button>
          {/* The same destination Done goes to — one value drives both exits,
              so they cannot drift apart: wherever the deployment says a new
              person should start (core: your own shelf — "your skills" over
              "your library", since the library is the whole company's). */}
          <button
            type="button"
            onClick={() => navigate(exit.path)}
            className="text-detail text-ink-faint transition-colors hover:text-ink"
          >
            {exit.label} →
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One snippet and the button that copies it — the copy rides the block it
 * copies. Its own component so a tab can carry two (Other tools shows the
 * bare address AND the configuration), each with its own checkmark.
 *
 * Copying says so as a checkmark for anyone watching and as a live-region
 * announcement for anyone not. A failure is reported, never swallowed: the
 * toast names the alternative (select the text) instead of leaving a button
 * that silently did nothing.
 */
function SnippetBlock({
  value,
  copyLabel,
  className,
}: {
  value: string;
  /** The button's accessible name — distinct per block when a tab has two. */
  copyLabel: string;
  className?: string;
}) {
  const toast = useLibraryToast();
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

  // One timer, cleared before it is replaced: a second copy inside the 1.5s
  // window would otherwise inherit the FIRST copy's expiry and blank the
  // checkmark almost immediately.
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function copy() {
    const ok = await copyToClipboard(value);
    if (!ok) toast(COPY_FAILED_TOAST, 'danger');
    window.clearTimeout(resetTimer.current);
    // Back to idle FIRST, so a repeat copy is a real state change and the
    // live region announces it again — setting 'ok' over 'ok' is a no-op that
    // says nothing to a screen reader.
    setCopied('idle');
    window.setTimeout(() => setCopied(ok ? 'ok' : 'fail'), 0);
    resetTimer.current = window.setTimeout(() => setCopied('idle'), 1500);
  }

  return (
    <div className={cn('relative', className)}>
      <div
        className={cn(
          'overflow-x-auto rounded-lg border border-line bg-sunken py-2.5 pl-3 pr-10',
          'font-mono text-detail text-ink',
          value.includes('\n') ? 'whitespace-pre' : 'whitespace-nowrap',
        )}
      >
        {value}
      </div>
      <IconButton
        size={24}
        aria-label={copyLabel}
        title={copyLabel}
        onClick={() => void copy()}
        className="absolute right-2 top-2"
      >
        {copied === 'ok' ? (
          <Check size={13} className="text-ok" />
        ) : copied === 'fail' ? (
          <X size={13} className="text-danger" />
        ) : (
          <Copy size={13} />
        )}
      </IconButton>
      {/* The icon's answer, said out loud for anyone not watching it. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied === 'ok' ? 'Copied' : copied === 'fail' ? 'Copy failed' : ''}
      </span>
    </div>
  );
}
