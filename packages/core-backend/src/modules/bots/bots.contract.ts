/**
 * Bots: identities of their own, granted like a person and connected as by
 * choice.
 *
 * A bot is a row of the users table marked as a bot (`users.bot_id`), with an
 * address of its own, `<id>@<bots' domain>`. It is granted access by that
 * address wherever a person can be, so the code that judges access, keeps
 * secrets and tool sign-ins, records authors and writes the audit log serves
 * it as it serves a person. What keeps a bot from being a person is a short
 * list of refusals at the places that decide each thing: it cannot sign in,
 * is not part of "everyone", holds no role and is no admin. It changes
 * access as any account does, judged by its own grants.
 *
 * Core owns the mechanism and none of the bots: which bots exist, what
 * defines one and who may act as it are the distribution's
 * ({@link IBotDirectory}, `CorePorts.bots`). Core's own default supplies none
 * ({@link noBots}), and a deployment without bots behaves as before they
 * existed.
 */

import type { Database } from '../database/index.js';

/** The bots' domain when no admin changed it. Not a domain anyone can own, so nothing can be mailed to a bot. */
export const DEFAULT_BOTS_DOMAIN = 'agent.hexis';

/** One definition of a bot, as the distribution reads it. Two definitions may share an id; then neither is usable. */
export interface BotDefinition {
  /** The bot's id: the local part of its address, and what its users row is keyed by. */
  id: string;
  /** Its name, as the "Connect as" choice shows it. */
  name: string;
  /** One line saying what it does; empty when it has none. */
  description: string;
  /**
   * What defines it, in the distribution's own terms (for the Bevel platform,
   * the path of its `.agent` file). Core never interprets it: it tells two
   * definitions of one id apart, and is handed back to
   * {@link IBotDirectory.mayActAs}.
   */
  source: string;
  /** Why the definition cannot be used (it is not valid), in one short phrase; null when it can. */
  problem: string | null;
  /** The platform tools a connection made as the bot is offered; null for all of them. */
  platformTools: readonly string[] | null;
}

/**
 * The distribution's bots: the port core reads them through. Every answer is
 * read when it is asked, never kept by core, so a changed definition reaches
 * the next call.
 */
export interface IBotDirectory {
  /**
   * Every definition the distribution reads, duplicates included: core tells
   * a duplicated id apart, not the distribution. Rejects when they cannot be
   * listed at all; that is a failed listing, never an empty one.
   */
  definitions(): Promise<readonly BotDefinition[]>;
  /**
   * Whether the holder of `actorEmail` may act as the bot `definition`
   * defines: only when they may WRITE what defines it. `actorEmail` is a
   * person's address or another bot's: a bot acts as another bot under the
   * same rule as a person.
   */
  mayActAs(actorEmail: string, definition: BotDefinition): Promise<boolean>;
  /**
   * The id of the bot that a connection made "as an agent" before bots
   * existed, and recorded as `agentPath`, is now made as; null when no bot
   * stands for that path. Absent: no recorded path stands for a bot.
   */
  botIdForAgentPath?(agentPath: string): Promise<string | null>;
}

/** Core's own directory: no bot at all. */
export function noBots(): IBotDirectory {
  return {
    definitions: async () => [],
    mayActAs: async () => false,
  };
}

/**
 * Which addresses are bots', asked synchronously wherever access is decided
 * (the access module owns the question; `BotAddressBook` answers it). An
 * address is canonical (lower case, trimmed) on the way in.
 */
export interface IBotAddresses {
  /** Whether `email` is a bot's address, at the current domain or at a previous one that still counts. */
  isBot(email: string): boolean;
  /**
   * Every address `email`'s bot is granted by: its current address, and its
   * address at the previous domain while that still counts (until the change
   * request rewriting the grants is merged). The current address is always
   * first, asked by either spelling. Just `[email]` for anyone else.
   */
  addressesOf(email: string): readonly string[];
  /** The bots' domain now in effect. */
  domain(): string;
}

