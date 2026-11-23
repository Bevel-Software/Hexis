import { AuthService, type BotAddressCheck } from '../modules/auth/auth.service.js';

/**
 * The auth service, constructed the way the composition root constructs it
 * (`core/create-core-services.ts`). A module's suite that drives routes which
 * take the real service — the access routes, which it guards — takes it from
 * HERE rather than constructing another module's implementation itself: the
 * auth entry holds the service's contract and the class behind it is the
 * root's to wire, as `real-disk.ts` stands in for the root for the disk.
 */
export function realAuthService(...args: ConstructorParameters<typeof AuthService>): AuthService {
  return new AuthService(...args);
}

/**
 * The bots' address check for a suite that exercises no bot: no address is a
 * bot's and there is no bots' domain. The service takes its check with no
 * default (the composition root passes the bot service's), so a suite that
 * means "no bots" says so with this.
 */
export const noBotAddresses: BotAddressCheck = { isBot: () => false, domain: () => '' };
