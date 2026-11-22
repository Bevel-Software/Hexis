import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { logger } from '../../shared/logging.js';
import { canonicalEmail } from '../../shared/email-identity.js';
import type { Database } from '../database/index.js';
import { users } from '../database/index.js';
import { BotAddressBook, botAddress } from './bot-address-book.js';
import {
  DEFAULT_BOTS_DOMAIN,
  type BotChoice,
  type BotDefinition,
  type ConnectionChoice,
  type IBotDirectory,
  type IBots,
  type Principal,
  type ResolvedConnection,
} from './bots.contract.js';

const log = logger('bots');

/** The settings the bots read and write (`DeploymentSettingsService` is one). */
export interface BotSettings {
  resolve(key: string): string;
  record(entries: Record<string, string>, updatedBy: string | null): Promise<void>;
}

/** A bot id that can be the local part of an address: lowercase letters, digits, dots, hyphens and underscores. */
const BOT_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** What every refusal to act as a bot says about a duplicated id. */
export function duplicateIdProblem(id: string): string {
  return `two files share the id ${id}`;
}

/**
 * THE sentence a connection made as a bot answers with when the bot does not
 * exist for its maker: it is gone, or they may no longer act as it. One
 * sentence for both, so it discloses neither.
 */
export function goneSentence(label: string): string {
  return (
    `This connection was made as the bot "${label}", which no longer exists or which you may no longer act as, ` +
    'so it loads nothing. Make a new connection as yourself or as a bot you may act as.'
  );
}

/** The sentence for a bot its maker may act as but which cannot be used. */
export function unusableSentence(label: string, problem: string): string {
  return `This connection was made as the bot "${label}", which cannot be used (${problem}), so it loads nothing until that is fixed.`;
}

interface BotRow {
  id: string;
  botId: string;
  email: string;
  name: string;
  retiredAt: Date | null;
}

/**
 * The bots mechanism: keeps a users row for every bot the distribution names
 * (created when first named, retired when no longer named, brought back when
 * named again), answers who may act as which bot, and resolves what a
 * connection acts as on every call. Core owns this and none of the bots: the
 * definitions come from the distribution's {@link IBotDirectory}.
 */
export class BotService implements IBots {
  readonly addresses = new BotAddressBook();
  private rows = new Map<string, BotRow>();

  constructor(
    private readonly db: Database,
    private readonly settings: BotSettings,
    private readonly directory: IBotDirectory,
    /**
     * Whether change request `number` has been merged — what decides when a
     * grant at the previous bots' domain stops counting. Absent, a previous
     * domain counts until the next change.
     */
    private readonly changeRequestMerged?: (number: number) => Promise<boolean>,
  ) {}

  /** The bots' domain in effect. */
  domain(): string {
    return this.settings.resolve('botsDomain') || DEFAULT_BOTS_DOMAIN;
  }

  /**
   * Read the bots' rows into the address book. Call once at boot, before
   * anything is decided; {@link sync} keeps it current afterwards.
   */
  async load(): Promise<void> {
    const rows = await this.db
      .select({ id: users.id, botId: users.botId, email: users.email, name: users.name, retiredAt: users.botRetiredAt })
      .from(users)
      .where(isNotNull(users.botId));
    this.rows = new Map(rows.map((r) => [r.botId as string, { ...r, botId: r.botId as string }]));
    await this.refreshAddresses();
  }

  /**
   * Bring the rows in line with the distribution's definitions: a row for
   * every id it names (made the first time, brought back if it was retired,
   * renamed when its name changed), and every row it no longer names
   * retired, never deleted. Rejects when the definitions cannot be listed;
   * a failed listing retires nothing.
   */
  async sync(definitions?: readonly BotDefinition[]): Promise<Map<string, BotDefinition[]>> {
    const grouped = groupById(definitions ?? (await this.directory.definitions()));
    const now = new Date();
    for (const [id, defs] of grouped) {
      if (!BOT_ID.test(id)) continue;
      const name = defs[0].name.trim() || id;
      const row = this.rows.get(id);
      if (!row) {
        const address = botAddress(id, this.domain());
        const [made] = await this.db
          .insert(users)
          .values({ email: address, emailBidx: address, name, botId: id })
          .onConflictDoNothing()
          .returning({ id: users.id, email: users.email, name: users.name });
        if (made) {
          this.rows.set(id, { id: made.id, botId: id, email: made.email, name: made.name, retiredAt: null });
          log.info(`bot "${id}" has a row of its own now`);
        } else {
          // Another replica made it, or a PERSON holds the address: read what is there.
          const [existing] = await this.db
            .select({ id: users.id, botId: users.botId, email: users.email, name: users.name, retiredAt: users.botRetiredAt })
            .from(users)
            .where(eq(users.botId, id))
            .limit(1);
          if (existing) this.rows.set(id, { ...existing, botId: id });
        }
        continue;
      }
      if (row.retiredAt || row.name !== name) {
        await this.db
          .update(users)
          .set({ botRetiredAt: null, name, updatedAt: now })
          .where(eq(users.id, row.id));
        if (row.retiredAt) log.info(`bot "${id}" is back, with the grants its address still has`);
        this.rows.set(id, { ...row, retiredAt: null, name });
      }
    }
    for (const row of this.rows.values()) {
      if (grouped.has(row.botId) || row.retiredAt) continue;
      await this.db
        .update(users)
        .set({ botRetiredAt: now, updatedAt: now })
        .where(and(eq(users.id, row.id), isNull(users.botRetiredAt)));
      this.rows.set(row.botId, { ...row, retiredAt: now });
      // Retired, not deleted: its grants stay written, so the same id coming back inherits them.
      log.info(`bot "${row.botId}" is retired: nothing can act as it, and its grants stay until removed`);
    }
    await this.refreshAddresses();
    return grouped;
  }

