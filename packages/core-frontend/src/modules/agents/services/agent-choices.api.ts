import { authFetch } from '../../../lib/api';

/**
 * Connecting as a bot: an MCP connection or a connection key is made as
 * Myself (the person) or as a bot — an identity of its own, with its own
 * access, secrets and tool sign-ins — that the person may act as. Which bots
 * exist and what defines them is the distribution's; this mirrors the
 * backend's `modules/bots` contract.
 */

/** One bot the signed-in person may act as. */
export interface BotChoice {
  /** The bot's id: what a connection asks to be made as. */
  id: string;
  /** Its name, as the choice shows it. */
  name: string;
  /** Its description, one line; empty when it has none. */
  description: string;
  /** Its address, `<id>@<bots' domain>`. */
  address: string;
  /** Why it cannot be chosen, in a few words; null when it can. A disabled choice is still listed. */
  unavailable: string | null;
}

/** The bots a connection key may be minted as (the OAuth consent step gets the same list with its request). */
export async function listBotChoices(): Promise<BotChoice[]> {
  const res = await authFetch('/api/mcp/bot-choices');
  if (!res.ok) throw new Error("Couldn't load the bots you can connect as.");
  const body = (await res.json()) as { bots?: BotChoice[] };
  return Array.isArray(body.bots) ? body.bots : [];
}

/** Whom a connection the person made is connected as, as the server judged it for the listing. */
export type ConnectedAs = { kind: 'myself' } | { kind: 'bot'; name: string; stopped: string | null };

/**
 * How a connection reads in a list of connections: "Connected as you", or
 * as the bot by name — with, when it stopped, why ("stopped: you may no
 * longer edit this bot").
 */
export function connectedAsLabel(connectedAs: ConnectedAs | null | undefined): string {
  if (!connectedAs || connectedAs.kind === 'myself') return 'Connected as you';
  return connectedAs.stopped
    ? `Connected as ${connectedAs.name} · stopped: ${connectedAs.stopped}`
    : `Connected as ${connectedAs.name}`;
}
