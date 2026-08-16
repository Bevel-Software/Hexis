import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Banner } from '../../../shared/components';
import { useAuth } from '../../auth/state/auth.context';
import { attentionOf, useLibrary, type LibraryItem } from '../state/library-data';
import { personalPluginName } from '../utils/personal-plugin';
import { LIBRARY_ROOT, pathForPlugin } from '../routes/library-paths';
import { ownersTextOf } from '../utils/plugin-summary';
import type { PluginSummary } from '../services/plugins.api';
import { PluginIndexRow } from './PluginIndexRow';
import { LockGlyph } from './LockGlyph';
import { ManagedPluginRequests } from './ManagedPluginRequests';

/**
 * The all-plugins index — `/skills-and-tools`, where the Library opens.
 *
 * The sidebar can only show plugins you are IN. This page also shows the ones
 * you may DISCOVER — the endpoint returns a plugin exactly when the caller is
 * a member, manages it, or can read its `access.md` (the discovery grant), so
 * a plugin with none of those is absent here too, not merely unlabelled.
 *
 * Two sources, one list. The `GET /api/plugins` summaries are authoritative
 * about existence and access; the caller's own catalog is authoritative about
 * what they can actually see. A plugin in the catalog but missing from the
 * summaries (endpoint degraded, or a folder the scan hasn't picked up) still
 * gets a row, because the items are right there.
 */

/** A plugin's rows, whichever source could speak for it. */
interface IndexEntry {
  name: string;
  summary: PluginSummary | null;
  skillCount: number;
  toolCount: number;
  attention: number;
  /** The caller can see inside: folder read, manage rights, or item grants. */
  member: boolean;
}

export function PluginsIndexPage() {
  const { items, pluginSummaries, pluginsLoading, pluginsError, reloadPlugins } = useLibrary();
  const navigate = useNavigate();
  const { user } = useAuth();

  const personalName = personalPluginName(user?.name);
  const ungroupedSkills = countKind(items, null, 'skill');
  const ungroupedTools = countKind(items, null, 'integration');

  const entries = useMemo((): IndexEntry[] => {
    const names = new Set<string>(pluginSummaries.map((g) => g.name));
    for (const item of items) if (item.plugin) names.add(item.plugin);

    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const summary = pluginSummaries.find((g) => g.name === name) ?? null;
        const derivedSkills = countKind(items, name, 'skill');
        const derivedTools = countKind(items, name, 'integration');
        const hasItems = derivedSkills + derivedTools > 0;
        return {
          name,
          summary,
          // The summary's counts are the plugin's TOTALS; the catalog's are the
          // caller's slice. Prefer the totals — a member should see the same
          // "4 skills" here as on the plugin page.
          skillCount: summary ? summary.skillCount : derivedSkills,
          toolCount: summary ? summary.toolCount : derivedTools,
          attention: attentionOf(items, name),
          member: summary ? summary.canRead || summary.canWrite || hasItems : hasItems,
        };
      });
  }, [pluginSummaries, items]);

  const mine = entries.filter((e) => e.member);
  const locked = entries.filter((e) => !e.member);

  return (
    <div className="pb-14">
      <h1 className="text-display font-semibold">All plugins</h1>
      <p className="mt-0.5 text-ui text-ink-muted">
        A plugin carries skills and tools for the people in it.
      </p>

      {/* Somebody asking to join one of these is the news on a page about
          plugins, and this is the view the Library opens on — the one place
          the ask is certain to be seen. Renders nothing when nothing pends. */}
      <div className="mt-5 empty:mt-0">
        <ManagedPluginRequests />
      </div>

      {/* "Owned by me" used to head this list and does not any more: it is a
          LENS on every plugin (the things you answer for, wherever they live),
          not a place items belong to. It stays in the sidebar, where lenses
          go. What remains here is the one plugin that really is yours. */}
      <SectionHead>Yours</SectionHead>
      <RowList>
        <PluginIndexRow
          label={personalName}
          description="Your sign-ins and the skills no plugin carries"
          meta={countsText(ungroupedSkills, ungroupedTools)}
          onOpen={() => navigate(`${LIBRARY_ROOT}/yours`)}
        />
      </RowList>

      {pluginsError ? (
        <Banner role="alert" tone="danger" className="mt-6">
          {pluginsError}
          <button type="button" className="ml-3 font-semibold underline" onClick={reloadPlugins}>
            Try again
          </button>
        </Banner>
      ) : pluginsLoading && pluginSummaries.length === 0 ? (
        <div className="py-16 text-center text-ui text-ink-faint">Loading plugins…</div>
      ) : (
        <>
          <SectionHead count={mine.length}>{"Plugins you're in"}</SectionHead>
          <RowList>
            {mine.map((entry) => (
              <PluginIndexRow
                key={entry.name}
                label={entry.name}
                badge={
                  entry.summary?.canWrite ? (
                    <Badge tone="outline" size="xs" className="shrink-0 uppercase">
                      Owner
                    </Badge>
                  ) : undefined
                }
                {...describe(entry)}
                trailing={
                  entry.attention > 0 ? (
                    <Badge tone="wait" size="xs">
                      {entry.attention}
                    </Badge>
                  ) : undefined
                }
                onOpen={() => navigate(pathForPlugin(entry.name))}
              />
            ))}
          </RowList>

          {locked.length > 0 && (
            <>
              <SectionHead count={locked.length}>Ask to join</SectionHead>
              <RowList>
                {locked.map((entry) => (
                  <PluginIndexRow
                    key={entry.name}
                    label={entry.name}
                    {...describe(entry)}
                    /* The row has to SAY it is locked, not just look it — the
                       glyph is decorative (`aria-hidden`) and the word beside
                       it is what a screen reader and the tests both read.
                       Once a join CR is open the chip states that instead:
                       the one thing this row can tell you that you did not
                       already know is whether you have already asked. */
                    trailing={
                      entry.summary?.hasRequested ? (
                        <Badge tone="wait" size="xs" title="Requested" className="uppercase">
                          Requested
                        </Badge>
                      ) : (
                        <Badge tone="outline" size="xs" title="Locked" className="uppercase">
                          <LockGlyph className="size-2.5 shrink-0" />
                          Locked
                        </Badge>
                      )
                    }
                    onOpen={() => navigate(pathForPlugin(entry.name))}
                  />
                ))}
              </RowList>
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * A row's description + meta. With a summary the row leads with WHO runs the
 * plugin and puts the counts on the right; without one there is no verified
 * principal to name, so the counts move left and the meta slot stays empty
 * rather than inventing a "Run by …" we never resolved.
 */
function describe(entry: IndexEntry): { description: string; meta?: string } {
  const counts = countsText(entry.skillCount, entry.toolCount);
  if (!entry.summary) return { description: counts };
  return { description: `Run by ${ownersTextOf(entry.summary)}`, meta: counts };
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

function countKind(items: LibraryItem[], plugin: string | null, kind: LibraryItem['kind']): number {
  return items.filter((i) => i.plugin === plugin && i.kind === kind).length;
}

/** Section label with an optional count cap beside it, not inside it — the
 *  heading's accessible name stays the label alone. */
function SectionHead({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="mb-2.5 mt-7 flex items-baseline gap-2">
      <h2 className="text-label uppercase text-ink-faint">{children}</h2>
      {count !== undefined && (
        <span className="text-meta tabular-nums text-ink-faint">{count}</span>
      )}
    </div>
  );
}

function RowList({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1.5">{children}</div>;
}
