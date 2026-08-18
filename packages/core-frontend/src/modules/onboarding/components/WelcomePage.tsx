import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import { setSidebarCollapsed } from '../../layout/state/sidebar';
import { ClaudeInstallLink, mcpEndpointUrl } from '../../../shared/mcp';
import { AGENT_CLIENTS, type AgentClient } from '../agent-clients';
import { useOnboarding } from '../state/onboarding';
import { useWelcomeRouteState } from '../welcome-state';

/**
 * The welcome page — the first thing a new account sees, once.
 *
 * Three beats and nothing else (prototype `renderWelcome`): your name (so the
 * page is addressed, not broadcast), one sentence of what this place is, and
 * the single action the account still needs. It arrives in two movements —
 * the greeting, then everything else — and the client picker re-renders in
 * place, so neither ever replays as blinking.
 *
 * Mounting marks `welcomed`: the auto-redirect here happens on the FIRST
 * sign-in only. The page itself stays reachable forever — the sidebar pill
 * and a typed URL both land here — but the app never drags anyone back.
 *
 * "Done" concludes; it does not copy. A button whose word and act disagree
 * teaches people not to read buttons — the copy lives ON the snippet block,
 * and "Go to your skills →" is the honest exit for someone who leaves
 * without connecting (it ends the redirect, never the pill).
 */
