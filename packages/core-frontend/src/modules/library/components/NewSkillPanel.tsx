import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Surface, TextField } from '../../../shared/components';
import { useAuth } from '../../auth/state/auth.context';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { kbFileUrl } from '../../workspace/routing/kb-routes';
import { createEmptySkill } from '../services/library.api';
import { useLibraryReload } from '../state/library-context';
import { useLibraryToast } from '../state/toast.context';

/**
 * Where the new skill lands.
 *
 *   - A GROUP destination carries the folder and the caller's write verdict
 *     on it. `canWrite: null` (verdict not in yet) is treated as "not a
 *     writer", same rule the surrounding dialogs use: the cautious path —
 *     a change request — is correct either way, the confident one is not.
 *   - PERSONAL means the caller's own folder (`Groups/personal-<id>/`),
 *     which `createEmptySkill` ensures via the provisioning endpoint before
 *     writing. Always direct: the ensured folder is theirs by construction.
 */
export type NewSkillDestination =
  | { parentPath: string; canWrite: boolean | null }
  | { personal: true };

export interface NewSkillPanelProps {
  destination: NewSkillDestination;
  /** Every skill name already in the catalog — see the collision check below. */
  existingSkills: string[];
  /** Fired once the file exists; the host dialog closes on it. */
  onCreated(): void;
  /**
   * Follows the panel's in-flight state, for a host that can dismiss it. A
   * create that is already running does not stop when this panel unmounts —
   * it finishes, and (direct case) NAVIGATES. A host dialog that stayed
   * closable while that was pending let someone dismiss "New skill" and be
   * carried off the page seconds later; with this it holds its close doors
   * shut (`Dialog.busy`) until the request settles.
   */
  onBusyChange?(busy: boolean): void;
}

/**
 * "Start an empty SKILL.md", the admin-only first path in both add dialogs.
 *
 * This used to be a link that opened the destination folder in the workspace
 * and left you there. Opening a folder is not creating a skill: you still had
 * to know that a skill is a folder, that the folder needs a `SKILL.md`, and how
 * to make one. The door now does the thing it was pointing at — it writes the
 * file, and takes you to it with the cursor in an empty body.
 *
 * The name field is not ceremony. A skill's folder name IS its identity (see
 * `resolveDeclaredId` in the backend scan), so there is no correct name to
 * invent on someone's behalf, and a generated one would have to be renamed
 * before the skill was worth anything.
 */
export function NewSkillPanel({
  destination,
  existingSkills,
  onCreated,
  onBusyChange,
}: NewSkillPanelProps) {
  const { user } = useAuth();
  const reloadLibrary = useLibraryReload();
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  /**
   * A skill name becomes a folder name, so the characters a path cannot carry
   * are the characters a name cannot have — the same rule `NewGroupDialog`
   * applies to groups, and the same one the backend enforces (`isSafeName`).
   */
  const illegal = /[/\\]/.test(trimmed) || trimmed === '.' || trimmed === '..';
  /**
   * Collision is checked against EVERY skill, not just this folder's. A skill's
   * id is its name and ids are global: the backend's scan refuses the second
   * skill to claim one (`dedupeById`), so a duplicate here would not produce a
   * second skill — it would produce a file that never appears anywhere.
   */
  const taken = existingSkills.some((s) => s.toLowerCase() === trimmed.toLowerCase());
  const error = taken
    ? 'A skill with that name already exists.'
    : illegal
      ? 'A skill name can\'t contain / or \\, or be "." or "..".'
      : null;
  const canCreate = trimmed.length > 0 && !error && !busy && Boolean(user);

  async function create() {
    if (!canCreate || !user) return;
    setBusy(true);
    onBusyChange?.(true);
    try {
      const created = await createEmptySkill({
        ...('personal' in destination
          ? { personal: true as const }
          : { parentPath: destination.parentPath, canWrite: destination.canWrite === true }),
        name: trimmed,
        userEmail: user.email,
        userName: user.name,
      });
      // The library is where the result lives, whichever way it went — nobody
      // is bounced to the Knowledge app to meet the thing they just made.
      reloadLibrary();
      // Settled, and said so BEFORE handing back: the panel owns the whole
      // lifecycle it advertises. Leaving the success case to the host works
      // only while every host remembers to clear the flag in `onCreated` — a
      // host that merely closes its dialog there (as `PersonalAddDialog` does
      // with `onCreated={onClose}`) would stay busy forever.
      onBusyChange?.(false);
      onCreated();
      if (created.direct) {
        // Straight into the new skill's page, editor open: an empty SKILL.md
        // is an invitation to write, not a page to admire.
        toast(`Created ${trimmed}: opening it.`, 'ok');
        navigate(kbFileUrl(DEFAULT_BRANCH, created.workspacePath), { state: { startEditing: true } });
      } else {
        // A proposal has no page yet — the skill exists only on the author's
        // branch. It appears right here as an "In review" card (the pending
        // shelf), which is also where its review happens.
        toast(`Created ${trimmed}: sent to the group's owners for review.`, 'ok');
      }
    } catch (err) {
      // The workspace API forwards the backend's own refusal (e.g. "You don't
      // have permission to write to …"), which is worth more than a generic
      // apology — it names the thing to go fix.
      const msg = err instanceof Error ? err.message : String(err);
      toast(`Couldn't create that skill: ${msg}`, 'danger');
      setBusy(false);
      onBusyChange?.(false);
    }
  }

  return (
    <Surface tone="sunken" radius="lg" elevation="none" padded className="mt-3.5">
      <span className="block text-strong font-semibold text-ink">Start an empty SKILL.md</span>
      <span className="block text-detail text-ink-muted">
        A skill is a folder: SKILL.md plus whatever it needs. This makes both, and opens the file.
      </span>

      <div className="mt-2.5 flex items-start gap-2">
        <TextField
          className="flex-1"
          aria-label="Skill name"
          placeholder="weekly-report, rfi, pricing-check…"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void create();
          }}
        />
        <Button variant="primary" onClick={() => void create()} disabled={!canCreate}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </div>

      {/* Only once they have typed something: an error under an empty field is
          a complaint about a form nobody has filled in yet. */}
      {trimmed.length > 0 && error && (
        <p role="alert" className="mt-1.5 text-detail text-danger">
          {error}
        </p>
      )}
    </Surface>
  );
}
