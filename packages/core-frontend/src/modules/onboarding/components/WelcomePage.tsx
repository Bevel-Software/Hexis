import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Copy, X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button, IconButton } from '../../../shared/components';
import { useAuth } from '../../auth/state/auth.context';
import { useLibraryToast } from '../../library/state/toast';
import { copyToClipboard, COPY_FAILED_TOAST } from '../../library/utils/clipboard';
import { LIBRARY_ROOT } from '../../library/routes/library-paths';
import { AGENT_CLIENTS, mcpUrlFromOrigin, type AgentClient } from '../agent-clients';
import { useOnboarding } from '../state/onboarding';

/**
 * The welcome page — the first thing a new account sees, once.
 *
 * Three beats and nothing else (prototype `renderWelcome`): your name (so the
 * page is addressed, not broadcast), one sentence of what this place is, and
 * the single action the account still needs. It fades up on arrival; the
 * client picker re-renders in place, so the fade never replays as blinking.
 *
 * Mounting marks `welcomed`: the auto-redirect here happens on the FIRST
 * sign-in only. The page itself stays reachable forever — the sidebar pill
 * and a typed URL both land here — but the app never drags anyone back.
 *
 * "Done" concludes; it does not copy. A button whose word and act disagree
 * teaches people not to read buttons — the copy lives ON the snippet block,
 * and "Go to your library →" is the honest exit for someone who leaves
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

  const client = AGENT_CLIENTS.find((c) => c.id === clientId) ?? AGENT_CLIENTS[0]!;
  const snippet = client.snip(mcpUrlFromOrigin(window.location.origin));
  const firstName = (user?.name ?? '').trim().split(/\s+/)[0] || 'there';

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
    if (!ok) toast(COPY_FAILED_TOAST);
    window.clearTimeout(resetTimer.current);
    // Back to idle FIRST, so a repeat copy is a real state change and the
    // live region announces it again — setting 'ok' over 'ok' is a no-op that
    // says nothing to a screen reader.
    setCopied('idle');
    window.setTimeout(() => setCopied(ok ? 'ok' : 'fail'), 0);
    resetTimer.current = window.setTimeout(() => setCopied('idle'), 1500);
  }

  /**
   * Conclude the onboarding and leave for the library. The toast says where
   * the setup went, because a page that disappears for good on one click owes
   * you the way back — and the pill is about to vanish with it.
   */
  function done() {
    onboarding.markDone();
    toast('Done — reopen the setup any time from your profile menu → External agent access.');
    navigate(LIBRARY_ROOT);
  }

  return (
    <div className="mx-auto mt-[11vh] max-w-[440px] motion-safe:animate-[onboarding-fade_0.7s_cubic-bezier(0.2,0.8,0.2,1)_both]">
      <h1 className="text-display font-bold">Welcome, {firstName}</h1>
      <p className="mt-3 text-lede text-ink-muted">
        This is your company’s shared library — the skills, tools and knowledge your AI agents
        work from. Connect your agent once and access the skills and tools you need in one
        place.
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
        {AGENT_CLIENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === client.id}
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
          className="motion-safe:animate-[onboarding-pulse_2.4s_ease-out_infinite]"
        >
          Done
        </Button>
        <button
          type="button"
          onClick={() => navigate(LIBRARY_ROOT)}
          className="text-detail text-ink-faint transition-colors hover:text-ink"
        >
          Go to your library →
        </button>
      </div>
    </div>
  );
}
