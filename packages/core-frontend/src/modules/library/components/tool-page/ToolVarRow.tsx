import { useState, type ReactNode } from 'react';
import { Badge, Button, ListRow, TextField } from '../../../../shared/components';
import { startToolOAuth } from '../../../secrets-vault/services/connect.api';
import {
  deleteAdminVar,
  setAdminVar,
  setOAuthClientSecret,
  setUserVar,
  type ToolVarStatus,
} from '../../../secrets-vault/services/tool-secrets.api';
import { navigateExternal } from '../../utils/navigate-external';

/**
 * One `${VAR}` a tool declares, and the single next action for it.
 *
 * The matrix below is the whole point of this component. A variable is
 * described by five orthogonal-looking flags (`scope`, `oauth`,
 * `adminConfigured`, `userConfigured`, `authorized`/`needsReauth`) plus the
 * caller's `canWrite`, and the naive rendering of that is a row with four
 * competing controls on it. The rules that collapse it to ONE affordance:
 *
 *  - `adminConfigured` is OVERLOADED. On a typed variable it means "a shared
 *    value exists". On an OAuth variable it means "the owner finished the
 *    provider setup" — nothing about the caller's own sign-in. Reading it as
 *    "already handled" on an OAuth row would hide the Sign in button.
 *  - `oauth-auto` NEVER gets a client-secret affordance. Its client was
 *    auto-registered by PKCE dynamic registration and has no secret; saving one
 *    would clobber the discovered provider row and break sign-in for everyone.
 *  - Whose problem is it? A user-scope gap is the caller's to fix and always
 *    shows an action. An admin-scope gap is the OWNER's, so a non-writer sees a
 *    chip that explains the state and no button they can't act on.
 *
 * Secret values are write-only throughout: `type="password"`, held in local
 * state, cleared on save or cancel. Nothing here ever reads a stored value.
 */

export interface ToolVarRowProps {
  slug: string;
  variable: ToolVarStatus;
  /** The caller may set this tool's shared (owner-side) secrets. */
  canWrite: boolean;
  setupKind: 'open' | 'oauth-auto' | 'oauth-manual' | null;
  /** Where the OAuth round-trip should land — a bare path, no fragment. */
  returnTo: string;
  /**
   * This variable is REQUIRED and has no value yet.
   *
   * The section used to say this in a banner above the rows, which re-listed
   * every label and status the rows already carried. The row is where the
   * label, the status and the button live, so it is where the colour lives
   * too — and the count the banner used to give is now simply how many rows
   * are amber. Sighted readers get the tone; `sr-only` text carries the same
   * sentence to everyone else.
   */
  unset?: boolean;
  onChanged(): void;
  /**
   * A credential was WRITTEN (not deleted) — a typed value or an owner's client
   * secret. The one moment worth testing the connection, because it is the only
   * one that can turn a broken tool into a working one. Deletes still call
   * `onChanged`; they just have nothing to prove.
   */
  onSaved?(): void;
  onError(message: string): void;
}

type Editor = 'value' | 'client-secret' | null;

