import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, TextField } from '../../../shared/components';
import { useWorkspace } from '../../workspace/state/workspace.context';
import { createDirectory } from '../../workspace/services/workspace.api';
import { GROUPS_DIR } from '@bevel-software/platform-shared';
import { DEFAULT_WORKSPACE_ID } from '../services/library.api';
import { pathForGroup } from '../routes/library-paths';
import { useLibraryToast } from '../state/toast.context';

export interface NewGroupDialogProps {
  /** Names already taken — readable groups AND locked ones. */
  existing: string[];
  onClose(): void;
  /** The catalog and the group index both have to hear about a new folder. */
  onCreated(): void;
}

/**
 * Make a group — the prototype's `newSpaceModal` (line 2769).
 *
 * A group IS a folder, so creating one is `mkdir Groups/<Name>` and nothing
 * else. That is not a shortcut: the whole model is that the KB is the source
 * of truth, so a group that existed anywhere but on disk would be a second
 * registry to keep in sync.
 *
 * The creator gets read access for free, and not by accident — the directory
 * endpoint seeds the new folder's `access.md` naming its creator under `read:`
 * BEFORE the folder appears (`workspace.routes.ts:886`). Without that seeding
 * the default-deny tree filter would hide the folder from the person who just
 * made it. So there is no access step in this dialog: you already have it.
 */
export function NewGroupDialog({ existing, onClose, onCreated }: NewGroupDialogProps) {
  const { kbDirName } = useWorkspace();
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const taken = existing.some((g) => g.toLowerCase() === trimmed.toLowerCase());
  /**
   * A group name becomes a folder name, so the characters a path cannot carry
   * are the characters a name cannot have. Checked here rather than left to the
   * server because `Groups/A/B` would silently create a NESTED folder — which
   * `groupOfPath` would then read as the group "A", not "A/B".
   */
  const illegal = /[/\\]/.test(trimmed);
  const error = taken
    ? 'A group with that name already exists.'
    : illegal
      ? "A group name can't contain / or \\."
      : null;
  const canCreate = trimmed.length > 0 && !error && !busy && Boolean(kbDirName);

  async function create() {
    if (!canCreate || !kbDirName) return;
    setBusy(true);
    try {
      await createDirectory(DEFAULT_WORKSPACE_ID, `${kbDirName}/${GROUPS_DIR}/${trimmed}`);
      onCreated();
      onClose();
      navigate(pathForGroup(trimmed));
    } catch {
      toast("Couldn't create that group — try again.", 'danger');
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="New group"
      size="md"
      busy={busy}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void create()} disabled={!canCreate}>
            {busy ? 'Creating…' : 'Create group'}
          </Button>
        </>
      }
    >
      <p className="text-ui text-ink-muted">
        A group carries skills and tools for the people in it. You run the ones you create.
      </p>

      <TextField
        className="mt-3.5 w-full"
        autoFocus
        aria-label="Group name"
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

      {!kbDirName && (
        <p className="mt-1.5 text-detail text-ink-muted">Workspace still loading…</p>
      )}
    </Dialog>
  );
}
