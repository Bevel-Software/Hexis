import { useState } from 'react';
import { Badge, Button, TextField } from '../../../shared/components';
import {
  type AgentSecrets,
  type AgentVarStatus,
  setAgentVar,
  deleteAgentVar,
} from '../services/agent-secrets.api';

/**
 * Configure one agent's secrets — the `from: vault` half of its `.agent`
 * file's declared environment.
 *
 * Simpler than the tool panel on purpose: there is one tier (shared), no
 * sign-in flow, and the only gate is write access to the `.agent`. It keeps the
 * same status vocabulary — `Set` / `Needs a key` — and the same write-only
 * fields, because someone arriving here from the tool panels above must not
 * meet a second grammar for the same state.
 */
export function AgentSecretsPanel({ agent, onChanged }: { agent: AgentSecrets; onChanged: () => void }) {
  return (
    <div>
      <p className="mb-1.5 text-detail text-ink-muted">
        {agent.canWrite
          ? 'Injected into the environment of every session this agent runs.'
          : 'Only someone who can edit this agent can set what it is given.'}
      </p>
      <ul className="flex flex-col gap-1.5">
        {agent.variables.map((v) => (
          <AgentVarRow key={v.name} slug={agent.slug} v={v} editable={agent.canWrite} onChanged={onChanged} />
        ))}
      </ul>
    </div>
  );
}

function AgentVarRow({
  slug,
  v,
  editable,
  onChanged,
}: {
  slug: string;
  v: AgentVarStatus;
  editable: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setValue('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="flex items-center gap-2">
        <code className="rounded-sm bg-sunken px-1 py-0.5 font-mono text-meta text-ink">{v.name}</code>
        <Badge tone={v.configured ? 'ok' : 'wait'} size="xs" className="shrink-0">
          {v.configured ? 'Set' : 'Needs a key'}
        </Badge>
        {editable && v.configured && (
          <Button
            variant="quiet"
            size="tiny"
            className="ml-auto"
            aria-label={`Remove ${v.name}`}
            disabled={busy}
            onClick={() => void run(() => deleteAgentVar(slug, v.name))}
          >
            Remove
          </Button>
        )}
      </div>
      {v.label && <p className="mt-1 text-detail text-ink-muted">{v.label}</p>}
      {editable && (
        <div className="mt-1.5 flex gap-1.5">
          {/* Write-only, as everywhere else: the field starts empty even when a
              value exists, and saving replaces rather than reveals. */}
          <TextField
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={v.configured ? 'Replace value…' : 'Enter value…'}
            aria-label={`Value for ${v.name}`}
            className="min-w-0 flex-1"
          />
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !value}
            onClick={() => void run(() => setAgentVar(slug, v.name, value))}
          >
            Save
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-detail text-danger">
          {error}
        </p>
      )}
    </li>
  );
}
