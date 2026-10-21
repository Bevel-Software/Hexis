import { useId } from 'react';
import { cn } from '../../../lib/utils';
import type { AgentChoice } from '../services/agent-choices.api';
import type { UnavailableChoice } from '../connect-as';

export interface ConnectAsChoiceProps {
  /** The agents the person may connect as; Everything is always offered first. */
  agents: readonly AgentChoice[];
  /** The chosen agent's path, or null for Everything. */
  value: string | null;
  onChange: (agentPath: string | null) => void;
  disabled?: boolean;
  /** One line under the heading, saying what the choice is for here. */
  hint?: string;
  /**
   * Set when the agents could not be loaded: the list is not "you have
   * none", so the choice says it failed and asks the person to confirm
   * Everything before the connection is made (see {@link canConnectAs}).
   */
  unavailable?: UnavailableChoice;
}

/**
 * "Connect as": Everything (selected by default) or one `.agent` file, by
 * name with its description. Used where a connection is made — the OAuth
 * consent step and the connection-key form — so both offer the same choice
 * the same way.
 */
export function ConnectAsChoice({ agents, value, onChange, disabled, hint, unavailable }: ConnectAsChoiceProps) {
  const name = useId();
  const options: { path: string | null; title: string; detail: string }[] = [
    {
      path: null,
      title: 'Everything',
      detail: 'Every tool, skill and plugin you may read.',
    },
    ...agents.map((a) => ({ path: a.path, title: a.name, detail: a.description || a.path })),
  ];
  return (
    <fieldset className="space-y-1.5" disabled={disabled}>
      <legend className="text-xs font-medium text-ink">Connect as</legend>
      {hint && <p className="text-meta text-ink-muted leading-snug">{hint}</p>}
      <div className="divide-y divide-line border border-line rounded-md">
        {options.map((o) => {
          const checked = value === o.path;
          return (
            <label
              key={o.path ?? ''}
              className={cn('flex items-start gap-2 px-3 py-2 cursor-pointer', checked && 'bg-sunken')}
            >
              <input
                type="radio"
                name={name}
                className="mt-0.5"
                checked={checked}
                onChange={() => onChange(o.path)}
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
          <p>Your agent files couldn't be loaded, so only Everything can be chosen right now.</p>
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={unavailable.confirmed}
              onChange={(e) => unavailable.onConfirm(e.target.checked)}
            />
            Connect as Everything anyway
          </label>
        </div>
      )}
    </fieldset>
  );
}
