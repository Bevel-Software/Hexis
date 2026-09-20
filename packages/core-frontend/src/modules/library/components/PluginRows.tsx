import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink, UserPlus, Users } from 'lucide-react';
import { Badge, Banner } from '../../../shared/components';
import { useAdmin } from '../../admin/state/admin.context';
import { useLibrary, workspaceHasNoPlugins } from '../state/library-data';
import { LIBRARY_ROOT, pathForPlugin } from '../routes/library-paths';
import { adminNamesOf, ownersTextOf, primaryFolderOf } from '../utils/plugin-summary';
import { AlreadyReadableError, requestPluginAccess } from '../services/plugins.api';
import { useLibraryToast } from '../state/toast.context';
import { firstNames, joinNames } from '../utils/names';
import type { PluginEntry } from '../utils/plugin-entries';
import type { ItemAction } from './ItemActionsMenu';
import { EmptyStateAction } from './plugin-page-parts';
import { PluginIndexRow } from './PluginIndexRow';
import { LockGlyph } from './LockGlyph';
import { NewPluginDialog } from './NewPluginDialog';

/**
 * The Plugins band of a gallery page — the Library's one plugin renderer,
 * the row the all-plugins index drew, now heading Everything, Owned by me
 * and a team's page above the skill and tool cards. A row is a PLACE: it
 * opens the plugin's page (member view or locked, the page decides), or the
 * caller's own space for the row with no identity.
 *
 * What a row says is the index's grammar, unchanged: an Owner badge for a
 * plugin the caller manages; "Run by …" with the counts as meta when the
 * server vouches for it, the counts alone when only the catalog does; the
 * amber or orange count when something needs a person; Locked or Requested
 * for a plugin the caller is not in.
 *
 * `showCreate` is Everything's: the one page a person with no plugins is
 * guaranteed to land on, so it is where the app says how a plugin comes to
 * exist — for an administrator, on an untouched workspace, and only then
 * (`workspaceHasNoPlugins`, settled from both witnesses).
 */
export function PluginRows({
  entries,
  showCreate = false,
  onShare,
}: {
  entries: PluginEntry[];
  showCreate?: boolean;
  /**
   * Open Manage access on a plugin's primary folder, repo-relative — the
   * plugin page's `Share`, offered from its row. The dialog itself belongs to
   * the page (it is one dialog for the rows AND the cards), so the band only
   * says WHICH folder. Absent when the page cannot address folders yet, and
   * the rows then offer Subscribe or nothing at all rather than a verb that
   * would open on the wrong path.
   */
  onShare?(folder: string): void;
}) {
  const lib = useLibrary();
  const { pluginsLoading, pluginsError, pluginSummaries, reload, reloadPlugins } = lib;
  const { isAdmin } = useAdmin();
  const navigate = useNavigate();
  const toast = useLibraryToast();
  const [newPluginOpen, setNewPluginOpen] = useState(false);
  /** Plugins this reader has asked to join since the page loaded. */
  const [justRequested, setJustRequested] = useState<readonly string[]>([]);

  /**
   * The locked page's button, as a menu item. Identical wiring on purpose —
   * same call, same toast, same two answers — because a reader who subscribes
   * from the row and one who subscribes from the page have done the same
   * thing and must be told so in the same words.
   */
  async function subscribe(name: string) {
    const summary = pluginSummaries.find((g) => g.name === name);
    const admins = summary ? adminNamesOf(summary) : [];
    try {
      await requestPluginAccess(name);
      setJustRequested((names) => (names.includes(name) ? names : [...names, name]));
      toast(
        `Asked ${admins.length > 0 ? joinNames(firstNames(admins)) : 'the admins'}. You get its skills and tools once they grant access.`,
      );
      reloadPlugins();
    } catch (err) {
      // Access arrived between the page load and the click. Nothing went
      // wrong — the plugin is simply open now, so re-read and let the row
      // become a member's row.
      if (err instanceof AlreadyReadableError) {
        reload();
        reloadPlugins();
        return;
      }
      toast("Couldn't send that: try again.", 'danger');
    }
  }

  /**
   * What a row's `…` offers. Open is always there — it is the row's own click,
   * said in words, and it is what makes the menu a menu rather than a single
   * button. The second item is the whole point of the menu, and there are
   * three of it:
   *
   *  - SHARE, for a plugin the reader can read: the plugin page's Share, on
   *    the same primary folder. Ungated, like the page's — for a non-writer
   *    the dialog renders read-only, which is the honest answer to "who is
   *    this shared with?".
   *  - SUBSCRIBE, for one they cannot: the locked page's button.
   *  - REQUESTED, once they have asked — stated and not offered, exactly as
   *    the locked page replaces its button with the same word.
   *
   * A row with neither — the caller's own space, which is not a plugin, and a
   * plugin whose folder the page cannot address — gets no menu at all.
   */
  function actionsOf(entry: PluginEntry): ItemAction[] {
    const open: ItemAction = {
      label: 'Open',
      icon: <ExternalLink size={14} />,
      onSelect: () => openEntry(entry),
    };
    if (entry.name === null) return [];
    if (entry.member) {
      const folder = entry.summary ? primaryFolderOf(entry.summary) : null;
      if (!folder || !onShare) return [];
      return [
        open,
        { label: 'Share', icon: <Users size={14} />, onSelect: () => onShare(folder), separated: true },
      ];
    }
    const name = entry.name;
    const pending = entry.summary?.hasRequested === true || justRequested.includes(name);
    return [
      open,
      pending
        ? { label: 'Requested', icon: <UserPlus size={14} />, disabled: true, separated: true }
        : {
            label: 'Subscribe',
            icon: <UserPlus size={14} />,
            onSelect: () => void subscribe(name),
            separated: true,
          },
    ];
  }

  function openEntry(entry: PluginEntry) {
    navigate(entry.name === null ? `${LIBRARY_ROOT}/yours` : pathForPlugin(entry.name));
  }

  const offerCreate = showCreate && isAdmin && workspaceHasNoPlugins(lib);
  // Loading is the plugin REQUEST's state, never the rows': the caller's own
  // space is a row before any request answers, and on a first load the list
  // beneath it is not yet known — so the rows already in hand stay on
  // screen and the note sits under them. A reload with summaries already in
  // hand keeps showing them.
  const loading = pluginsLoading && pluginSummaries.length === 0;
  if (!offerCreate && !pluginsError && !loading && entries.length === 0) return null;

  return (
    <section className="mt-7">
      <div className="mb-2.5 flex items-baseline gap-2">
        <h2 className="text-label uppercase text-ink-faint">Plugins</h2>
        {entries.length > 0 && (
          <span className="text-meta tabular-nums text-ink-faint">{entries.length}</span>
        )}
      </div>

      {pluginsError && (
        <Banner role="alert" tone="danger" className="mb-3">
          {pluginsError}
          <button type="button" className="ml-3 font-semibold underline" onClick={reloadPlugins}>
            Try again
          </button>
        </Banner>
      )}

      {offerCreate && (
        <p className="mb-3 text-ui text-ink-faint">
          {"You're not in any plugins yet. "}
          <EmptyStateAction onClick={() => setNewPluginOpen(true)}>
            Create the first plugin
          </EmptyStateAction>
          {' to share skills and tools with your team.'}
        </p>
      )}

      {loading && <p className="mb-2 text-ui text-ink-faint">Loading plugins…</p>}
      {entries.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <PluginIndexRow
              key={entry.name ?? ':yours'}
              label={entry.label}
              badge={badgesOf(entry)}
              {...describe(entry)}
              trailing={trailingOf(
                entry,
                entry.name !== null && justRequested.includes(entry.name),
              )}
              actions={actionsOf(entry)}
              onOpen={() => openEntry(entry)}
            />
          ))}
        </div>
      )}

      {newPluginOpen && (
        <NewPluginDialog
          existing={[...new Set(pluginSummaries.map((g) => g.name))]}
          onClose={() => setNewPluginOpen(false)}
          onCreated={() => {
            reload();
            reloadPlugins();
          }}
        />
      )}
    </section>
  );
}

