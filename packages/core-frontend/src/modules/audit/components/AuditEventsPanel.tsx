import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Banner, Button } from '../../../shared/components';
import { cn } from '../../../lib/utils';
import { pathForSkill, pathForTool } from '../../library/routes/library-paths';
import {
  listEvents,
  type AgentEvent,
  type AgentEventKind,
  type AgentEventOutcome,
  type AuditPrincipalKind,
} from '../services/audit.api';

/** How many events one load brings; "Load older events" fetches the next batch. */
const PAGE_SIZE = 50;

const KIND_LABEL: Record<AgentEventKind, string> = {
  capability: 'Hexis capability',
  tool: 'Tool',
  skill: 'Skill',
};

/** A small square per kind — a category mark, not a status (statuses are the outcome badge). */
const KIND_MARK: Record<AgentEventKind, string> = {
  capability: 'bg-accent',
  tool: 'bg-ink-faint',
  skill: 'bg-ok',
};

const OUTCOME: Record<AgentEventOutcome, { tone: 'ok' | 'danger' | 'wait'; label: string }> = {
  ok: { tone: 'ok', label: 'ok' },
  error: { tone: 'danger', label: 'error' },
  denied: { tone: 'wait', label: 'needs sign-in' },
};

type TypeFilter = 'all' | AgentEventKind;

const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'capability', label: KIND_LABEL.capability },
  { id: 'tool', label: KIND_LABEL.tool },
  { id: 'skill', label: KIND_LABEL.skill },
];

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "Today", "Yesterday", or the date — the day separator's label. */
function dayLabel(at: number, now: number): string {
  const day = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(now - 24 * 60 * 60 * 1000);
  const date = day.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  if (day.toDateString() === today.toDateString()) return `Today · ${date}`;
  if (day.toDateString() === yesterday.toDateString()) return `Yesterday · ${date}`;
  return date;
}

/**
 * The "What was called" cell. A skill shows just its name and opens the
 * skill's page; a tool shows `server · tool` and opens that manual's page —
 * both through the name-based library routes, so no catalog is needed here.
 * A hexis capability is plain text: it has no page of its own.
 */
function WhatWasCalled({ event }: { event: AgentEvent }) {
  const link = 'border-b border-line-strong hover:border-accent hover:text-accent';
  if (event.kind === 'skill') {
    return (
      <Link to={pathForSkill(event.name)} className={link} title={`Open the ${event.name} skill`}>
        {event.name}
      </Link>
    );
  }
  if (event.kind === 'tool' && event.manual) {
    return (
      <Link to={pathForTool(event.manual)} className={link} title={`Open the ${event.manual} tool page`}>
        <span className="text-ink-muted">{event.manual}</span>
        <span className="text-ink-faint"> · </span>
        {event.name}
      </Link>
    );
  }
  return <>{event.name}</>;
}

/**
 * One principal's events, rendered under its row in the Audit log: filters
 * over what has been loaded, the day-grouped table, and the way to older
 * pages. Loads on mount — the page mounts it on the row's first expand and
 * keeps it, so collapsing and re-expanding costs no request.
 */
