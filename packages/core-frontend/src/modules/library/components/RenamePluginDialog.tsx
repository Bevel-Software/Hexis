import { useId, useState } from 'react';
import { PERSONAL_PLUGIN_PREFIX } from '@bevel-software/platform-shared';
import { Banner, Button, Dialog, TextField } from '../../../shared/components';
import { renamePlugin, type PluginSummary } from '../services/plugins.api';
import { useLibraryToast } from '../state/toast.context';

/** The Agent Plugins identifier rule — lowercase kebab-case, nothing else. */
const IDENTIFIER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Rename a plugin: its identifier, its display name, or both.
 *
 * The identifier is the plugin — the grants spell it, the URLs key on it,
 * the marketplace publishes it — so changing it rewrites every grant that
 * names the old one, in one commit, and the dialog says so before the click.
 * The display name is only what people see.
 */
export function RenamePluginDialog({
  plugin,
  onClose,
  onRenamed,
}: {
  plugin: Pick<PluginSummary, 'name' | 'displayName' | 'folders'>;
  onClose(): void;
  /** The rename landed; the host reloads and, when the identifier changed, navigates. */
  onRenamed(next: { name: string; displayName: string }): void;
}) {
  const nameId = useId();
  const displayId = useId();
  const toast = useLibraryToast();
  const [name, setName] = useState(plugin.name);
  const [displayName, setDisplayName] = useState(plugin.displayName ?? plugin.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const identifierChanges = trimmedName !== plugin.name;
  // The same two rules the server applies — and, like the server, only to a
  // NEW identifier: the current one is whatever the manifest says, and a
  // name that predates a rule must not block a display-name change.
  const nameError = !identifierChanges || !trimmedName
    ? null
    : !IDENTIFIER_RE.test(trimmedName)
      ? 'Lowercase letters, digits and single hyphens, like sales-team.'
      : trimmedName.startsWith(PERSONAL_PLUGIN_PREFIX)
        ? `"${PERSONAL_PLUGIN_PREFIX}" is reserved for personal folders. Pick another identifier.`
        : null;
  const changed = identifierChanges || displayName.trim() !== (plugin.displayName ?? plugin.name);
  const canSubmit = trimmedName.length > 0 && nameError === null && changed && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const next = await renamePlugin(plugin.name, {
        ...(identifierChanges ? { name: trimmedName } : {}),
        displayName: displayName.trim(),
      });
      toast(identifierChanges ? `Renamed ${plugin.name} to ${next.name}.` : `Renamed to ${next.displayName}.`);
      onRenamed(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename the plugin.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Rename ${plugin.displayName ?? plugin.name}`}
      size="md"
      busy={busy}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? 'Renaming…' : 'Rename'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label htmlFor={displayId} className="mb-1 block text-detail font-medium text-ink">
            Display name
          </label>
          <TextField
            id={displayId}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={plugin.folders[0]?.split('/').pop() ?? plugin.name}
          />
          <p className="mt-1 text-meta text-ink-faint">What people see in the sidebar and on this page.</p>
        </div>
        <div>
          <label htmlFor={nameId} className="mb-1 block text-detail font-medium text-ink">
            Identifier
          </label>
          <TextField
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={nameError ? true : undefined}
            className="font-mono"
          />
          <p className="mt-1 text-meta text-ink-faint">
            {nameError ??
              'The name agents install it by, and the one grants use: plugin/<identifier>/read.'}
          </p>
        </div>
        {identifierChanges && !nameError && (
          <Banner tone="wait" role="status">
            Every grant of <span className="font-mono">plugin/{plugin.name}/…</span> in the knowledge base is
            rewritten to <span className="font-mono">plugin/{trimmedName}/…</span> in the same change. The folder
            stays where it is.
          </Banner>
        )}
        {error && (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        )}
      </div>
    </Dialog>
  );
}
