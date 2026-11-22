import type { ConnectionChoice, IBots, Principal } from './bots.contract.js';

/**
 * Whom a connection the person made is connected as, as their connections
 * list shows it: "you", a bot by name, or a bot it stopped acting as with
 * the reason in a few words. Judged now, by the same resolution every call
 * of the connection runs, so the list and the connection never disagree.
 */
export type ConnectedAs =
  | { kind: 'myself' }
  | { kind: 'bot'; name: string; stopped: string | null };

/** Describe `choice`, made by `person`. Without a bots mechanism, a choice of a bot is stopped. */
export async function describeConnectionChoice(
  bots: Pick<IBots, 'resolveConnection'> | undefined,
  person: Principal,
  choice: ConnectionChoice,
): Promise<ConnectedAs> {
  if (!choice.botUserId && !choice.agentPath) return { kind: 'myself' };
  if (!bots) return { kind: 'bot', name: choice.agentPath ?? 'a bot', stopped: 'this deployment has no bots' };
  const resolved = await bots.resolveConnection(person, choice);
  if (resolved.kind === 'myself') return { kind: 'myself' };
  if (resolved.kind === 'bot') return { kind: 'bot', name: resolved.bot.name, stopped: null };
  return { kind: 'bot', name: resolved.bot.name, stopped: resolved.reason };
}