export function ToolVarRow({
  slug,
  variable,
  canWrite,
  setupKind,
  returnTo,
  unset = false,
  onChanged,
  onSaved,
  onError,
}: ToolVarRowProps) {
  const [editor, setEditor] = useState<Editor>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const label = variable.label ?? variable.name;

  function open(next: Exclude<Editor, null>) {
    setValue('');
    setEditor(next);
  }

  function close() {
    setValue('');
    setEditor(null);
  }

  /** Every write funnels through here so busy/close/report is identical. */
  async function run(action: () => Promise<void>, saved = false) {
    setBusy(true);
    try {
      await action();
      close();
      onChanged();
      if (saved) onSaved?.();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function signIn() {
    setBusy(true);
    try {
      const url = await startToolOAuth(slug, variable.name, { returnTo });
      navigateExternal(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
    // On success the browser is leaving; leaving `busy` set keeps the button
    // from being clicked twice during the redirect.
  }

  const meta: ReactNode[] = [];
  let description: string;

  if (variable.oauth) {
    // An OAuth client secret only exists for a MANUALLY declared provider.
    const mayEditClientSecret = canWrite && setupKind !== 'oauth-auto';

    if (variable.authorized && !variable.needsReauth) {
      description = 'Each person sets their own';
      // Connected is not final: a provider can widen what it grants after the
      // fact (HubSpot's MCP tools do, and answer REQUIRES_REAUTHORIZATION
      // until the user consents again), a grant can be revoked provider-side,
      // or the owner can rotate the client. The caller needs a way back into
      // consent that doesn't wait for the scope check to notice.
      meta.push(
        <Button key="reconnect" size="sm" variant="quiet" disabled={busy} onClick={() => void signIn()}>
          Reconnect
        </Button>,
        // "Signed in", not "Connected": at ROW level all we know is that a token
        // exists. Whether it still works is the tool-level health line's claim,
        // and it is the only place in the UI allowed to say "Connected" — one
        // word, one meaning, backed by a real call.
        <Badge key="chip" tone="ok">
          Signed in
        </Badge>,
      );
      if (mayEditClientSecret) {
        meta.push(
          <Button key="secret" size="sm" variant="quiet" onClick={() => open('client-secret')}>
            Replace client secret
          </Button>,
        );
      }
    } else if (variable.authorized) {
      description = 'Each person sets their own';
      meta.push(
        <Button key="reauth" size="sm" disabled={busy} onClick={() => void signIn()}>
          Sign in again
        </Button>,
      );
    } else if (variable.adminConfigured) {
      description = 'Each person sets their own';
      meta.push(
        <Button key="signin" size="sm" disabled={busy} onClick={() => void signIn()}>
          Sign in
        </Button>,
      );
    } else {
      // The owner hasn't declared the provider (or hasn't set its secret), so
      // there is nothing for anyone to sign in to yet.
      description = "The tool owner hasn't finished the sign-in setup yet.";
      if (mayEditClientSecret) {
        meta.push(
          <Button key="secret" size="sm" onClick={() => open('client-secret')}>
            Set client secret
          </Button>,
        );
      } else {
        meta.push(
          <Badge key="chip" tone="neutral">
            Not set
          </Badge>,
        );
      }
    }
  } else if (variable.scope === 'admin') {
    if (variable.adminConfigured) {
      description = 'One value for the whole team. Already handled';
      meta.push(
        <Badge key="chip" tone="ok">
          Set by an Admin
        </Badge>,
      );
      if (canWrite) {
        meta.push(
          <Button key="replace" size="sm" variant="quiet" onClick={() => open('value')}>
            Replace
          </Button>,
          <Button
            key="remove"
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={() => void run(() => deleteAdminVar(slug, variable.name))}
          >
            Remove
          </Button>,
        );
      }
    } else {
      // No "— already handled" here: the chip right next to it says the
      // opposite, and the prototype's single string contradicts itself once
      // the value is missing.
      description = 'One value for the whole team';
      if (canWrite) {
        meta.push(
          <Button key="set" size="sm" onClick={() => open('value')}>
            Set key
          </Button>,
        );
      } else {
        meta.push(
          <Badge key="chip" tone="neutral">
            Not set
          </Badge>,
        );
      }
    }
  } else {
    description = 'Each person sets their own';
    if (variable.userConfigured) {
      meta.push(
        // "Key saved", not "Connected": a stored value is the whole of what
        // this row knows. Whether it WORKS is the tool-level health line's
        // claim, and letting a row make it was how a mistyped key came to
        // render as a connection.
        <Badge key="chip" tone="ok">
          Key saved
        </Badge>,
      );
    } else {
      meta.push(
        <Button key="add" size="sm" onClick={() => open('value')}>
          Add key
        </Button>,
      );
    }
  }

  const isClientSecret = editor === 'client-secret';
  const save = () => {
    const secret = value;
    if (isClientSecret) {
      // Also a credential change: a replaced client secret can invalidate the
      // tokens minted under the old one, so the tool's health is now unknown
      // and worth re-testing — same as any other saved value.
      return run(() => setOAuthClientSecret(slug, variable.name, secret), true);
    }
    return run(
      () =>
        variable.scope === 'admin'
          ? setAdminVar(slug, variable.name, secret)
          : setUserVar(slug, variable.name, secret),
      true,
    );
  };

  // Ahead of the row's own action, so a screen reader reads the label, what
  // the variable is, that it is still needed, and then the button that
  // supplies it. `sr-only` is out of flow, so the sighted layout is untouched.
  if (unset) {
    meta.unshift(
      <span key="unset-sr" className="sr-only">
        Required, not set
      </span>,
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <ListRow
        density="row"
        label={label}
        description={description}
        meta={meta}
        data-testid="tool-var-row"
        // The Banner's own `wait` ground, so an unset row and the amber
        // notices elsewhere on this page read as the same state. The border
        // goes to full-strength `wait` rather than staying `line`: between two
        // white rows a tint alone is easy to scroll past, and being missable
        // is the entire complaint the banner existed to answer.
        className={unset ? 'border-wait bg-wait-soft' : undefined}
      />

      {editor && (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3.5 py-3">
          <TextField
            type="password"
            className="flex-1"
            autoComplete="off"
            aria-label={
              isClientSecret ? `Client secret for ${variable.name}` : `Value for ${variable.name}`
            }
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button variant="primary" size="sm" disabled={busy || !value} onClick={() => void save()}>
            Save
          </Button>
          <Button variant="quiet" size="sm" disabled={busy} onClick={close}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
