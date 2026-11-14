import { useCallback, useMemo, useState } from 'react';
import { canConnectAs, type UnavailableChoice } from './connect-as';
import type { AgentChoice } from './services/agent-choices.api';

/** What the agents on offer answered: the list, or that they could not be loaded. */
export interface AgentChoicesAnswer {
  agents: readonly AgentChoice[];
  /** The agents could not be listed: `agents` is then empty for that reason, not because there are none. */
  failed?: boolean;
}

/**
 * The "Connect as" state a connection is made with — the one shape both
 * forms (the OAuth consent step, the connection-key form) hold, so the
 * agents module owns the consent state and each page only says when its
 * agents answered and what it does with the choice.
 */
export interface ConnectAsChoiceState {
  /** The agents on offer; Everything is always offered first. */
  agents: readonly AgentChoice[];
  /** The chosen agent's path, or null for Everything. */
  value: string | null;
  setValue: (agentPath: string | null) => void;
  /** Set when the agents could not be loaded: Everything waits for the person to confirm it. */
  unavailable: UnavailableChoice | undefined;
  /** Whether a connection may be made with the choice as it stands (see {@link canConnectAs}). */
  mayConnect: boolean;
  /**
   * The agents on offer have answered. `requestKey` names the request they
   * answered for, when the page waits on one in particular (the consent
   * step's authorization state): until that request's own answer is in,
   * Everything is not yet a choice anyone made.
   */
  settle: (answer: AgentChoicesAnswer, requestKey?: string) => void;
}

/**
 * The "Connect as" choice: Everything (null) unless the person picks an
 * agent, settled once the agents on offer answer. A remembered choice that is
 * no longer on offer falls back to Everything. With `expect`, the state is
 * settled only when the answer named that request; without it, by any answer.
 */
export function useConnectAsChoice(opts: { initial?: string | null | (() => string | null); expect?: string | null } = {}): ConnectAsChoiceState {
  const [agents, setAgents] = useState<readonly AgentChoice[]>([]);
  const [value, setValue] = useState<string | null>(opts.initial ?? null);
  const [failed, setFailed] = useState(false);
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const [everythingConfirmed, setEverythingConfirmed] = useState(false);

  const settle = useCallback((answer: AgentChoicesAnswer, requestKey = '') => {
    setAgents(answer.agents);
    setFailed(answer.failed === true);
    // A remembered choice that is no longer on offer falls back to Everything.
    setValue((current) => (current && answer.agents.some((a) => a.path === current) ? current : null));
    setSettledFor(requestKey);
  }, []);

  const unavailable = useMemo<UnavailableChoice | undefined>(
    () => (failed ? { confirmed: everythingConfirmed, onConfirm: setEverythingConfirmed } : undefined),
    [failed, everythingConfirmed],
  );
  const settled = opts.expect === undefined ? settledFor !== null : opts.expect != null && settledFor === opts.expect;
  const mayConnect = canConnectAs({ settled, unavailable });

  return { agents, value, setValue, unavailable, mayConnect, settle };
}