/** The transaction a bots' domain change re-addresses the bots' rows in. */
export type BotsTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * What else records a bot by its address, moved with its row when the bots'
 * domain changes (version control answers it): the approvals, change
 * requests, merge attempts and queued saves that name it. In the
 * transaction that re-addresses the rows, in this order: `holdRecordWriters`
 * once, before any row is touched; then, per bot, its row and
 * `readdressIdentity`. So the rows and what names them never disagree, and a
 * failure leaves both at the old address.
 */
export interface IRecordedIdentity {
  holdRecordWriters(tx: BotsTx): Promise<void>;
  readdressIdentity(tx: BotsTx, from: string, to: string): Promise<void>;
}

/** A bot as the "Connect as" choice offers it. */
export interface BotChoice {
  /** The bot's id; what a connection asks to be made as. */
  id: string;
  name: string;
  description: string;
  /** Its address, `<id>@<domain>`. */
  address: string;
  /** Why it cannot be chosen, in one short phrase; null when it can. A disabled choice is still listed. */
  unavailable: string | null;
}

/**
 * Whom a credential's connection is made as, as recorded on it: a bot's row,
 * a path recorded before bots existed, or neither (Myself).
 */
export interface ConnectionChoice {
  /** The bot's users row; null for Myself. */
  botUserId: string | null;
  /** A legacy "as an agent" path; looked up through the directory on every call. */
  agentPath: string | null;
}

/** A person or a bot, by row and address. */
export interface Principal {
  id: string;
  email: string;
}

/**
 * What a connection acts as for one call, resolved from its credential's
 * {@link ConnectionChoice} on that call:
 *  - `myself`: the person who made it, as before bots existed;
 *  - `bot`: the bot's row (every check is judged for `actor`), with the
 *    person who made the connection kept as `madeBy`;
 *  - `unavailable`: the bot cannot be used or the person may no longer act
 *    as it; the connection loads nothing and `sentence` says why. Never the
 *    person's access.
 */
export type ResolvedConnection =
  | { kind: 'myself' }
  | {
      kind: 'bot';
      actor: Principal;
      madeBy: Principal;
      bot: { id: string; name: string };
      platformTools: readonly string[] | null;
    }
  | {
      kind: 'unavailable';
      /**
       * The bot the connection was made as, as far as it is known: its id and
       * name; when no bot answers to the connection any more, `id` is the
       * label it was made with (a legacy agent path, or `unknown`) and
       * `name` that label too. When one connection of a list could not be
       * judged (`resolveConnections`), `id` is what the connection names
       * (the bot's users row id, or a legacy agent path) and `name` the
       * legacy path, or "a bot".
       */
      bot: { id: string; name: string };
      /** The one sentence the connection answers with. */
      sentence: string;
      /** The same in a few words, for a list of connections ("you may no longer edit this bot"). */
      reason: string;
    };

/**
 * The bots mechanism, as the rest of core asks it. Implemented by
 * `BotService`; a service another module needs arrives as this contract.
 */
export interface IBots {
  /** The address book the access module decides with. */
  readonly addresses: IBotAddresses;
  /**
   * The bots `actorEmail` may act as, by name, with the ones that cannot be
   * used listed disabled. Rejects when the bots cannot be listed.
   */
  choicesFor(actorEmail: string): Promise<BotChoice[]>;
  /**
   * The bot `botId`'s row when `actorEmail` may act as it and it is usable;
   * else null — ONE answer for a bot that does not exist, one that cannot be
   * used and one the actor may not act as, so a refusal discloses none of
   * them.
   */
  actAs(actorEmail: string, botId: string): Promise<(Principal & { botId: string; name: string }) | null>;
  /** Resolve what a connection made by `maker` with `choice` acts as, now. */
  resolveConnection(maker: Principal, choice: ConnectionChoice): Promise<ResolvedConnection>;
  /**
   * The same for a LIST of connections, against one look at the bots: what
   * a list of connections shows, so the bots are listed once, not once per
   * connection.
   * A connection that cannot be judged is answered `unavailable` with that
   * reason, and the others are answered as usual. Rejects only when the
   * bots cannot be listed at all.
   */
  resolveConnections(requests: readonly { maker: Principal; choice: ConnectionChoice }[]): Promise<ResolvedConnection[]>;
}
