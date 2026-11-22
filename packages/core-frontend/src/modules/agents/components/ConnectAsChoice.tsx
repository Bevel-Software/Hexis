import { useId } from 'react';
import { cn } from '../../../lib/utils';
import type { BotChoice } from '../services/agent-choices.api';
import type { UnavailableChoice } from '../connect-as';

export interface ConnectAsChoiceProps {
  /** The bots the person may act as, the ones that cannot be used included; Myself is always offered first. */
  bots: readonly BotChoice[];
  /** The signed-in person's address, shown under Myself. */
  myselfEmail?: string;
  /** The chosen bot's id, or null for Myself. */
  value: string | null;
  onChange: (botId: string | null) => void;
  disabled?: boolean;
  /** One line under the heading, saying what the choice is for here. */
  hint?: string;
  /**
   * Set when the bots could not be loaded: the list is not "you have none",
   * so the choice says it failed and asks the person to confirm Myself
   * before the connection is made (see {@link canConnectAs}).
   */
  unavailable?: UnavailableChoice;
}

/**
 * "Connect as": Myself (selected by default), then each bot the person may
 * act as, by name with its description. A bot that cannot be used stays in
 * the list, disabled, with its reason on its own line. Used where a
 * connection is made — the OAuth consent step and the connection-key form —
 * so both offer the same choice the same way.
 *
 * With no bot on offer there is no choice to make, and nothing is shown: the
 * connection is the person's, as every connection was before bots existed.
 * The one exception is a listing that FAILED — then the person is told, and
 * confirms Myself, since bots may well exist.
 */
export function ConnectAsChoice({ bots, myselfEmail, value, onChange, disabled, hint, unavailable }: ConnectAsChoiceProps) {
  const name = useId();
  if (bots.length === 0 && !unavailable) return null;
  const options: { id: string | null; title: string; detail: string; disabled: boolean }[] = [
    {
      id: null,
      title: 'Myself',
      detail: myselfEmail ? `${myselfEmail} · everything you may read and write` : 'Everything you may read and write',
      disabled: false,
    },
    ...bots.map((b) => ({
      id: b.id,
      title: b.name,
      detail: b.unavailable
        ? `Cannot be used: ${b.unavailable}`
        : b.description
          ? `Bot · ${b.description}`
          : `Bot · ${b.address}`,
      disabled: b.unavailable !== null,
    })),
  ];
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-xs font-medium text-ink">Connect as</legend>
      {hint && <p className="text-meta text-ink-muted leading-snug">{hint}</p>}
      <div className="divide-y divide-line border border-line rounded-md">
        {options.map((o) => {
          const checked = value === o.id;
          return (
            <label
              key={o.id ?? ''}
              className={cn(
                'flex items-start gap-2 px-3 py-2',
                o.disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                checked && 'bg-sunken',
              )}
            >
              <input
                type="radio"
                name={name}
                className="mt-0.5"
                checked={checked}
                disabled={o.disabled}
                onChange={() => onChange(o.id)}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink truncate">{o.title}</span>
                <span className="block text-meta text-ink-muted leading-snug">{o.detail}</span>
              </span>
            </label>
          );
        })}
      </div>
      {unavailable && (
        <div role="alert" className="text-xs text-danger bg-danger-soft border border-danger rounded-md px-2 py-1.5 space-y-1">
          <p>Your bots couldn't be loaded, so only Myself can be chosen right now.</p>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={unavailable.confirmed}
              onChange={(e) => unavailable.onConfirm(e.target.checked)}
            />
            Connect as Myself anyway
          </label>
        </div>
      )}
    </fieldset>
  );
}
