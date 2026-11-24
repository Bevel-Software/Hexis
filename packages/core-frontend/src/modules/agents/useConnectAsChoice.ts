import { useCallback, useMemo, useState } from 'react';
import { canConnectAs, type UnavailableChoice } from './connect-as';
import type { BotChoice } from './services/agent-choices.api';

/** What the bots on offer answered: the list, or that they could not be loaded. */
export interface BotChoicesAnswer {
  bots: readonly BotChoice[];
  /** The bots could not be listed: `bots` is then empty for that reason, not because there are none. */
  failed?: boolean;
}

/**
 * The "Connect as" state a connection is made with — the one shape both
 * forms (the OAuth consent step, the connection-key form) hold, so the
 * agents module owns the choice and each page only says when its bots
 * answered and what it does with the choice.
 */
export interface ConnectAsChoiceState {
  /** The bots on offer, the ones that cannot be used included; Myself is always offered first. */
  bots: readonly BotChoice[];
  /** The chosen bot's id, or null for Myself. */
  value: string | null;
  setValue: (botId: string | null) => void;
  /** Set when the bots could not be loaded: Myself waits for the person to confirm it. */
  unavailable: UnavailableChoice | undefined;
  /** Whether a connection may be made with the choice as it stands (see {@link canConnectAs}). */
  mayConnect: boolean;
  /**
   * The bots on offer have answered. `requestKey` names the request they
   * answered for, when the page waits on one in particular (the consent
   * step's authorization state): until that request's own answer is in,
   * Myself is not yet a choice anyone made.
   */
  settle: (answer: BotChoicesAnswer, requestKey?: string) => void;
}

/**
 * The "Connect as" choice: Myself (null) unless the person picks a bot,
 * settled once the bots on offer answer. A remembered choice that is no
 * longer on offer, or can no longer be used, falls back to Myself. With
 * `expect`, the state is settled only when the answer named that request;
 * without it, by any answer.
 */
export function useConnectAsChoice(opts: { initial?: string | null | (() => string | null); expect?: string | null } = {}): ConnectAsChoiceState {
  const [bots, setBots] = useState<readonly BotChoice[]>([]);
  const [value, setValue] = useState<string | null>(opts.initial ?? null);
  const [failed, setFailed] = useState(false);
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const [myselfConfirmed, setMyselfConfirmed] = useState(false);

  const settle = useCallback((answer: BotChoicesAnswer, requestKey = '') => {
    setBots(answer.bots);
    setFailed(answer.failed === true);
    setValue((current) =>
      current && answer.bots.some((b) => b.id === current && b.unavailable === null) ? current : null,
    );
    setSettledFor(requestKey);
  }, []);

  const unavailable = useMemo<UnavailableChoice | undefined>(
    () => (failed ? { confirmed: myselfConfirmed, onConfirm: setMyselfConfirmed } : undefined),
    [failed, myselfConfirmed],
  );
  const settled = opts.expect === undefined ? settledFor !== null : opts.expect != null && settledFor === opts.expect;
  const mayConnect = canConnectAs({ settled, unavailable });

  return { bots, value, setValue, unavailable, mayConnect, settle };
}
