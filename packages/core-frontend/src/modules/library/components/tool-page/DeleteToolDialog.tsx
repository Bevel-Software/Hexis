import { useEffect, useState } from 'react';
import { Banner, Button, Dialog, TextField } from '../../../../shared/components';
import { deleteTool, getToolDependents, type ToolDependents } from '../../services/tools.api';

/**
 * The "are you sure" a TOOL deletion deserves — and what makes it different
 * from the plugin's is that a tool is something other things POINT AT. A
 * plugin's contents go with it; a tool's dependents stay behind, broken: a
 * skill whose `allowed-tools` names it, a plugin that carries it, and every
 * credential stored under its name.
 *
 * So the dialog asks the backend first and says exactly what it found, before
 * the confirm is worth reading. The counts are counts — never a value, never
 * whose sign-in — because the point is to inform the owner, not to hand them
 * other people's credentials.
 *
 * Who may open it is the caller's decision (plugin ownership); the backend
 * enforces the same verdict for real, and its refusal is what this shows.
 *
 * And the confirm is the tool's NAME, typed. The plugin dialog is content of
 * yours going with a folder of yours; this one also wipes credentials that are
 * not the clicker's — other people's stored keys and sign-ins — so the hand
 * that does it says the name first.
 */
export function DeleteToolDialog({
  slug,
  name,
  onClose,
  onDeleted,
}: {
  slug: string;
  /** The tool's name, for the title before the dependents arrive. */
  name: string;
  onClose(): void;
  /** Fired after the delete lands, with the plugin the tool lived in. */
  onDeleted(plugin: string): void;
}) {
  const [dependents, setDependents] = useState<ToolDependents | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [shownFor, setShownFor] = useState(slug);

  // A tool page can navigate to ANOTHER tool with this dialog still open, and
  // the dependents read for the new slug does not resolve instantly. Clearing
  // during the render that first sees the new slug — not in an effect, which
  // runs after it — is what stops a confirmation typed for the old tool from
  // arming Delete against the new one.
  if (shownFor !== slug) {
    setShownFor(slug);
    setDependents(null);
    setLoadError(null);
    setError(null);
    setTyped('');
  }

  useEffect(() => {
    let live = true;
    getToolDependents(slug)
      .then((d) => {
        if (live) setDependents(d);
      })
      .catch((err: unknown) => {
        // The one thing worse than a scary dialog is a confident one: if we
        // could not read what depends on the tool, the delete is not offered.
        if (live) setLoadError(err instanceof Error ? err.message : "Couldn't read what depends on this tool.");
      });
    return () => {
      live = false;
    };
  }, [slug]);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const { plugin } = await deleteTool(slug);
      onDeleted(plugin);
      onClose();
    } catch (err) {
      // The backend's refusal names the rule (ownership, an external format,
      // a refused push); a generic apology would hide the one thing worth
      // reading.
      setError(err instanceof Error ? err.message : "Couldn't delete the tool.");
      setBusy(false);
    }
  }

  // The name as the BACKEND spells it once it answers, so the thing typed is
  // the thing deleted even if the page arrived with a stale label.
  const confirmName = dependents?.name ?? name;
  const ready = dependents !== null && loadError === null;
  const confirmed = ready && typed.trim() === confirmName;

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Delete ${dependents?.name ?? name}?`}
      size="md"
      busy={busy}
      footer={
        <>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy || !confirmed}>
            {busy ? 'Deleting…' : 'Delete tool'}
          </Button>
        </>
      }
    >
      {loadError ? (
        <Banner tone="danger" role="alert">
          {loadError}
        </Banner>
      ) : !dependents ? (
        <p className="text-ui text-ink-muted">Checking what depends on this tool…</p>
      ) : (
        <>
          <p className="text-ui text-ink-muted">
            {dependents.source === 'server'
              ? `This removes the ${dependents.name} server from ${dependents.plugin.displayName}'s configuration for everyone, and there is no undo — it survives only in git history.`
              : `This deletes the ${dependents.name} tool from ${dependents.plugin.displayName} for everyone, and there is no undo — it survives only in git history.`}
          </p>
          <DependentList
            // "You can see" is not modesty: the backend lists only the
            // caller's readable skills, because naming one they cannot read
            // would confirm it exists. An unqualified heading would present
            // that subset as the whole truth.
            label="Skills you can see that allow it"
            items={dependents.skills.map((s) => s.name)}
            // Said plainly, because it is the consequence people are most
            // likely to be surprised by: the skills keep the name and break.
            none="No skill you can see names it in its allowed tools."
            tail="keep naming it in their allowed tools — those entries stop resolving."
            tailOne="keeps naming it in its allowed tools — that entry stops resolving."
          />
          <DependentList
            label="Plugins that carry it"
            items={dependents.plugins.map((p) => p.displayName)}
            none="No other plugin carries it."
            tail="lose it too."
            tailOne="loses it too."
          />
          <p className="mt-3 text-ui text-ink-muted">
            {secretsLine(dependents.storedKeys, dependents.signIns)}
          </p>
          <label className="mt-4 block text-ui text-ink-muted" htmlFor={CONFIRM_FIELD_ID}>
            {'Type '}
            <span className="font-semibold text-ink">{confirmName}</span>
            {' to confirm.'}
          </label>
          <TextField
            id={CONFIRM_FIELD_ID}
            className="mt-1.5"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={(e) => setTyped(e.target.value)}
          />
        </>
      )}
      {error && (
        <Banner tone="danger" role="alert" className="mt-3">
          {error}
        </Banner>
      )}
    </Dialog>
  );
}

const CONFIRM_FIELD_ID = 'delete-tool-confirm';

/** One kind of dependent, named — or the honest "nothing" that saves a worry. */
function DependentList({
  label,
  items,
  none,
  tail,
  tailOne,
}: {
  label: string;
  items: string[];
  none: string;
  tail: string;
  tailOne: string;
}) {
  return (
    <div className="mt-3">
      <p className="text-label font-semibold uppercase text-ink-faint">{label}</p>
      {items.length === 0 ? (
        <p className="text-ui text-ink-muted">{none}</p>
      ) : (
        <p className="text-ui text-ink-muted">
          <span className="font-semibold text-ink">{items.join(', ')}</span>{' '}
          {items.length === 1 ? tailOne : tail}
        </p>
      )}
    </div>
  );
}

/**
 * The credentials, as numbers. EVERY user's, not just the reader's — the whole
 * reason the count comes from the backend is that a page can only see its own
 * secrets, and "0" from a page that cannot see the others would be a lie.
 */
function secretsLine(keys: number, signIns: number): string {
  const parts = [
    keys > 0 ? `${keys} stored ${keys === 1 ? 'key' : 'keys'}` : null,
    signIns > 0 ? `${signIns} ${signIns === 1 ? 'sign-in' : 'sign-ins'}` : null,
  ].filter(Boolean);
  if (parts.length === 0) return 'Nothing is stored under its name.';
  return `${parts.join(' and ')} stored under its name ${parts.length === 1 ? 'is' : 'are'} wiped.`;
}
