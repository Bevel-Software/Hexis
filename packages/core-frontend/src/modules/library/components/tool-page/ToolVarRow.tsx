import { useEffect, useRef, useState, type ReactNode } from 'react';
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
   * Bumped by the section's banner to open this row's editor from a distance
   * ("Add key" up top is the same act as "Add key" on the row). Monotonic
   * counter rather than a boolean so pressing the banner twice re-opens a row
   * the user has since cancelled.
   */
  editSignal?: number;
  onChanged(): void;
  onError(message: string): void;
}

type Editor = 'value' | 'client-secret' | null;

export function ToolVarRow({
  slug,
  variable,
  canWrite,
  setupKind,
  returnTo,
  editSignal,
  onChanged,
  onError,
}: ToolVarRowProps) {
  const [editor, setEditor] = useState<Editor>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const label = variable.label ?? variable.name;

  // Opening from a distance is a PROP CHANGE, not an event, so the editor state
  // is adjusted during render against the previous signal — React's documented
  // pattern for deriving state from a changed prop. It used to be an effect,
  // which set state after paint: one frame of the row rendered closed, and the
  // synchronous setState in an effect body is what `set-state-in-effect` flags.
  // `seenSignal` starts undefined rather than at `editSignal` so a row that
  // MOUNTS with a signal already on it still opens, as the effect version did.
  const [seenSignal, setSeenSignal] = useState<number | undefined>(undefined);
  if (editSignal !== seenSignal) {
    setSeenSignal(editSignal);
    if (editSignal) {
      setValue('');
      setEditor('value');
    }
  }

  // The scroll stays an effect: it is a real DOM side effect and has to happen
  // after the editor it scrolls to has been committed. The banner's button
  // targets exactly one row; scrolling brings the editor to where the click
  // happened conceptually — "fix THIS".
  useEffect(() => {
    if (!editSignal) return;
    rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [editSignal]);

  function open(next: Exclude<Editor, null>) {
    setValue('');
    setEditor(next);
  }

  function close() {
    setValue('');
    setEditor(null);
  }

  /** Every write funnels through here so busy/close/report is identical. */
  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      close();
      onChanged();
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
      meta.push(
        <Badge key="chip" tone="ok">
          Connected
        </Badge>,
      );
      if (mayEditClientSecret) {
        meta.push(
          <Button key="secret" size="tiny" variant="quiet" onClick={() => open('client-secret')}>
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
          <Button key="secret" size="tiny" onClick={() => open('client-secret')}>
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
          <Button key="replace" size="tiny" variant="quiet" onClick={() => open('value')}>
            Replace
          </Button>,
          <Button
            key="remove"
            size="tiny"
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
          <Button key="set" size="tiny" onClick={() => open('value')}>
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
        <Badge key="chip" tone="ok">
          Connected
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
      return run(() => setOAuthClientSecret(slug, variable.name, secret));
    }
    return run(() =>
      variable.scope === 'admin'
        ? setAdminVar(slug, variable.name, secret)
        : setUserVar(slug, variable.name, secret),
    );
  };

  return (
    <div ref={rootRef} className="flex flex-col gap-1.5">
      <ListRow density="row" label={label} description={description} meta={meta} />

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
