import { BotAddressBook } from '../modules/bots/bot-address-book.js';

/**
 * The bots' address book, made the way the composition root makes it
 * (`core/create-core-services.ts`: one `BotAddressBook`, filled by the bot
 * service and handed to access, auth and version control). A module's suite
 * that needs a real book to decide who is a bot takes it from HERE rather than
 * from the bots module's entry, which carries its contract alone; this
 * fixture stands in for the root, as `real-disk.ts` does for the disk.
 */
export function botAddressBook(): BotAddressBook {
  return new BotAddressBook();
}

export type { BotAddressBook };