export function WelcomePage() {
  const { user } = useAuth();
  const onboarding = useOnboarding();
  const toast = useLibraryToast();
  const navigate = useNavigate();
  const [clientId, setClientId] = useState<AgentClient['id']>('claude');
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');

  // Once, on arrival — this is what makes the welcome redirect one-time.
  const { markWelcomed } = onboarding;
  useEffect(() => {
    markWelcomed();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- identity changes per render (bound closure); the act is idempotent per account
  }, []);

  /**
   * How you got here, and where you were going — read through the shared
   * parser, so this page and `WelcomeRoute` cannot drift apart about what an
   * arrival carries (see `welcome-state`).
   *
   * `greeting` is what everything ceremonial on this page hangs off.
   * `returnTo` is the deep link that survived the SSO round-trip, and it
   * retargets both exits: a welcome that concluded by discarding the page
   * someone was sent is a greeting that cost them the reason they came.
   */
  const { greeting, returnTo } = useWelcomeRouteState();

  /**
   * The entrance — and it belongs to the greeting alone.
   *
   * Being welcomed happens once. Opening the same page later from the pill is
   * a visit, and a 2.6s arrival every time you check your MCP snippet is a
   * page you learn to dread. So anyone who did not arrive by the sign-in
   * redirect starts ENTERED: no hold, no fade, the page simply exists.
   *
   * When it DOES play, it waits for a frame the browser actually paints. A CSS
   * animation runs on the document timeline, which advances in wall clock time
   * whether or not frames are being produced. This page mounts at the end of a
   * cold boot — the auth round trip, the router, the library shell — and if the
   * main thread is still busy when React inserts this DOM, the whole 2.2s can
   * elapse before the first paint. The animation does not look fast, it is
   * simply over by the time anyone sees it, and the page "just appears". No
   * timing value can be tuned out of that; the animation has to START on a
   * live frame.
   *
   * Two frames, not one: the first proves the browser is rendering again, the
   * second is the one the animation begins on. Until then the content is held
   * invisible, so the first painted state is the animation's own first state
   * rather than a flash of the finished page.
   *
   * Reduced motion also starts entered — the `motion-safe:` animations are
   * inert for them anyway, so a hold would be a blank page and nothing else.
   * `matchMedia` is optional-chained because jsdom has none.
   */
  const [entered, setEntered] = useState(
    () => !greeting || (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false),
  );
  useEffect(() => {
    if (entered) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- an arrival-time decision, settled at mount
  }, []);
  /**
   * An INLINE STYLE, not a `motion-safe:opacity-0` utility — and the reason is
   * scar tissue. Tailwind scans this package through a node_modules symlink
   * (`apps/web/src/index.css`), and a class first written mid-session is not
   * always compiled, so the hold silently did nothing and the page painted
   * fully formed. An entrance animation must not be hostage to whether the
   * stylesheet noticed a new class name.
   */
  const hold = entered ? undefined : ({ opacity: 0 } as const);
  /**
   * The animation classes go on ONLY for the greeting. `entered` alone is not
   * enough: a pill visit starts entered, so carrying the class would replay
   * the whole arrival on a page somebody deliberately navigated to.
   */
  const arriving = greeting && entered;

  /**
   * The nav gets out of the way for the greeting — and STAYS out.
   *
   * There is no restore, and that is the decision rather than an omission.
   * Putting it back on the way out meant Done handed you a page you did not
   * ask to have rearranged: you left a screen with no nav and arrived at one
   * where the nav had opened itself. Whether the sidebar is showing is a thing
   * you say with the toolbar toggle, and after the greeting it says whatever
   * it said last — collapsed, unless you opened it yourself while you were
   * here, in which case it stays open and this code never touches it again.
   *
   * Only for the greeting, so opening this page from the pill later never
   * rearranges the window around a page you deliberately navigated to.
   *
   * A LAYOUT effect, and that is the whole difference between "the nav is not
   * here" and "the nav flinched". `useEffect` runs after the browser paints,
   * so the first frame showed a full sidebar and the second began folding it
   * away — a flash of a thing you were never meant to see. Layout effects run
   * before paint: React re-renders synchronously, and the sidebar's width is
   * already zero in the only frame that is ever drawn. `instant` covers the
   * rest: there is nothing to transition from, and nobody gestured at it.
   *
   * The layout and this page mount in the same commit (`LibraryRoutes` — the
   * welcome route is a child of `LibraryLayout`, and neither is lazy), which
   * is what makes "before paint" mean before the sidebar's first paint too.
   */
  useLayoutEffect(() => {
    if (!greeting) return;
    setSidebarCollapsed(true, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- an arrival-time decision: how you got here cannot change while you are here
  }, []);

  const client = AGENT_CLIENTS.find((c) => c.id === clientId) ?? AGENT_CLIENTS[0]!;
  // The deployment's own address, not the browser's — see `shared/mcp`.
  const mcpUrl = mcpEndpointUrl();
  const snippet = client.snip(mcpUrl);
  // Capitalized by the same function that spells the plugin heading — "Welcome,
  // juan" over a sidebar reading "Juan's Plugin" is the app misspelling someone
  // to their face on the one page addressed to them.
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
   * make people confirm. Wraps at both ends: three options in a row have no
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

  // One timer, cleared before it is replaced: a second copy inside the 1.5s
  // window would otherwise inherit the FIRST copy's expiry and blank the
  // checkmark almost immediately.
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  /**
   * Copy the snippet currently on screen, and say so — as a checkmark for
   * anyone watching and as a live-region announcement for anyone not. A
   * failure is reported, never swallowed: the toast names the alternative
   * (select the text) instead of leaving a button that silently did nothing.
   */
  async function copySnippet() {
    const ok = await copyToClipboard(snippet);
    if (!ok) toast(COPY_FAILED_TOAST, 'danger');
    window.clearTimeout(resetTimer.current);
    // Back to idle FIRST, so a repeat copy is a real state change and the
    // live region announces it again — setting 'ok' over 'ok' is a no-op that
    // says nothing to a screen reader.
    setCopied('idle');
    window.setTimeout(() => setCopied(ok ? 'ok' : 'fail'), 0);
    resetTimer.current = window.setTimeout(() => setCopied('idle'), 1500);
  }

  // Both exits land in the same place. Whether you connected an agent or
  // walked past it, where you want to be next is somewhere you can start —
  // by default your own shelf, not the whole company's catalog. A deep link
  // still outranks it: someone who followed a link is owed that link.
  //
  // `welcomeExit` lets a distribution move that destination, because WHERE a
  // new person should start is a property of the product. A deployment built
  // around the knowledge graph would otherwise greet someone and then leave
  // them in a surface they did not come for. The label travels with the path
  // so the two cannot contradict each other.
  const { welcomeExit } = useAppRegistry();
  const defaultExit = { path: pathForLibraryFilter({ kind: 'ungrouped' }), label: 'Go to your skills' };
  const exit = welcomeExit ?? defaultExit;
  const exitTo = returnTo ?? exit.path;

  /**
   * Conclude the onboarding and leave. The toast says where the setup went,
   * because a page that disappears for good on one click owes you the way
   * back — and the pill is about to vanish with it.
   */
  function done() {
    onboarding.markDone();
    toast('Done. Reopen the setup any time from your profile menu → External agent access.');
    navigate(exitTo);
  }

  return (
    /* Two beats, not one. The greeting arrives on its own and is allowed to be
       read; the rest of the page follows once it has landed. A single fade over
       everything made the name and the setup instructions one event, and the
       name is the point of the page. Both timings live in `index.css` — see
       the note there on why they are named rather than arbitrary values.

       On the ELEMENTS rather than the page, because the page re-renders every
       time the client picker changes: a CSS animation on a surviving element
       does not restart, so the beats play once, on arrival, and switching
       between Claude and Cursor never reads as blinking. `motion-safe:` means
       `prefers-reduced-motion` gets both beats at once, immediately — `both`
       fill is what keeps them visible when the animation never runs. */
    <div className="mx-auto mt-[11vh] max-w-[440px]">
      <h1
        className={cn(
          'text-display font-bold',
          arriving && 'motion-safe:animate-onboarding-greeting',
        )}
        style={hold}
      >
        Welcome, {firstName}
      </h1>
      <div className={cn(arriving && 'motion-safe:animate-onboarding-body')} style={hold}>
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

        <p className="mt-2.5 text-meta leading-normal text-ink-faint">{client.hint}</p>

        {/* Claude only, because Claude is the only client with an install
            link — and it renders nothing at all when this deployment is one
            Anthropic could not reach, rather than offering a shortcut that
            dead-ends. No `showHint`: the reader here is a new employee, and
            naming an env var they cannot change is noise. The copy block
            below is the route that always works. */}
        {client.id === 'claude' && <ClaudeInstallLink mcpUrl={mcpUrl} className="mt-3.5" />}

        {/* The copy rides the block it copies. */}
        <div className="relative mt-3.5">
          <div
            className={cn(
              'overflow-x-auto rounded-lg border border-line bg-sunken py-2.5 pl-3 pr-10',
              'font-mono text-detail text-ink',
              snippet.includes('\n') ? 'whitespace-pre' : 'whitespace-nowrap',
            )}
          >
            {snippet}
          </div>
          <IconButton
            size={24}
            aria-label="Copy"
            title="Copy"
            onClick={() => void copySnippet()}
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

        <div className="mt-5 flex items-center gap-4">
          <Button
            variant="primary"
            onClick={done}
            className="motion-safe:animate-onboarding-pulse"
          >
            Done
          </Button>
          {/* The same destination Done goes to — one value drives both exits,
              so they cannot drift apart. Ordinarily that is wherever the
              deployment says a new person should start (core: your own shelf
              — "your skills" over "your library", since the library is the
              whole company's); when a deep link brought you here, both exits
              keep its promise instead, and the label says so. */}
          <button
            type="button"
            onClick={() => navigate(exitTo)}
            className="text-detail text-ink-faint transition-colors hover:text-ink"
          >
            {returnTo ? 'Continue to your link →' : `${exit.label} →`}
          </button>
        </div>
      </div>
    </div>
  );
}
