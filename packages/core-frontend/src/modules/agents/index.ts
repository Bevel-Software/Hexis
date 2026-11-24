export { canConnectAs, type UnavailableChoice } from './connect-as';
export { listBotChoices, connectedAsLabel, type BotChoice, type ConnectedAs } from './services/agent-choices.api';
// The "Connect as" state both forms hold: the consent step and the key form
// settle it with the bots they loaded and read the choice back from it.
export { useConnectAsChoice, type BotChoicesAnswer, type ConnectAsChoiceState } from './useConnectAsChoice';
