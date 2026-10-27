export { canConnectAs, type UnavailableChoice } from './connect-as';
export { listAgentChoices, connectedAsLabel, type AgentChoice } from './services/agent-choices.api';
// The "Connect as" state both forms hold: the consent step and the key form
// settle it with the agents they loaded and read the choice back from it.
export { useConnectAsChoice, type AgentChoicesAnswer, type ConnectAsChoiceState } from './useConnectAsChoice';
