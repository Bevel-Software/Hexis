import { useState } from 'react';
import { useInRouterContext, useLocation, useNavigate } from 'react-router-dom';
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
  // This is passed into `SidebarFrame`'s `header` slot — by `LibraryLayout`
  // for Skills & Tools, by `CoreAppShell` for Knowledge — so the frame itself
  // stays domain-agnostic and never names the onboarding.
  //
  // The guard stays anyway, defensively: `useNavigate`/`useLocation` THROW
  // outside a Router, and a slot can be filled from anywhere, including a
  // future consumer or a test that renders bare. It lives here, in a
  // component whose only job is to decide, with the hooks one level down
  // where a Router is guaranteed. No router, no reminder: the pill's whole
  // purpose is to take you somewhere.
  if (!useInRouterContext()) return null;
  return <RoutedConnectAgentPill />;
}

function RoutedConnectAgentPill() {
  const onboarding = useOnboarding();
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const { pathname } = useLocation();
  const [announcement, setAnnouncement] = useState('');
  const selected = pathname === WELCOME_PATH;

  /**
   * The × — the same one-way server write as the welcome page's Done, not a
   * "remind me later" this app never implements. It ends the reminder
   * everywhere the account signs in, so it is worth the acknowledgement below.
   */
  function dismiss() {
    onboarding.markDone();
    const said =
      'Reminder dismissed — the setup lives in your profile menu, under External agent access.';
    // Said twice, on purpose, because the pill is about to unmount from under
    // the pointer AND from under keyboard focus. The toast is the visible
    // receipt but only exists inside the Library's provider; the live region
    // below is this component's own, survives the pill's removal, and is what
    // keeps the confirmation from going silent on Knowledge.
    toast(said);
    setAnnouncement(said);
  }

  // The live region is OUTSIDE the `showPill` guard so it is still mounted at
  // the moment the pill disappears — a region that unmounts in the same commit
  // as the thing it is announcing announces nothing.
  if (!onboarding.showPill) {
    return (
      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    );
  }

  return (
    <div
      className={cn(
        'group/pill mb-1.5 flex flex-none items-center rounded-full transition-colors',
        selected
          ? 'bg-accent/15'
          : 'bg-accent/8 hover:bg-accent/15 motion-safe:animate-onboarding-pulse-slow',
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
            !selected && 'motion-safe:animate-onboarding-blink',
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