  async choicesFor(actorEmail: string): Promise<BotChoice[]> {
    const grouped = await this.sync();
    const choices: BotChoice[] = [];
    for (const [id, defs] of grouped) {
      if (!(await this.mayActAsAny(actorEmail, defs))) continue;
      const first = defs[0];
      choices.push({
        id,
        name: first.name.trim() || id,
        description: first.description.trim(),
        address: botAddress(id, this.domain()),
        unavailable: this.problemOf(id, defs),
      });
    }
    return choices.sort((a, b) => a.name.localeCompare(b.name));
  }

  async actAs(actorEmail: string, botId: string): Promise<(Principal & { botId: string; name: string }) | null> {
    if (typeof botId !== 'string' || !botId) return null;
    const grouped = await this.sync();
    const defs = grouped.get(botId);
    if (!defs || this.problemOf(botId, defs) !== null) return null;
    if (!(await this.mayActAsAny(actorEmail, defs))) return null;
    const row = this.rows.get(botId);
    if (!row || row.retiredAt) return null;
    return { id: row.id, email: row.email, botId, name: row.name };
  }

  async resolveConnection(maker: Principal, choice: ConnectionChoice): Promise<ResolvedConnection> {
    if (!choice.botUserId && !choice.agentPath) return { kind: 'myself' };
    const grouped = await this.sync();
    let row: BotRow | undefined;
    let label: string;
    if (choice.botUserId) {
      row = [...this.rows.values()].find((r) => r.id === choice.botUserId);
      label = row?.name ?? 'unknown';
    } else {
      const path = choice.agentPath as string;
      const id = (await this.directory.botIdForAgentPath?.(path)) ?? null;
      row = id ? this.rows.get(id) : undefined;
      label = row?.name ?? path;
    }
    const gone = (): ResolvedConnection => ({
      kind: 'unavailable',
      bot: { id: row?.botId ?? label, name: label },
      sentence: goneSentence(label),
    });
    if (!row || row.retiredAt) return gone();
    const defs = grouped.get(row.botId);
    if (!defs || !(await this.mayActAsAny(maker.email, defs))) return gone();
    const problem = this.problemOf(row.botId, defs);
    if (problem !== null) {
      return { kind: 'unavailable', bot: { id: row.botId, name: label }, sentence: unusableSentence(label, problem) };
    }
    return {
      kind: 'bot',
      actor: { id: row.id, email: row.email },
      madeBy: maker,
      bot: { id: row.botId, name: row.name },
      platformTools: defs[0].platformTools,
    };
  }

  /** Why the bot `id`, defined by `defs`, cannot be used; null when it can. */
  private problemOf(id: string, defs: readonly BotDefinition[]): string | null {
    if (defs.length > 1) return duplicateIdProblem(id);
    if (!BOT_ID.test(id)) return 'its id cannot be an address';
    if (defs[0].problem) return defs[0].problem;
    const row = this.rows.get(id);
    // The address is a person's: the bot never got a row of its own.
    if (!row) return 'its address belongs to a person';
    return null;
  }

  private async mayActAsAny(actorEmail: string, defs: readonly BotDefinition[]): Promise<boolean> {
    const actor = canonicalEmail(actorEmail);
    for (const def of defs) {
      if (await this.directory.mayActAs(actor, def)) return true;
    }
    return false;
  }

  /** Rebuild the address book from the rows and the domain settings. */
  private async refreshAddresses(): Promise<void> {
    this.addresses.replace({
      domain: this.domain(),
      botIds: [...this.rows.keys()],
      previousDomain: await this.previousDomainInEffect(),
    });
  }

  /** The previous bots' domain while grants at it still count: until its change request is merged. */
  private async previousDomainInEffect(): Promise<string | null> {
    const previous = this.settings.resolve('botsPreviousDomain');
    if (!previous) return null;
    const number = Number(this.settings.resolve('botsDomainChangeRequest'));
    if (!this.changeRequestMerged || !Number.isInteger(number) || number <= 0) return previous;
    try {
      return (await this.changeRequestMerged(number)) ? null : previous;
    } catch (err) {
      // Cannot tell: the old spelling keeps counting rather than cutting a bot off.
      log.warn('could not read the domain change request; the previous domain still counts', { err });
      return previous;
    }
  }
}

function groupById(definitions: readonly BotDefinition[]): Map<string, BotDefinition[]> {
  const grouped = new Map<string, BotDefinition[]>();
  for (const def of definitions) {
    const id = typeof def.id === 'string' ? def.id.trim().toLowerCase() : '';
    if (!id) continue;
    const list = grouped.get(id) ?? [];
    list.push({ ...def, id });
    grouped.set(id, list);
  }
  return grouped;
}
