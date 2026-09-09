import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Banner } from '../../../shared/components';
import { useAdmin } from '../../admin/state/admin.context';
import { useLibrary, workspaceHasNoPlugins } from '../state/library-data';
import { LIBRARY_ROOT, pathForPlugin } from '../routes/library-paths';
import { ownersTextOf } from '../utils/plugin-summary';
import type { PluginEntry } from '../utils/plugin-entries';
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
}: {
  entries: PluginEntry[];
  showCreate?: boolean;
}) {
  const lib = useLibrary();
  const { pluginsLoading, pluginsError, pluginSummaries, reload, reloadPlugins } = lib;
  const { isAdmin } = useAdmin();
  const navigate = useNavigate();
  const [newPluginOpen, setNewPluginOpen] = useState(false);

  const offerCreate = showCreate && isAdmin && workspaceHasNoPlugins(lib);
  const loading = pluginsLoading && pluginSummaries.length === 0 && entries.length === 0;
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

      {loading ? (
        <p className="text-ui text-ink-faint">Loading plugins…</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <PluginIndexRow
              key={entry.name ?? ':yours'}
              label={entry.label}
              badge={
                entry.summary?.canWrite ? (
                  <Badge tone="outline" size="xs" className="shrink-0 uppercase">
                    Owner
                  </Badge>
                ) : undefined
              }
              {...describe(entry)}
              trailing={trailingOf(entry)}
              onOpen={() =>
                navigate(entry.name === null ? `${LIBRARY_ROOT}/yours` : pathForPlugin(entry.name))
              }
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
function trailingOf(entry: PluginEntry): ReactNode {
  if (entry.member) {
    return entry.attention > 0 ? (
      <Badge tone={entry.urgent ? 'urgent' : 'wait'} size="xs">
        {entry.attention}
      </Badge>
    ) : undefined;
  }
  return entry.summary?.hasRequested ? (
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
