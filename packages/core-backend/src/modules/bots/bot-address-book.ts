import { canonicalEmail } from '../../shared/email-identity.js';
import { DEFAULT_BOTS_DOMAIN, type IBotAddresses } from './bots.contract.js';

/**
 * Which addresses are bots', held in memory so the access module can ask on
 * every decision without a round trip. Filled by `BotService` from the bots'
 * rows, and replaced whole whenever they change, so a reader never sees half
 * of a change.
 *
 * Retired bots stay in it: a retired bot's address is still a bot's, so a
 * grant naming it never makes it a person, and nothing can act as it anyway.
 */
export class BotAddressBook implements IBotAddresses {
  private addresses: ReadonlySet<string> = new Set();

  /** Replace what the book holds with the addresses of the bots `botIds`. */
  replace(botIds: readonly string[]): void {
    this.addresses = new Set(botIds.map((id) => botAddress(id)));
  }

  isBot(email: string): boolean {
    return this.addresses.has(canonicalEmail(email));
  }

  domain(): string {
    return DEFAULT_BOTS_DOMAIN;
  }
}

/** A bot's address: `<id>@agent.hexis`, canonical. */
export function botAddress(id: string): string {
  return canonicalEmail(`${id}@${DEFAULT_BOTS_DOMAIN}`);
}
