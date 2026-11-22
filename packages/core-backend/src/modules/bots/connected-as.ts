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

/** What a list shows for a connection made as a bot when the bots could not be listed at all. */
const NOT_CHECKED = 'could not be checked';

/**
 * Describe each connection of a list — `choice`, made by `maker` — against
 * one look at the bots, so the list's cost does not grow with its length.
 * Without a bots mechanism a choice of a bot is stopped; when the bots
 * cannot be listed, or one connection cannot be judged, that connection is
 * shown as not checked and the rest of the list still loads.
 */
export async function describeConnectionChoices(
  bots: Pick<IBots, 'resolveConnections'> | undefined,
  items: readonly { maker: Principal; choice: ConnectionChoice }[],
): Promise<ConnectedAs[]> {
  const asBot = (c: ConnectionChoice) => Boolean(c.botUserId || c.agentPath);
  if (!items.some((i) => asBot(i.choice))) return items.map(() => ({ kind: 'myself' }));
  if (!bots) {
    return items.map((i) =>
      asBot(i.choice) ? { kind: 'bot', name: i.choice.agentPath ?? 'a bot', stopped: 'this deployment has no bots' } : { kind: 'myself' },
    );
  }
  const resolved = await bots.resolveConnections(items).catch(() => null);
  return items.map((item, n): ConnectedAs => {
    if (!asBot(item.choice)) return { kind: 'myself' };
    const r = resolved?.[n];
    if (!r) return { kind: 'bot', name: item.choice.agentPath ?? 'a bot', stopped: NOT_CHECKED };
    if (r.kind === 'myself') return { kind: 'myself' };
    if (r.kind === 'bot') return { kind: 'bot', name: r.bot.name, stopped: null };
    return { kind: 'bot', name: r.bot.name, stopped: r.reason };
  });
}
