import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Banner } from '../../../shared/components';
import { useAuth } from '../../auth/state/auth.context';
import { attentionOf, useLibrary, type LibraryItem } from '../state/library-data';
import { personalGroupName } from '../utils/personal-group';
import { LIBRARY_ROOT, pathForGroup } from '../routes/library-paths';
import { ownersTextOf } from '../utils/group-summary';
import type { GroupSummary } from '../services/groups.api';
import { GroupIndexRow } from './GroupIndexRow';

/**
 * The all-groups index — `/skills-and-tools/groups`.
 *
 * Fail-closed like every other read surface: the groups endpoint only returns
 * groups the caller can access, so every row here is one they can open.
 *
 * Two sources, one list. The `GET /api/groups` summaries are authoritative
 * about existence and access; the caller's own catalog is authoritative about
 * what they can actually see. A group in the catalog but missing from the
 * summaries (endpoint degraded, or a folder the scan hasn't picked up) still
 * gets a row, because the items are right there.
 */

/** A group's rows, whichever source could speak for it. */
interface IndexEntry {
  name: string;
  summary: GroupSummary | null;
  skillCount: number;
  toolCount: number;
  attention: number;
}

export function GroupsIndexPage() {
  const { items, groupSummaries, groupsLoading, groupsError, reloadGroups } = useLibrary();
  const navigate = useNavigate();
  const { user } = useAuth();

  const personalName = personalGroupName(user?.name);
  const ungroupedSkills = countKind(items, null, 'skill');
  const ungroupedTools = countKind(items, null, 'integration');

  const entries = useMemo((): IndexEntry[] => {
    const names = new Set<string>(groupSummaries.map((g) => g.name));
    for (const item of items) if (item.group) names.add(item.group);

    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const summary = groupSummaries.find((g) => g.name === name) ?? null;
        return {
          name,
          summary,
          // The summary's counts are the group's TOTALS; the catalog's are the
          // caller's slice. Prefer the totals — a member should see the same
          // "4 skills" here as on the group page.
          skillCount: summary ? summary.skillCount : countKind(items, name, 'skill'),
          toolCount: summary ? summary.toolCount : countKind(items, name, 'integration'),
          attention: attentionOf(items, name),
        };
      });
  }, [groupSummaries, items]);

  return (
    <div className="pb-14">
      <h1 className="text-display font-semibold">All groups</h1>
      <p className="mt-0.5 text-ui text-ink-muted">
        A group carries skills and tools for the people in it.
      </p>

      {/* "Owned by me" used to head this list and does not any more: it is a
          LENS on every group (the things you answer for, wherever they live),
          not a place items belong to. It stays in the sidebar, where lenses
          go. What remains here is the one group that really is yours. */}
      <SectionHead>Yours</SectionHead>
      <RowList>
        <GroupIndexRow
          label={personalName}
          description="Your sign-ins and the skills no group carries"
          meta={countsText(ungroupedSkills, ungroupedTools)}
          onOpen={() => navigate(`${LIBRARY_ROOT}/yours`)}
        />
      </RowList>

      {groupsError ? (
        <Banner role="alert" tone="danger" className="mt-6">
          {groupsError}
          <button type="button" className="ml-3 font-semibold underline" onClick={reloadGroups}>
            Try again
          </button>
        </Banner>
      ) : groupsLoading && groupSummaries.length === 0 ? (
        <div className="py-16 text-center text-ui text-ink-faint">Loading groups…</div>
      ) : (
        <>
          <SectionHead count={entries.length}>{"Groups you're in"}</SectionHead>
          <RowList>
            {entries.map((entry) => (
              <GroupIndexRow
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
                onOpen={() => navigate(pathForGroup(entry.name))}
              />
            ))}
          </RowList>
        </>
      )}
    </div>
  );
}

/**
 * A row's description + meta. With a summary the row leads with WHO runs the
 * group and puts the counts on the right; without one there is no verified
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
 * empty-group example reads `0 skills · 0 tools`, so this is a label for two
 * quantities rather than a sentence about them, and it stays the same width as
 * the row above it.
 */
function countsText(skills: number, tools: number): string {
  return `${skills} skills · ${tools} tools`;
}

function countKind(items: LibraryItem[], group: string | null, kind: LibraryItem['kind']): number {
  return items.filter((i) => i.group === group && i.kind === kind).length;
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
