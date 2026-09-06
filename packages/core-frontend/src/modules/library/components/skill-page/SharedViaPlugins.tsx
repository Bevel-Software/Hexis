import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button } from '../../../../shared/components';
import { useLibrary } from '../../state/library-data';
import { useLibraryToast } from '../../state/toast.context';
import { NeedsSkillWriteError, linkSkill, repairSkillLink, unlinkSkill } from '../../services/plugins.api';
import { requestSkillAccess, type PluginMembership } from '../../services/library.api';
import { pathForPlugin } from '../../routes/library-paths';
import { StatusDot } from '../StatusDot';

/**
 * "In plugins" — every plugin this skill belongs to, and the two ways the
 * relationship is managed from the skill's side.
 *
 * A row is INLINE (the skill sits in the plugin's folder) or LINKED (the
 * plugin's manifest points at it). A link is healthy when the skill's own
 * access rules still name the plugin's principal; when a hand edit removed
 * that grant, the row shows the amber dot and — to someone who can edit the
 * skill — a Repair button, because until it is back the plugin's members
 * cannot read the skill. Unlink is the plugin MANAGER's verb (it edits the
 * plugin's manifest), so it appears only on plugins the caller manages.
 *
 * "Add to plugin" links this skill into a plugin the caller manages. It
 * needs write on the skill too; a refusal of that shape offers the request.
 */
export function SharedViaPlugins({
  skillName,
  skillPath,
  memberships,
  owned,
  onChanged,
}: {
  skillName: string;
  skillPath: string;
  memberships: PluginMembership[];
  /** The caller may edit the skill (its SKILL.md) — the repair verb. */
  owned: boolean;
  onChanged(): void;
}) {
  const data = useLibrary();
  const toast = useLibraryToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [needsWrite, setNeedsWrite] = useState<'ask' | 'requested' | null>(null);

  const managed = useMemo(
    () => new Set(data.pluginSummaries.filter((p) => p.canWrite).map((p) => p.name)),
    [data.pluginSummaries],
  );
  const addable = useMemo(
    () => [...managed].filter((name) => !memberships.some((m) => m.name === name)).sort(),
    [managed, memberships],
  );

  async function run(label: string, op: () => Promise<unknown>, done: string) {
    setBusy(label);
    try {
      await op();
      toast(done);
      onChanged();
    } catch (err) {
      if (err instanceof NeedsSkillWriteError) setNeedsWrite('ask');
      else toast(err instanceof Error ? err.message : `Couldn't ${label}.`, 'danger');
    } finally {
      setBusy(null);
    }
  }

  if (memberships.length === 0 && addable.length === 0) return null;

  return (
    <section className="mt-6" data-testid="shared-via-plugins">
      <h2 className="mb-2.5 text-label font-semibold uppercase text-ink-faint">In plugins</h2>
      <div className="grid gap-2">
        {memberships.length === 0 && (
          <p className="text-detail text-ink-faint">This skill is in no plugin yet.</p>
        )}
        {memberships.map((m) => {
          const broken = m.linked && !m.granted;
          return (
            <div
              key={m.name}
              className="flex items-center gap-3 rounded-md border border-line bg-sunken px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Link to={pathForPlugin(m.name)} className="truncate text-detail font-semibold text-ink underline-offset-2 hover:underline">
                    {m.name}
                  </Link>
                  <Badge tone="outline" size="xs" className="shrink-0 uppercase">
                    {m.linked ? 'Linked' : 'Inline'}
                  </Badge>
                </div>
                <small className="block text-meta text-ink-faint">
                  {broken
                    ? owned
                      ? `Needs setup: ${m.name}'s members can't read this skill until the link is repaired.`
                      : `Needs setup: ${m.name}'s members can't read this skill. Ask an editor to repair the link.`
                    : m.linked
                      ? `${m.name}'s members can read it; its managers can edit it.`
                      : `Lives in ${m.name}'s folder.`}
                </small>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {broken && <StatusDot state="warn" />}
                {broken && owned && (
                  <Button
                    variant="outline"
                    size="tiny"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('repair', () => repairSkillLink(m.name, skillPath), `${m.name} can read ${skillName} again.`)
                    }
                  >
                    Repair
                  </Button>
                )}
                {m.linked && managed.has(m.name) && (
                  <Button
                    variant="quiet"
                    size="tiny"
                    disabled={busy !== null}
                    onClick={() =>
                      void run('unlink', () => unlinkSkill(m.name, skillPath), `${skillName} is no longer in ${m.name}.`)
                    }
                  >
                    Unlink
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {addable.length > 0 && (
        <div className="mt-2.5">
          {needsWrite === 'requested' ? (
            <span className="text-detail text-ink-faint">Asked the skill's editors for write access.</span>
          ) : needsWrite === 'ask' ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-detail text-wait">
                {"You can't change who may read this skill yet."}
              </span>
              <Button
                variant="outline"
                size="tiny"
                disabled={busy !== null}
                onClick={() =>
                  void (async () => {
                    setBusy('request');
                    try {
                      await requestSkillAccess(skillName);
                      setNeedsWrite('requested');
                    } catch (err) {
                      toast(err instanceof Error ? err.message : "Couldn't request access.", 'danger');
                    } finally {
                      setBusy(null);
                    }
                  })()
                }
              >
                Request write access
              </Button>
            </div>
          ) : adding ? (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-detail text-ink-muted" htmlFor="add-to-plugin-select">
                Add to
              </label>
              <select
                id="add-to-plugin-select"
                className="rounded-md border border-line bg-surface px-2 py-1 text-ui text-ink"
                defaultValue=""
                disabled={busy !== null}
                onChange={(e) => {
                  const name = e.target.value;
                  if (!name) return;
                  void run('link', () => linkSkill(name, skillPath), `${skillName} is now in ${name}.`).then(() =>
                    setAdding(false),
                  );
                }}
              >
                <option value="" disabled>
                  Choose a plugin…
                </option>
                {addable.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <Button variant="quiet" size="tiny" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              Add to plugin…
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
