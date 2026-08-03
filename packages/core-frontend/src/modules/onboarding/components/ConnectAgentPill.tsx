import { useLocation, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useLibraryToast } from '../../library/state/toast';
import { useOnboarding } from '../state/onboarding';
import { WELCOME_PATH } from '../paths';

/**
 * The connect-your-agent reminder — a CTA wearing a nav row's geometry, at
 * the top of the Library sidebar (prototype `.navnudge`).
 *
 * It is the sidebar's ONLY filled accent, which is what makes it a clear
 * call to action, and it stays — across sign-ins, across browsers, because
 * `users.onboarding_done` is a server fact — until exactly two things: the ×
 * or the welcome page's Done. Once either happens the sidebar has no blue in
 * it at all.
 *
 * While you are ON the welcome page it wears the selected state and goes
 * QUIET: held at the hover depth, ring and dot still. A CTA stops calling
 * once you are standing where it points.
 *
 * Dismiss is its OWN button, never the row — clicking "connect" must not be
 * able to mean "never show me this again". One server field backs both
 * endings, so the × concludes the onboarding exactly as Done does; its label
 * says so rather than promising a "later" that will never be offered, and it
 * confirms out loud, because a control that removes itself owes you a word
 * about what just happened.
 */
export function ConnectAgentPill() {
  const onboarding = useOnboarding();
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const { pathname } = useLocation();
  const selected = pathname === WELCOME_PATH;

  if (!onboarding.showPill) return null;

  function dismiss() {
    onboarding.markDone();
    // The pill is about to unmount from under the pointer AND from under
    // keyboard focus. The toast is the acknowledgement and the receipt —
    // without it a screen-reader user gets silence and a focus reset with no
    // account of why.
    toast('Reminder dismissed — the setup lives in your profile menu, under External agent access.');
  }

  return (
    <div
      className={cn(
        'group/pill mb-1.5 flex flex-none items-center rounded-full transition-colors',
        selected
          ? 'bg-accent/15'
          : 'bg-accent/8 hover:bg-accent/15 motion-safe:animate-[onboarding-pulse_2.6s_ease-out_infinite]',
      )}
    >
      <button
        type="button"
        // `page`, not `true`: this control navigates, so the value that means
        // "this is the page you are on" is the one screen readers announce as
        // such.
        aria-current={selected ? 'page' : undefined}
        title="Connect Claude, ChatGPT, Cursor or another agent"
        onClick={() => navigate(WELCOME_PATH)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-full py-1.5 pl-3 pr-1 text-left text-ui font-medium text-accent"
      >
        <span
          aria-hidden
          className={cn(
            'size-1.5 flex-none rounded-full bg-accent',
            !selected && 'motion-safe:animate-[onboarding-blink_2.4s_ease-in-out_infinite]',
          )}
        />
        <span className="truncate">Connect your agent</span>
      </button>
      <button
        type="button"
        aria-label="Dismiss — the setup stays in your profile menu, under External agent access"
        title="Dismiss"
        onClick={dismiss}
        className={cn(
          'mr-1.5 flex size-[18px] flex-none items-center justify-center rounded-full text-ink-faint',
          // `pointer-events-none` is the whole point of pairing it with
          // opacity-0: an invisible-but-tappable 18px target that performs an
          // IRREVERSIBLE server write is a trap on any device without hover.
          // Touch users get it via the pill's own long-press/hover emulation
          // — or never, which is the safe failure.
          'pointer-events-none opacity-0 transition-[opacity,background-color,color]',
          'hover:bg-accent/15 hover:text-ink',
          'focus-visible:pointer-events-auto focus-visible:opacity-100',
          'group-hover/pill:pointer-events-auto group-hover/pill:opacity-100',
          'group-focus-within/pill:pointer-events-auto group-focus-within/pill:opacity-100',
        )}
      >
        <X size={11} aria-hidden />
      </button>
    </div>
  );
}
