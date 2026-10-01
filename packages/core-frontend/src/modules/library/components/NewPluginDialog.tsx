import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, TextField } from '../../../shared/components';
import { createPlugin } from '../services/plugins.api';
import { pathForPlugin } from '../routes/library-paths';
import { useLibraryToast } from '../state/toast.context';

export interface NewPluginDialogProps {
  /** Names already taken — readable plugins AND locked ones. */
  existing: string[];
  /**
   * The grouping folder below the plugins root to make the plugin in
   * (`Teams`, `Teams/EU`) — where a person right-clicked in the Plugins tree.
   * Empty or absent: the root. The dialog says where the plugin will go.
   */
  parent?: string;
  onClose(): void;
  /** The catalog and the plugin index both have to hear about a new folder. */
  onCreated(): void;
}

/**
 * Make a plugin — the prototype's `newSpaceModal` (line 2769).
 *
 * A plugin IS a folder, and the folder comes from the DEDICATED provisioning
 * endpoint (`POST /api/plugins`) — the one privileged door for claiming a name
 * under `Plugins/`. The endpoint writes the folder's `access.md` naming the
 * creator under read, write and owner (with the file itself readable by
 * everyone, so the plugin is discoverable and joinable) and commits it before
 * answering. So there is no access step in this dialog: by the time the
 * response arrives, the plugin exists and it is yours.
 */
export function NewPluginDialog({ existing, parent = '', onClose, onCreated }: NewPluginDialogProps) {
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  // The index's names are identities across the whole tree, so a clash with
  // one is a clash anywhere; the server is still the judge of the folder.
  const taken = existing.some((g) => g.toLowerCase() === trimmed.toLowerCase());
  /**
   * A plugin name becomes a folder name, so the characters a path cannot carry
   * are the characters a name cannot have. Checked here rather than left to the
   * server because `Plugins/A/B` would silently create a NESTED folder — which
   * `pluginOfPath` would then read as the plugin "A", not "A/B".
   */
  const illegal = /[/\\]/.test(trimmed);
  const error = taken
    ? 'A plugin with that name already exists.'
    : illegal
      ? "A plugin name can't contain / or \\."
      : null;
  const canCreate = trimmed.length > 0 && !error && !busy;

  async function create() {
    if (!canCreate) return;
    setBusy(true);
    try {
      // Navigate with the SERVER's identity, not the typed name — the
      // endpoint owns the identifier of what it created.
      const { name } = await createPlugin(trimmed, parent);
      onCreated();
      onClose();
      navigate(pathForPlugin(name));
    } catch (err) {
      // The server's refusal names the problem (name taken, reserved
      // prefix…) — worth more than a generic apology.
      const msg = err instanceof Error ? err.message : "Couldn't create that plugin. Try again.";
      toast(msg, 'danger');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New plugin"
      size="md"
      busy={busy}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create plugin'}
          </Button>
        </>
      }
    >
      <p className="text-ui text-ink-muted">
        A plugin carries skills and tools for the people in it. You run the ones you create.
        {parent && (
          <>
            {' '}
            This one goes in <span className="font-mono text-detail text-ink">{parent}/</span>.
          </>
        )}
      </p>

      <TextField
        className="mt-3.5 w-full"
        autoFocus
        aria-label="Plugin name"
        placeholder="Design, Support, Leadership…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void create();
        }}
      />

      {/* Only after they have typed something: an error under an empty field
          is a complaint about a form nobody has filled in yet. */}
      {trimmed.length > 0 && error && (
        <p role="alert" className="mt-1.5 text-detail text-danger">
          {error}
        </p>
      )}

    </Dialog>
  );
}
