import { canonicalEmail } from '../../shared/email-identity.js';
import { DEFAULT_BOTS_DOMAIN, type IBotAddresses } from './bots.contract.js';

/**
 * Which addresses are bots', held in memory so the access module can ask on
 * every decision without a round trip. Filled by `BotService` from the bots'
 * rows and the domain settings, and replaced whole whenever either changes,
 * so a reader never sees half of a change.
 *
 * Retired bots stay in it: a retired bot's address is still a bot's, so a
 * grant naming it never makes it a person, and nothing can act as it anyway.
 */
export class BotAddressBook implements IBotAddresses {
  private state: {
    domain: string;
    /** Current address → itself, and previous-domain address → current address. */
    toCurrent: ReadonlyMap<string, string>;
    /** Current address → its address at the previous domain, while that still counts. */
    previous: ReadonlyMap<string, string>;
  } = { domain: DEFAULT_BOTS_DOMAIN, toCurrent: new Map(), previous: new Map() };

  /**
   * Replace what the book holds. `previousDomain` is the domain before the
   * last change while grants written at it still count; null once they do not.
   */
  replace(snapshot: { domain: string; botIds: readonly string[]; previousDomain: string | null }): void {
    const toCurrent = new Map<string, string>();
    const previous = new Map<string, string>();
    for (const id of snapshot.botIds) {
      const current = botAddress(id, snapshot.domain);
      toCurrent.set(current, current);
      if (snapshot.previousDomain && snapshot.previousDomain !== snapshot.domain) {
        const old = botAddress(id, snapshot.previousDomain);
        // A previous-domain address that is some other bot's current one stays that bot's.
        if (!toCurrent.has(old)) toCurrent.set(old, current);
        previous.set(current, old);
      }
    }
    // Second pass: a current address always wins over an alias set before it was seen.
    for (const id of snapshot.botIds) {
      const current = botAddress(id, snapshot.domain);
      toCurrent.set(current, current);
    }
    this.state = { domain: snapshot.domain, toCurrent, previous };
  }

  isBot(email: string): boolean {
    return this.state.toCurrent.has(canonicalEmail(email));
  }

  addressesOf(email: string): readonly string[] {
    const asked = canonicalEmail(email);
    const current = this.state.toCurrent.get(asked);
    if (current === undefined) return [asked];
    const old = this.state.previous.get(current);
    return old ? [current, old] : [current];
  }

  domain(): string {
    return this.state.domain;
  }
}

/** A bot's address: `<id>@<domain>`, canonical. */
export function botAddress(id: string, domain: string): string {
  return canonicalEmail(`${id}@${domain}`);
}
