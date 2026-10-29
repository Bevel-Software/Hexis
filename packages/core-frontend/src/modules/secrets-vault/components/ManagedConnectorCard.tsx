import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Surface, TextField } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { pathForTool, ToolLogo } from '../../library';
import type { ConnectToolOAuth } from '../services/connect.api';
import { managedCardState, type ManagedCardState } from '../utils/managed-card-state';

/**
 * One managed connector on the Connect page: what connecting lets Hexis do,
 * the permissions it asks for in plain words, and the one control the
 * reader has — Connect, Reconnect or Disconnect. A workspace connection
 * (one an owner makes for everyone) shows the same card to everyone and
 * offers the controls only to a writer of the tool. The states, and what
 * each means, are `managedCardState`'s; the words for each are below.
 */
const STATE_BADGE: Record<ManagedCardState, { text: string; tone: 'ok' | 'wait' | 'outline' | 'danger' }> = {
  unavailable: { text: 'Not available yet', tone: 'outline' },
  'owner-only': { text: 'Needs an owner', tone: 'outline' },
  ready: { text: 'Ready to connect', tone: 'wait' },
  connected: { text: 'Connected', tone: 'ok' },
  'needs-reconnect': { text: 'Needs reconnect', tone: 'wait' },
};

export interface ManagedConnectorCardProps {
  o: ConnectToolOAuth;
  busy: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  /** An owner brings the deployment's own OAuth app in place of the managed one. */
  onOwnApp?: (clientId: string, clientSecret: string) => Promise<void>;
}

export function ManagedConnectorCard({ o, busy, onConnect, onDisconnect, onOwnApp }: ManagedConnectorCardProps) {
  const m = o.managed!;
  const state = managedCardState(o);
  const badge = STATE_BADGE[state];
  const canAct = state !== 'unavailable' && state !== 'owner-only';
  const shared = m.tokenScope === 'shared';
  const [ownAppOpen, setOwnAppOpen] = useState(false);
  return (
    <Surface tone="surface" radius="xl" elevation="card" padded data-testid={`connector-${m.connectorId}`}>
      <div className="flex items-center gap-2.5">
        <ToolLogo slug={o.slug} name={m.displayName} className={cn(!canAct && 'grayscale')} />
        <Link
          to={pathForTool(o.slug)}
          aria-label={`Open ${m.displayName}`}
          className={cn('truncate text-ui font-semibold hover:underline', canAct ? 'text-ink' : 'text-ink-faint')}
        >
          {m.displayName}
        </Link>
        <Badge tone={badge.tone} size="xs" className="shrink-0">
          {state === 'connected' && m.account ? `Connected as ${m.account}` : badge.text}
        </Badge>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {canAct && (state === 'connected' || state === 'needs-reconnect') && (
            <Button variant="quiet" size="tiny" disabled={busy} onClick={onDisconnect}>
              Disconnect
            </Button>
          )}
          {canAct && (
            <Button variant={state === 'connected' ? 'outline' : 'primary'} size="tiny" disabled={busy} onClick={onConnect}>
              {state === 'connected' || state === 'needs-reconnect' ? 'Reconnect' : 'Connect'}
            </Button>
          )}
        </span>
      </div>
      <p className="mt-2 text-detail text-ink-muted">{m.description}</p>
      {m.permissions.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-detail text-ink-muted">
          {m.permissions.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-detail text-ink-faint">
        {shared ? 'One connection for the whole workspace, made by a tool owner.' : 'You connect your own account.'}
        {state === 'unavailable' && ' This deployment is not connected to a connector broker yet; ask your admin.'}
        {m.ownApp && ' Signing in through your organisation’s own app.'}
      </p>
      {onOwnApp && (
        <div className="mt-2">
          {ownAppOpen ? (
            <OwnAppForm
              onCancel={() => setOwnAppOpen(false)}
              onSave={async (id, secret) => {
                await onOwnApp(id, secret);
                setOwnAppOpen(false);
              }}
            />
          ) : (
            <Button variant="quiet" size="tiny" onClick={() => setOwnAppOpen(true)}>
              {m.ownApp ? 'Replace our own app' : 'Use our own app instead'}
            </Button>
          )}
        </div>
      )}
    </Surface>
  );
}

/**
 * "Use our own app": a regulated customer registers its own OAuth app with
 * the provider (redirect URI: this deployment's `/api/secrets/oauth/callback`)
 * and pins it here. From then on the sign-in runs from this deployment, not
 * the broker. Write-only, like every secret field on this page.
 */
function OwnAppForm({
  onSave,
  onCancel,
}: {
  onSave: (clientId: string, clientSecret: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-detail text-ink-muted">
        Register an OAuth app with the provider using this deployment&apos;s redirect URI
        (<code>/api/secrets/oauth/callback</code>), then enter its client id and secret.
      </p>
      <div className="flex items-center gap-2">
        <TextField value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client id" aria-label="Client id" className="w-44" />
        <TextField type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Client secret" aria-label="Client secret" className="w-44" />
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !clientId.trim() || !secret.trim()}
          onClick={() => {
            setBusy(true);
            setError(null);
            onSave(clientId.trim(), secret.trim())
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        >
          Save
        </Button>
        <Button variant="quiet" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-detail text-danger">{error}</p>}
    </div>
  );
}