export function AuditEventsPanel({
  kind,
  id,
  label,
}: {
  kind: AuditPrincipalKind;
  id: string;
  /** The row's label, for the accessible names of the controls in here. */
  label: string;
}) {
  const searchId = useId();
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [query, setQuery] = useState('');
  // "Today" and "Yesterday" are decided against the moment the panel opened —
  // read once, so a re-render never shifts a separator on its own.
  const [now] = useState(() => Date.now());

  // Generation of the newest first-page load: a "Try again" pressed while an
  // earlier attempt is still out must not let that attempt land afterwards.
  const loadGen = useRef(0);
  const loadFirstPage = useCallback(() => {
    const gen = ++loadGen.current;
    listEvents(kind, id, { limit: PAGE_SIZE })
      .then((page) => {
        if (gen !== loadGen.current) return;
        setEvents(page.events);
        setTotal(page.total ?? 0);
        setNextCursor(page.nextCursor);
        setError(null);
      })
      .catch((err) => {
        if (gen !== loadGen.current) return;
        setError(err instanceof Error ? err.message : "Couldn't load events.");
      });
  }, [kind, id]);

  useEffect(() => {
    loadFirstPage();
    return () => {
      // Unmounting retires every attempt in flight.
      loadGen.current += 1;
    };
  }, [loadFirstPage]);

  const loadOlder = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listEvents(kind, id, { before: nextCursor, limit: PAGE_SIZE });
      setEvents((prev) => [...(prev ?? []), ...page.events]);
      // A cursor page carries no total: the first page's stands.
      if (page.total !== null) setTotal(page.total);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load older events.");
    } finally {
      setLoadingMore(false);
    }
  }, [kind, id, nextCursor, loadingMore]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      (events ?? []).filter(
        (e) =>
          (typeFilter === 'all' || e.kind === typeFilter) &&
          (!errorsOnly || e.outcome !== 'ok') &&
          (!q || e.name.toLowerCase().includes(q) || (e.manual ?? '').toLowerCase().includes(q)),
      ),
    [events, typeFilter, errorsOnly, q],
  );

  // Day separators are derived at render: a separator before the first event
  // of each day, in the (newest-first) order the rows already have.
  const rows: Array<{ day: string } | { event: AgentEvent }> = [];
  let lastDay: string | null = null;
  for (const event of visible) {
    const day = dayLabel(event.at, now);
    if (day !== lastDay) {
      rows.push({ day });
      lastDay = day;
    }
    rows.push({ event });
  }

  if (error && events === null) {
    // The panel stays mounted across a collapse, so without a way to re-ask
    // a failed first load would be this row's permanent state.
    return (
      <Banner tone="danger" role="alert" className="text-detail">
        {error}
        <Button variant="outline" size="sm" className="ml-3" onClick={loadFirstPage}>
          Try again
        </Button>
      </Banner>
    );
  }
  if (events === null) return <div className="text-xs text-ink-muted">Loading…</div>;
  if (events.length === 0) {
    return (
      <div className="text-detail text-ink-muted text-center py-3">
        Nothing called yet. Events appear here the first time this {kind === 'agent' ? 'agent' : 'key'} uses a
        tool, a skill, or a Hexis capability.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-detail text-ink-muted">
        <div className="flex flex-wrap gap-1" role="group" aria-label={`Filter ${label}'s events by type`}>
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={typeFilter === f.id}
              onClick={() => setTypeFilter(f.id)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-meta',
                typeFilter === f.id
                  ? 'border-line bg-white text-ink shadow-card'
                  : 'border-transparent text-ink-muted hover:bg-hover hover:text-ink',
              )}
            >
              {f.id !== 'all' && <span aria-hidden className={cn('size-2 rounded-[2px]', KIND_MARK[f.id])} />}
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
            Errors only
          </label>
          <input
            id={searchId}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name"
            aria-label={`Filter ${label}'s events by name`}
            className="bg-white border border-line rounded-sm px-2 py-1 text-detail text-ink focus:outline-none focus:border-accent min-w-[180px]"
          />
        </div>
      </div>

      {error && (
        <Banner tone="danger" role="alert" className="text-detail">
          {error}
        </Banner>
      )}

      <div className="bg-white border border-line rounded-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-detail">
            <thead>
              <tr className="text-label uppercase tracking-[0.09em] text-ink-faint">
                <th className="text-left font-semibold px-3 py-1.5 border-b border-line">What was called</th>
                <th className="text-left font-semibold px-3 py-1.5 border-b border-line w-40">Type</th>
                <th className="text-left font-semibold px-3 py-1.5 border-b border-line w-32">Outcome</th>
                <th className="text-left font-semibold px-3 py-1.5 border-b border-line w-28">When</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-center text-ink-muted">
                    No events match these filters.
                  </td>
                </tr>
              )}
              {rows.map((row) =>
                'day' in row ? (
                  <tr key={`day:${row.day}`}>
                    <td colSpan={4} className="bg-sunken px-3 py-0.5 text-meta font-medium text-ink-muted">
                      {row.day}
                    </td>
                  </tr>
                ) : (
                  <Fragment key={row.event.id}>
                    <tr className="hover:bg-surface-hover">
                      <td className="px-3 py-1.5 border-t border-line font-mono text-detail">
                        <WhatWasCalled event={row.event} />
                      </td>
                      <td className="px-3 py-1.5 border-t border-line">
                        <span className="inline-flex items-center gap-1.5">
                          <span aria-hidden className={cn('size-2 rounded-[2px]', KIND_MARK[row.event.kind])} />
                          {KIND_LABEL[row.event.kind]}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 border-t border-line">
                        <Badge tone={OUTCOME[row.event.outcome].tone}>{OUTCOME[row.event.outcome].label}</Badge>
                      </td>
                      <td
                        className="px-3 py-1.5 border-t border-line text-ink-muted tabular-nums whitespace-nowrap"
                        title={new Date(row.event.at).toLocaleString()}
                      >
                        {timeOf(row.event.at)}
                      </td>
                    </tr>
                  </Fragment>
                ),
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-t border-line text-meta text-ink-muted">
          <span>
            Showing {events.length.toLocaleString()} of {total.toLocaleString()} {total === 1 ? 'event' : 'events'} ·
            newest first
          </span>
          {nextCursor && (
            <Button variant="outline" size="sm" onClick={() => void loadOlder()} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load older events'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
