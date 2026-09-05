import { useMemo, useState } from 'react';
import { Button, Badge } from '../../../shared/components';
import type { LibraryItem } from '../state/library-data';
import { useLibraryToast } from '../state/toast.context';
import { NeedsSkillWriteError, linkSkill } from '../services/plugins.api';
import { requestSkillAccess } from '../services/library.api';
import { isInPlugin } from '../utils/status';

/**
 * "Link an existing skill" — the picker behind adding a shared skill to a
 * plugin without copying it.
 *
 * Every released skill the caller can read is offered, minus the ones already
 * in this plugin. Linking needs write on the skill's rules as well as on the
 * plugin (the link grants the plugin's principal on the skill), and the server
 * is the one that knows: a refusal of that shape turns the row's action into
 * "Request write access", which opens the same kind of change request as
 * asking to join a plugin. Nothing is decided client-side from a stale verdict.
 *
 * Prop-driven (the caller hands it the catalog) so it renders anywhere the
 * plugin page's data is, without reaching for the library context itself.
 */
export function LinkSkillPanel({
  plugin,
  items,
  onLinked,
}: {
  plugin: string;
  /** The caller's catalog; the panel offers its released skills not yet in `plugin`. */
  items: LibraryItem[];
  onLinked(): void;
}) {
  const toast = useLibraryToast();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  /** Per skill: the server said write on the skill is missing / a request is open. */
  const [needsWrite, setNeedsWrite] = useState<Record<string, 'ask' | 'requested'>>({});

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items
      // Retired skills are kept for their owners and never shared onward; the
      // server refuses them too, this just keeps them out of the list.
      .filter((i): i is LibraryItem => i.kind === 'skill' && !i.pending && i.lifecycle !== 'retired' && !isInPlugin(i, plugin))
      .filter((i) => !q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [items, plugin, query]);

  async function link(item: LibraryItem) {
    setBusy(item.id);
    try {
      const result = await linkSkill(plugin, item.path);
      toast(
        result.skills.length === 1
          ? `${item.name} is now in ${plugin}. Its members can read it; its managers can edit it.`
          : `${result.skills.length} skills are now in ${plugin}.`,
      );
      onLinked();
    } catch (err) {
      if (err instanceof NeedsSkillWriteError) {
        setNeedsWrite((m) => ({ ...m, [item.id]: 'ask' }));
      } else {
        toast(err instanceof Error ? err.message : "Couldn't link that skill.", 'danger');
      }
    } finally {
      setBusy(null);
    }
  }

  async function request(item: LibraryItem) {
    setBusy(item.id);
    try {
      await requestSkillAccess(item.name);
      setNeedsWrite((m) => ({ ...m, [item.id]: 'requested' }));
      toast(`Asked ${item.name}'s editors for write access. Link it once they say yes.`);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Couldn't request access.", 'danger');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="link-skill-panel">
      <p className="text-ui text-ink-muted">
        {`Link a skill that already exists. It stays where it is; ${plugin}'s members get to read it and its managers get to edit it.`}
      </p>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search skills…"
        aria-label="Search skills to link"
        className="mt-2.5 w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-ui text-ink placeholder:text-ink-faint focus:outline-none"
      />
      <ul className="mt-2 max-h-64 divide-y divide-line overflow-auto rounded-md border border-line">
        {candidates.length === 0 && (
          <li className="px-3 py-3 text-detail text-ink-faint">
            {query.trim() ? 'No skill matches.' : 'Every skill you can see is already in this plugin.'}
          </li>
        )}
        {candidates.map((item) => {
          const state = needsWrite[item.id];
          return (
            <li key={item.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-ui font-medium text-ink">{item.name}</span>
                  {item.shared ? (
                    <Badge tone="outline" size="xs" className="shrink-0 uppercase">
                      Shared
                    </Badge>
                  ) : item.plugin ? (
                    <Badge tone="outline" size="xs" className="shrink-0 uppercase">
                      {item.plugin}
                    </Badge>
                  ) : null}
                </div>
                {item.description && (
                  <div className="truncate text-detail text-ink-muted">{item.description}</div>
                )}
                {state === 'ask' && (
                  <div className="text-detail text-wait">
                    {"You can't change who may read this skill yet. Ask its editors first."}
                  </div>
                )}
              </div>
              {state === 'requested' ? (
                <span className="shrink-0 text-detail text-ink-faint">Requested</span>
              ) : state === 'ask' ? (
                <Button
                  variant="outline"
                  size="tiny"
                  disabled={busy === item.id}
                  onClick={() => void request(item)}
                >
                  Request write access
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="tiny"
                  disabled={busy !== null}
                  onClick={() => void link(item)}
                >
                  Link
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
