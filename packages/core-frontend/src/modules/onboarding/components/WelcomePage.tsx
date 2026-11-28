import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../shared/components';
import { useAuth } from '../../auth';
import { useLibraryToast, COPY_FAILED_TOAST, pathForLibraryFilter, displayFirstName } from '../../library';
import { useAppRegistry } from '../../../core/registry';
import { mcpEndpointUrl } from '../../../shared/mcp';
import { useOnboarding } from '../state/onboarding';
import { useAgentConnection } from '../state/agent-connection';
import { AgentConnectionStatus } from './AgentConnectionStatus';
import { AgentClientPicker } from './AgentClientPicker';

/**
 * The welcome page: how to connect your agent.
 *
 * Three beats and nothing else (prototype `renderWelcome`): your name (so the
 * page is addressed, not broadcast), one sentence of what this place is, and
 * the single action the account still needs. The client picker is
 * `AgentClientPicker`, the same one the External agent access page shows.
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
  // The deployment's own address, not the browser's: see `shared/mcp`.
  const mcpUrl = mcpEndpointUrl();
  // Capitalized here rather than at the call site — "Welcome, juan" is the app
  // misspelling someone to their face on the one page addressed to them.
  const firstName = displayFirstName(user?.name) || 'there';

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
   * The server says so the moment an agent makes its first call — which
   * every client does on connecting — through the `agent-connected` event
   * this page listens for; it asks once on arrival, and again on a return to
   * the tab, never on a timer. Connecting IS the onboarding, so it concludes
   * it: the pill goes and the Get set up step ticks, without asking for Done
   * as well. Once per visit — `markDone` drops its optimism again when the
   * server refuses, and a refusal must not turn into a request on every
   * render.
   *
   * Only while the onboarding is open: someone who finished it and came back
   * to copy a snippet is waiting on nothing. A connection this session has
   * already seen still shows.
   */
  const { showPill, markDone } = onboarding;
  const agent = useAgentConnection({ enabled: showPill });
  // The page waits for the agent once the reader has followed the link or
  // copied the snippet, not from the moment it opens.
  const [acted, setActed] = useState(false);
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

        {/* A failed copy is reported, never swallowed: the toast names the
            alternative (select the text) instead of leaving a button that
            silently did nothing. */}
        <AgentClientPicker
          mcpUrl={mcpUrl}
          onCopyFailed={() => toast(COPY_FAILED_TOAST, 'danger')}
          onAct={() => setActed(true)}
          className="mt-2.5"
        />

        <AgentConnectionStatus agent={agent} waiting={acted} className="mt-3.5" />

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
