export {
  DEFAULT_BOTS_DOMAIN,
  noBots,
  type BotChoice,
  type BotDefinition,
  type ConnectionChoice,
  type IBotAddresses,
  type IBotDirectory,
  type IBots,
  type Principal,
  type ResolvedConnection,
} from './bots.contract.js';
export { BotAddressBook, botAddress } from './bot-address-book.js';
export { describeConnectionChoices, type ConnectedAs } from './connected-as.js';
// The composition root's: the service, the address book and the routes it wires.
export { BotService } from './bot.service.js';
export { createBotsRoutes } from './bots.routes.js';
export { GrantRewriteChangeRequests, type DomainChange, type IGrantRewriter } from './bot-domain-change.js';