/**
 * Beside the label: `Owner` for a plugin the caller owns (`isOwner` — the
 * listing's owner-lists-only verdict; managing is not owning), and `Private`
 * for one whose access.md says of itself that it is — the file's own
 * frontmatter denies everyone and names only people. A personal space is
 * always the latter; it is also always the reader's, so its row carries the
 * mark on its own. Nothing when neither applies, so the row stays plain text.
 */
function badgesOf(entry: PluginEntry): ReactNode {
  const owner = entry.summary?.isOwner === true;
  const isPrivate = entry.name === null || entry.summary?.isPrivate === true;
  if (!owner && !isPrivate) return undefined;
  return (
    <>
      {owner && (
        <Badge tone="outline" size="xs" className="shrink-0 uppercase">
          Owner
        </Badge>
      )}
      {isPrivate && (
        <Badge tone="outline" size="xs" title="Private" className="shrink-0 uppercase">
          <LockGlyph className="size-2.5 shrink-0" />
          Private
        </Badge>
      )}
    </>
  );
}

function describe(entry: PluginEntry): { description: string; meta?: string } {
  const counts = countsText(entry.skillCount, entry.toolCount);
  if (entry.name === null) {
    return { description: 'Your sign-ins and the skills no plugin carries', meta: counts };
  }
  if (!entry.summary) return { description: counts };
  return { description: `Run by ${ownersTextOf(entry.summary)}`, meta: counts };
}

/**
 * The right edge of a row: for a member, the count of things that need a
 * person (orange outranks amber — members locked out of a skill outrank a
 * tool the reader has not set up); for everyone else, the one thing the row
 * can tell them that they did not already know — whether they have asked.
 */
function trailingOf(entry: PluginEntry, justRequested = false): ReactNode {
  if (entry.member) {
    return entry.attention > 0 ? (
      <Badge tone={entry.urgent ? 'urgent' : 'wait'} size="xs">
        {entry.attention}
      </Badge>
    ) : undefined;
  }
  return entry.summary?.hasRequested || justRequested ? (
    <Badge tone="wait" size="xs" title="Requested" className="uppercase">
      Requested
    </Badge>
  ) : (
    <Badge tone="outline" size="xs" title="Locked" className="uppercase">
      <LockGlyph className="size-2.5 shrink-0" />
      Locked
    </Badge>
  );
}

/**
 * `{n} skills · {n} tools`, fixed plural. Not an oversight: the spec's own
 * empty-plugin example reads `0 skills · 0 tools`, so this is a label for two
 * quantities rather than a sentence about them, and it stays the same width as
 * the row above it.
 */
function countsText(skills: number, tools: number): string {
  return `${skills} skills · ${tools} tools`;
}
