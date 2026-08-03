import { useLocation, useNavigate } from 'react-router-dom';
import { X } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { useOnboarding } from '../state/onboarding';
import { WELCOME_PATH } from '../paths';

/**
 * The connect-your-agent reminder — a CTA wearing a nav row's geometry, at
 * the top of the Library sidebar (prototype `.navnudge`).
 *
 * It is the sidebar's ONLY filled accent, which is what makes it a clear
 * call to action, and it stays — across sign-ins — until exactly two things:
 * the × or the welcome page's Done. Once either happens the sidebar has no
 * blue in it at all.
 *
 * While you are ON the welcome page it wears the selected state and goes
 * QUIET: held at the hover depth, ring and dot still. A CTA stops calling
 * once you are standing where it points.
 *
 * Dismiss is its OWN button, never the row — clicking "connect" must not be
 * able to mean "never show me this again". It is grey (only the invitation
 * gets the accent) and hover-revealed, like the sidebar's other quiet
 * affordances. One server field backs both endings, so the × concludes the
 * onboarding exactly as Done does — its label says so rather than promising
 * a "later" that will never be offered.
 */
export function ConnectAgentPill() {
  const onboarding = useOnboarding();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const selected = pathname === WELCOME_PATH;

  if (!onboarding.showPill) return null;

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
        aria-current={selected}
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
        aria-label="Dismiss — you can reopen the setup from your profile menu, under External agent access"
        title="Dismiss"
        onClick={onboarding.markDone}
        className={cn(
          'mr-1.5 flex size-[18px] flex-none items-center justify-center rounded-full text-ink-faint',
          'opacity-0 transition-[opacity,background-color,color] hover:bg-accent/15 hover:text-ink',
          'focus-visible:opacity-100 group-hover/pill:opacity-100',
        )}
      >
        <X size={11} aria-hidden />
      </button>
    </div>
  );
}
