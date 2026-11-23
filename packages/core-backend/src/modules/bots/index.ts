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
export { describeConnectionChoices, type ConnectedAs } from './connected-as.js';
// The service, the address book, the routes and the grant rewriter are the
// composition root's to wire: it imports them from their files.
