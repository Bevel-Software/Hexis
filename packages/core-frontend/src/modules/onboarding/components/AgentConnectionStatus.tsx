import { Check } from 'lucide-react';
import { cn, formatRelativeTime } from '../../../lib/utils';
import type { AgentConnectionState } from '../state/agent-connection';

/**
 * The answer to "did it work?", under the connection snippet, without having
 * to go and check.
 *
 * Quiet while it waits (a dot and a line, not a spinner demanding attention
 * while someone is busy in another window) and plain about it when the agent
 * arrives. Empty until the first answer is in, so someone already connected
 * never sees "Waiting" flash past. The region exists from the start: a live
 * region that appears together with its text is often not announced at all.
 *
 * Takes the state rather than reading it, so the page decides when to ask:
 * the welcome page only while the onboarding is open, the External agent
 * access page always.
 */
export function AgentConnectionStatus({
  agent,
  detail = false,
  waiting = true,
  className,
}: {
  agent: AgentConnectionState;
  /**
   * Name the agent and say when it last reached this knowledge base. For a
   * page someone returns to: "Connected" alone cannot tell them whether the
   * agent they are setting up now is the one that got through.
   */
  detail?: boolean;
  /**
   * Show "Waiting for your agent…" while nothing has connected. A page passes
   * false until the reader has followed the link or copied the snippet: a
   * wait that starts before any action reads as something stuck.
   */
  waiting?: boolean;
  className?: string;
}) {
  const when = detail ? formatRelativeTime(agent.at) : '';
  return (
    <p role="status" aria-live="polite" className={cn('flex min-h-5 items-center gap-2 text-detail', className)}>
      {agent.connected ? (
        <>
          <Check size={13} aria-hidden className="flex-none text-ok" />
          <span className="text-ok">
            {detail
              ? `Connected. ${agent.client || 'Your agent'} reached this knowledge base${when ? ` ${when}` : ''}.`
              : 'Connected. Your agent reached this knowledge base.'}
          </span>
        </>
      ) : agent.settled && waiting ? (
        <>
          <span aria-hidden className="size-1.5 flex-none rounded-full bg-wait-dot motion-safe:animate-pulse" />
          <span className="text-ink-muted">Waiting for your agent…</span>
        </>
      ) : null}
    </p>
  );
}
