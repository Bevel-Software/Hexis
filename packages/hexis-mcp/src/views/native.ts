/**
 * The compact, phone-native presentation of a knowledge view.
 *
 * A knowledge view is a page written for a wide screen. Shown in a chat (a
 * narrow column, often on a phone) the same page means a squeezed sidebar or a
 * board that scrolls sideways. So inside an MCP host the bridge shows this
 * instead, built from the SAME data the page renders, and keeps the page one
 * tap away ("Full page", fullscreen where the host has it).
 *
 * Nothing here is configured per page. What it shows is read from the view's
 * snapshot:
 * - `Board` nodes (Card Type, Folder, Column Field, Columns, Done Columns, Card
 *   Fields) become boards: column tabs, cards, a card's detail with "move to";
 * - tasks (nodes with a Status and a Due) become an agenda: overdue, today,
 *   upcoming, completed, each with a checkbox;
 * - anything else becomes a list grouped by node type.
 *
 * Edits are queued, shown on the cards, and sent to the chat as one message for
 * the agent to write (the page cannot write files itself, in the app or here).
 *
 * `nativeApp` runs in the browser: it is shipped as its own compiled source
 * (`nativeApp.toString()`), so it must not reach anything outside itself.
 * Types are erased and free to use.
 */

interface FieldLite {
  text?: string;
}
interface NodeLite {
  node_type: string;
  id?: string | null;
  file_path?: string;
  fields?: Record<string, FieldLite>;
}
interface SnapshotLite {
  takenAt?: string;
  nodes?: Record<string, NodeLite>;
}
interface HostContextLite {
  theme?: string;
  displayMode?: string;
  availableDisplayModes?: string[];
  platform?: string;
}
/** What the bridge (bridge.ts) exposes on `window.__hexis`. */
interface HexisApi {
  context(): HostContextLite;
  on(event: 'snapshot' | 'context' | 'live-error', fn: (arg: unknown) => void): void;
  sendToChat(text: string): Promise<void>;
  openKbFile(path: string): Promise<void>;
  requestDisplayMode(mode: string): Promise<string>;
  toast(text: string): void;
  reportSize(): void;
}

function nativeApp(): void {
  const w = window as unknown as { __hexis?: HexisApi; KB_SNAPSHOT?: SnapshotLite };
  const H = w.__hexis;
  if (!H) return;
  const root = document.documentElement;

  // -- text --------------------------------------------------------------------
  const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c] ?? c);
  const plain = (s: string): string =>
    s
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
  /** A field's list (`- a\n- b`), or its lines. */
  const listOf = (s: string): string[] => {
    const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const bullets = lines.filter((l) => /^[-*+]\s+/.test(l));
    return (bullets.length ? bullets.map((l) => l.replace(/^[-*+]\s+/, '')) : lines).map(plain);
  };
  const label = (slug: string): string => {
    const s = slug.replace(/[-_]+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  /** `ApplicationDocument` -> `Application document`. */
  const typeLabel = (t: string): string => label(t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase());
  const baseName = (p: string): string => label(p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, ''));
  const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

  // -- dates ---------------------------------------------------------------------
  const pad = (n: number): string => String(n).padStart(2, '0');
  const iso = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = iso(new Date());
  const dayAfter = (day: string, n: number): string => {
    const d = new Date(`${day}T00:00:00`);
    d.setDate(d.getDate() + n);
    return iso(d);
  };
  const isDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
  const fmtDate = (day: string): string => {
    if (!isDate(day)) return day;
    if (day === today) return 'Today';
    if (day === dayAfter(today, 1)) return 'Tomorrow';
    if (day === dayAfter(today, -1)) return 'Yesterday';
    const d = new Date(`${day}T00:00:00`);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  };

  // -- icons -----------------------------------------------------------------------
  const svg = (d: string, cls = 'hx-i'): string =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const I = {
    back: svg('<path d="M15 5l-7 7 7 7"/>', 'hx-i hx-i-back'),
    chev: svg('<path d="M9 6l6 6-6 6"/>', 'hx-i hx-chev'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>', 'hx-i hx-i-check'),
    expand: svg('<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>'),
    cal: svg('<rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/>', 'hx-i hx-i-sm'),
    out: svg('<path d="M14 5h5v5M19 5l-8 8M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/>', 'hx-i hx-i-sm'),
    down: svg('<path d="M6 9l6 6 6-6"/>', 'hx-i hx-i-sm'),
  };

  // -- data ---------------------------------------------------------------------------
  interface Item {
    path: string;
    type: string;
    name: string;
    f: Record<string, string>;
  }
  interface Board {
    path: string;
    name: string;
    field: string;
    columns: string[];
    done: Set<string>;
    cardFields: string[];
    cards: Item[];
  }
  let snap: SnapshotLite = w.KB_SNAPSHOT ?? {};
  let live = false;
  let liveError = '';
  let items: Item[] = [];
  let boards: Board[] = [];
  const byPath = new Map<string, Item>();

  function load(next: SnapshotLite): void {
    snap = next ?? {};
    items = Object.entries(snap.nodes ?? {}).map(([p, n]) => {
      const f: Record<string, string> = {};
      for (const [k, v] of Object.entries(n.fields ?? {})) f[k] = (v?.text ?? '').trim();
      const path = n.file_path || p;
      return { path, type: n.node_type, name: plain(f.Name || f.Title || '') || baseName(path), f };
    });
    byPath.clear();
    for (const it of items) byPath.set(it.path, it);
    boards = items
      .filter((b) => b.type === 'Board' && b.f['Card Type'] && b.f['Column Field'])
      .map((b) => {
        const folder = plain(b.f.Folder || '').replace(/^\/+/, '').replace(/^knowledge-base\//, '').replace(/\/+$/, '');
        const cardType = plain(b.f['Card Type']);
        const field = plain(b.f['Column Field']);
        const cards = items.filter((c) => c.type === cardType && (!folder || c.path.startsWith(`${folder}/`)));
        return {
          path: b.path,
          name: b.name,
          field,
          columns: listOf(b.f.Columns || ''),
          done: new Set(listOf(b.f['Done Columns'] || '').map((c) => c.toLowerCase())),
          cardFields: listOf(b.f['Card Fields'] || '').length ? listOf(b.f['Card Fields'] || '') : guessCardFields(cards, field),
          cards,
        };
      });
  }
  /** When a board names no card fields (or its view left them out): the ones a card is usually read by. */
  const PREFERRED = ['Owner', 'Company', 'Due', 'Priority', 'Project', 'Category', 'Fit', 'Last Seen', 'Deadline', 'Next Step', 'Next Action', 'Summary'];
  function guessCardFields(cards: Item[], columnField: string): string[] {
    const present = new Set(cards.flatMap((c) => Object.keys(c.f).filter((k) => c.f[k])));
    const chosen = PREFERRED.filter((k) => present.has(k) && k !== columnField);
    if (chosen.length) return chosen.slice(0, 3);
    return [...present].filter((k) => !['Name', 'Title', columnField].includes(k)).slice(0, 2);
  }
  const isAgenda = (): boolean =>
    !boards.length && items.length > 0 && items.every((i) => 'Status' in i.f) && items.some((i) => 'Due' in i.f);

  // -- edits: queued, then sent to the chat as one message ---------------------------------
  interface Edit {
    item: Item;
    scope: string;
    sets: Record<string, string>;
  }
  const pending = new Map<string, Edit>();
  const sent = new Map<string, Record<string, string>>();
  const valueOf = (it: Item, field: string): string => {
    const p = pending.get(it.path)?.sets;
    if (p && field in p) return p[field]!;
    const s = sent.get(it.path);
    if (s && field in s) return s[field]!;
    return it.f[field] ?? '';
  };
  const editState = (it: Item): '' | 'pending' | 'sent' =>
    pending.has(it.path) ? 'pending' : sent.has(it.path) ? 'sent' : '';
  function setFields(it: Item, scope: string, sets: Record<string, string>): void {
    const e = pending.get(it.path) ?? { item: it, scope, sets: {} };
    for (const [k, v] of Object.entries(sets)) {
      const base = sent.get(it.path)?.[k] ?? it.f[k] ?? '';
      if (v === base) delete e.sets[k];
      else e.sets[k] = v;
    }
    if (Object.keys(e.sets).length) pending.set(it.path, e);
    else pending.delete(it.path);
  }
  function instructions(): string {
    const list = [...pending.values()];
    const scopes = [...new Set(list.map((e) => e.scope))];
    const lines = list.map((e, i) => {
      const parts = Object.entries(e.sets).map(([k, v]) => (v ? `set ${k} to ${v}` : `remove ${k}`));
      return `${i + 1}. In ${e.item.path} ("${e.item.name}"), ${parts.join(', ')}.`;
    });
    return [
      `Update my ${scopes.join(' and ')} in the Hexis knowledge base. Write these changes directly to the files and keep every other field as it is:`,
      '',
      ...lines,
    ].join('\n');
  }
  function reconcileSent(): void {
    for (const [path, sets] of sent) {
      const it = byPath.get(path);
      if (!it) continue;
      for (const [k, v] of Object.entries(sets)) if ((it.f[k] ?? '') === v) delete sets[k];
      if (!Object.keys(sets).length) sent.delete(path);
    }
  }

  // -- board helpers ------------------------------------------------------------------------
  const tone = (board: Board | null, col: string): string => {
    const c = col.toLowerCase();
    if (/block|dead|reject|skip|lost|cancel/.test(c)) return 'danger';
    if (board?.done.has(c) || /^(done|closed|submitted|complete)/.test(c)) return 'success';
    if (/wait|review|pending|progress|sign/.test(c)) return 'warning';
    return 'neutral';
  };
  const columnOf = (board: Board, card: Item): string => {
    const v = valueOf(card, board.field).toLowerCase();
    return board.columns.find((c) => c.toLowerCase() === v) ?? 'other';
  };
  const columnsWithOther = (board: Board): string[] =>
    board.cards.some((c) => columnOf(board, c) === 'other') ? [...board.columns, 'other'] : board.columns;
  const openCount = (board: Board): number => board.cards.filter((c) => !board.done.has(columnOf(board, c).toLowerCase())).length;
  const selectedTab = new Map<string, string>();
  const tabOf = (board: Board): string => {
    const cols = columnsWithOther(board);
    const chosen = selectedTab.get(board.path);
    if (chosen && cols.includes(chosen)) return chosen;
    const first = cols.find((c) => !board.done.has(c.toLowerCase()) && board.cards.some((k) => columnOf(board, k) === c));
    return first ?? cols[0] ?? 'other';
  };

  // -- screens ----------------------------------------------------------------------------------
  type Screen =
    | { kind: 'home' }
    | { kind: 'board'; board: string }
    | { kind: 'agenda' }
    | { kind: 'list' }
    | { kind: 'item'; path: string; board?: string };
  let stack: Screen[] = [];
  let anim: '' | 'push' | 'pop' = '';
  let showCompleted = false;
  const pageTitle = (): string => {
    const t = document.title.trim();
    return t || (boards.length === 1 ? boards[0]!.name : 'Knowledge view');
  };
  const rootScreen = (): Screen =>
    boards.length > 1
      ? { kind: 'home' }
      : boards.length === 1
        ? { kind: 'board', board: boards[0]!.path }
        : isAgenda()
          ? { kind: 'agenda' }
          : { kind: 'list' };
  const boardByPath = (p?: string): Board | null => boards.find((b) => b.path === p) ?? null;
  const titleOf = (s: Screen): string => {
    if (s.kind === 'board') return boardByPath(s.board)?.name ?? pageTitle();
    if (s.kind === 'item') return byPath.get(s.path)?.name ?? '';
    return pageTitle();
  };

  const chip = (it: Item): string => {
    const st = editState(it);
    return st ? `<span class="hx-chip ${st === 'pending' ? 'is-pending' : ''}">${st === 'pending' ? 'Edited' : 'Sent'}</span>` : '';
  };
  const shortFacts = (it: Item, fields: string[]): string[] =>
    fields
      .map((k) => [k, plain(valueOf(it, k))] as const)
      .filter(([, v]) => v && v.length <= 32 && !v.includes('\n'))
      .map(([, v]) => (isDate(v) ? fmtDate(v) : v));
  const longFact = (it: Item, fields: string[]): string =>
    fields.map((k) => plain(valueOf(it, k))).find((v) => v.length > 32 || v.includes('\n'))?.replace(/\s+/g, ' ') ?? '';

  function homeView(): string {
    const cards = boards.reduce((n, b) => n + b.cards.length, 0);
    const open = boards.reduce((n, b) => n + openCount(b), 0);
    const rows = boards
      .map((b) => {
        const o = openCount(b);
        const pct = b.cards.length ? Math.round(((b.cards.length - o) / b.cards.length) * 100) : 0;
        return `<button class="hx-row" data-act="open-board" data-path="${esc(b.path)}">
          <span class="hx-row-main"><span class="hx-row-title">${esc(b.name)}</span>
            <span class="hx-row-sub">${o} open · ${b.cards.length - o} done</span>
            <span class="hx-progress" aria-hidden="true"><span style="width:${pct}%"></span></span></span>
          ${I.chev}</button>`;
      })
      .join('');
    return `<h1 class="hx-title">${esc(pageTitle())}</h1>
      <p class="hx-sub">${plural(boards.length, 'board')} · ${plural(cards, 'card')} · ${open} open</p>
      <div class="hx-group">${rows}</div>`;
  }

  function cardRow(board: Board, card: Item): string {
    const col = columnOf(board, card);
    const facts = shortFacts(card, board.cardFields);
    const note = longFact(card, board.cardFields);
    return `<button class="hx-row hx-card" data-act="open-item" data-path="${esc(card.path)}" data-board="${esc(board.path)}">
      <span class="hx-dot tone-${tone(board, col)}" aria-hidden="true"></span>
      <span class="hx-row-main"><span class="hx-row-title">${esc(card.name)}</span>
        ${facts.length ? `<span class="hx-row-sub">${facts.map(esc).join(' · ')}</span>` : ''}
        ${note ? `<span class="hx-row-note">${esc(note)}</span>` : ''}</span>
      ${chip(card)}${I.chev}</button>`;
  }

  function boardView(s: { board: string }): string {
    const board = boardByPath(s.board);
    if (!board) return `<p class="hx-empty">This board is not in the view's data.</p>`;
    const cols = columnsWithOther(board);
    const tab = tabOf(board);
    const counts = new Map(cols.map((c) => [c, board.cards.filter((k) => columnOf(board, k) === c).length]));
    const cards = board.cards.filter((k) => columnOf(board, k) === tab).sort((a, b) => a.name.localeCompare(b.name));
    const open = openCount(board);
    return `<h1 class="hx-title">${esc(board.name)}</h1>
      <p class="hx-sub">${open} open · ${board.cards.length - open} done</p>
      <nav class="hx-tabs" role="tablist" aria-label="${esc(board.field)}">${cols
        .map(
          (c) => `<button role="tab" aria-selected="${c === tab}" class="hx-tab ${c === tab ? 'is-on' : ''}" data-act="tab" data-col="${esc(c)}">
            <span class="hx-dot tone-${tone(board, c)}" aria-hidden="true"></span>${esc(label(c))}<span class="hx-tab-n">${counts.get(c) ?? 0}</span></button>`,
        )
        .join('')}</nav>
      <div class="hx-group hx-swipe" data-board="${esc(board.path)}">${
        cards.length ? cards.map((k) => cardRow(board, k)).join('') : `<p class="hx-empty">Nothing in ${esc(label(tab))}.</p>`
      }</div>`;
  }

  function taskRow(it: Item): string {
    const done = valueOf(it, 'Status').toLowerCase() === 'done';
    const due = valueOf(it, 'Due');
    const time = valueOf(it, 'Time');
    const project = plain(valueOf(it, 'Project'));
    const prio = (valueOf(it, 'Priority') || 'p4').toLowerCase();
    const overdue = !done && isDate(due) && due < today;
    const when = due ? `<span class="hx-when ${overdue ? 'is-danger' : ''}">${I.cal}${esc(fmtDate(due))}${time ? ` ${esc(time)}` : ''}</span>` : '';
    return `<div class="hx-row hx-task ${done ? 'is-done' : ''}">
      <button class="hx-check prio-${esc(prio)}" role="checkbox" aria-checked="${done}" aria-label="${done ? 'Mark not done' : 'Complete'}: ${esc(it.name)}" data-act="toggle-done" data-path="${esc(it.path)}">${I.check}</button>
      <button class="hx-row-main hx-task-main" data-act="open-item" data-path="${esc(it.path)}">
        <span class="hx-row-title">${esc(it.name)}</span>
        ${when || project ? `<span class="hx-row-sub">${when}${project ? `<span class="hx-proj"># ${esc(project)}</span>` : ''}</span>` : ''}
      </button>${chip(it)}</div>`;
  }

  function agendaView(): string {
    const isDone = (it: Item): boolean => valueOf(it, 'Status').toLowerCase() === 'done';
    const open = items.filter((i) => !isDone(i));
    const done = items.filter(isDone);
    const byDue = (a: Item, b: Item): number =>
      (valueOf(a, 'Due') + valueOf(a, 'Time')).localeCompare(valueOf(b, 'Due') + valueOf(b, 'Time')) || a.name.localeCompare(b.name);
    const overdue = open.filter((i) => isDate(valueOf(i, 'Due')) && valueOf(i, 'Due') < today).sort(byDue);
    const dated = open.filter((i) => isDate(valueOf(i, 'Due')) && valueOf(i, 'Due') >= today).sort(byDue);
    const undated = open.filter((i) => !isDate(valueOf(i, 'Due'))).sort((a, b) => a.name.localeCompare(b.name));
    const days = [...new Set(dated.map((i) => valueOf(i, 'Due')))];
    const section = (title: string, list: Item[], cls = ''): string =>
      list.length
        ? `<h2 class="hx-section ${cls}">${esc(title)}<span>${list.length}</span></h2><div class="hx-group">${list.map(taskRow).join('')}</div>`
        : '';
    const sub = [plural(open.length, 'task') + ' open', overdue.length ? `${overdue.length} overdue` : ''].filter(Boolean).join(' · ');
    return `<h1 class="hx-title">${esc(pageTitle())}</h1><p class="hx-sub">${esc(sub)}</p>
      ${section('Overdue', overdue, 'is-danger')}
      ${days.map((d) => section(fmtDate(d), dated.filter((i) => valueOf(i, 'Due') === d))).join('')}
      ${section('No date', undated)}
      ${open.length ? '' : `<p class="hx-empty">All done.</p>`}
      ${
        done.length
          ? `<button class="hx-section hx-disclose ${showCompleted ? 'is-open' : ''}" data-act="toggle-completed">Completed<span>${done.length}</span>${I.down}</button>
             ${showCompleted ? `<div class="hx-group">${done.sort(byDue).map(taskRow).join('')}</div>` : ''}`
          : ''
      }`;
  }

  function listView(): string {
    const types = [...new Set(items.map((i) => i.type))].sort();
    return `<h1 class="hx-title">${esc(pageTitle())}</h1><p class="hx-sub">${plural(items.length, 'item')}</p>
      ${types
        .map((t) => {
          const list = items.filter((i) => i.type === t).sort((a, b) => a.name.localeCompare(b.name));
          return `<h2 class="hx-section">${esc(typeLabel(t))}<span>${list.length}</span></h2><div class="hx-group">${list
            .map((it) => {
              const facts = shortFacts(it, Object.keys(it.f).filter((k) => !['Name', 'Title'].includes(k))).slice(0, 3);
              return `<button class="hx-row" data-act="open-item" data-path="${esc(it.path)}"><span class="hx-row-main">
                <span class="hx-row-title">${esc(it.name)}</span>${facts.length ? `<span class="hx-row-sub">${facts.map(esc).join(' · ')}</span>` : ''}
              </span>${chip(it)}${I.chev}</button>`;
            })
            .join('')}</div>`;
        })
        .join('')}`;
  }

  function fieldRows(it: Item, skip: Set<string>): string {
    return Object.keys(it.f)
      .filter((k) => !skip.has(k))
      .map((k) => {
        const raw = valueOf(it, k);
        if (!raw) return '';
        const bullets = /^\s*[-*+]\s+/m.test(raw) ? listOf(raw) : null;
        const text = bullets ? bullets.map((b) => `• ${b}`).join('\n') : plain(raw);
        const shown = isDate(text) ? fmtDate(text) : text;
        const long = shown.length > 28 || shown.includes('\n');
        return long
          ? `<div class="hx-row hx-kv is-long"><span class="hx-k">${esc(k)}</span><span class="hx-v">${esc(shown)}</span></div>`
          : `<div class="hx-row hx-kv"><span class="hx-k">${esc(k)}</span><span class="hx-v">${esc(shown)}</span></div>`;
      })
      .join('');
  }

  function itemView(s: { path: string; board?: string }): string {
    const it = byPath.get(s.path);
    if (!it) return `<p class="hx-empty">This item is not in the view's data any more.</p>`;
    const board = boardByPath(s.board);
    const task = !board && 'Status' in it.f && ('Due' in it.f || it.type === 'Task');
    const skip = new Set(['Name', 'Title', ...(board ? [board.field] : []), ...(task ? ['Status'] : [])]);
    const st = editState(it);
    let actions = '';
    if (board) {
      const cur = columnOf(board, it);
      actions = `<h2 class="hx-section">${esc(board.field)}</h2><div class="hx-group" role="radiogroup">${columnsWithOther(board)
        .filter((c) => c !== 'other' || cur === 'other')
        .map(
          (c) => `<button class="hx-row hx-option" role="radio" aria-checked="${c === cur}" data-act="set-col" data-col="${esc(c)}">
            <span class="hx-dot tone-${tone(board, c)}" aria-hidden="true"></span><span class="hx-row-title">${esc(c === 'other' ? valueOf(it, board.field) || 'None' : label(c))}</span>
            ${c === cur ? I.check : ''}</button>`,
        )
        .join('')}</div>`;
    } else if (task) {
      const done = valueOf(it, 'Status').toLowerCase() === 'done';
      actions = `<div class="hx-group"><button class="hx-row hx-action" data-act="toggle-done" data-path="${esc(it.path)}">${
        done ? 'Mark as not done' : 'Mark as done'
      }</button></div>`;
    }
    return `<h1 class="hx-title hx-title-item">${esc(it.name)}</h1>
      <p class="hx-sub">${esc(typeLabel(it.type))}${board ? ` · ${esc(board.name)}` : ''}${
        st ? ` · <span class="hx-accent">${st === 'pending' ? 'edited, not sent yet' : 'sent to Claude'}</span>` : ''
      }</p>
      ${actions}
      <h2 class="hx-section">Details</h2><div class="hx-group">${fieldRows(it, skip) || '<p class="hx-empty">No other fields.</p>'}</div>
      <div class="hx-group"><button class="hx-row hx-link" data-act="open-hexis" data-path="${esc(it.path)}">Open in Hexis${I.out}</button></div>`;
  }

  // -- the shell -------------------------------------------------------------------------------
  const app = document.createElement('div');
  app.id = 'hx-native';
  app.hidden = true;

  function screenHtml(s: Screen): string {
    if (s.kind === 'home') return homeView();
    if (s.kind === 'board') return boardView(s);
    if (s.kind === 'agenda') return agendaView();
    if (s.kind === 'item') return itemView(s);
    return listView();
  }

  function render(): void {
    if (!stack.length) stack = [rootScreen()];
    const s = stack[stack.length - 1]!;
    const prev = stack.length > 1 ? titleOf(stack[stack.length - 2]!) : '';
    const footer = live
      ? 'Live from Hexis'
      : `${snap.takenAt ? `Snapshot of ${esc(snap.takenAt)}` : 'Snapshot'}${liveError ? ` · live data did not load` : ' · loading live data…'}`;
    const n = pending.size;
    app.innerHTML = `
      <header class="hx-bar ${window.scrollY > 36 ? 'is-scrolled' : ''}">
        <div class="hx-bar-l">${prev ? `<button class="hx-back" data-act="back">${I.back}<span>${esc(prev)}</span></button>` : ''}</div>
        <div class="hx-bar-c">${esc(titleOf(s))}</div>
        <div class="hx-bar-r"><button class="hx-icon-btn" data-act="full" aria-label="Open the full page" title="Full page">${I.expand}</button></div>
      </header>
      <main class="hx-screen ${anim ? `hx-${anim}` : ''}">${screenHtml(s)}<p class="hx-foot">${footer}</p></main>
      ${
        n
          ? `<div class="hx-pending" role="status"><div class="hx-pending-in"><span class="hx-pending-n">${plural(n, 'change')}</span>
             <button class="hx-btn-plain" data-act="discard">Discard</button>
             <button class="hx-btn" data-act="send">Send to Claude</button></div></div>`
          : ''
      }`;
    anim = '';
    // Keep the chosen column in sight: on a phone most of the tab strip is off-screen.
    const tabs = app.querySelector<HTMLElement>('.hx-tabs');
    const on = tabs?.querySelector<HTMLElement>('.hx-tab.is-on');
    if (tabs && on) tabs.scrollLeft = Math.max(0, on.offsetLeft - (tabs.clientWidth - on.offsetWidth) / 2);
    H!.reportSize();
  }

  const push = (s: Screen): void => {
    stack.push(s);
    anim = 'push';
    window.scrollTo(0, 0);
    render();
  };
  const pop = (): void => {
    if (stack.length > 1) stack.pop();
    anim = 'pop';
    render();
  };

  app.addEventListener('click', (event) => {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const top = stack[stack.length - 1];
    if (act === 'back') pop();
    else if (act === 'full') void showPage();
    else if (act === 'open-board') push({ kind: 'board', board: el.dataset.path ?? '' });
    else if (act === 'open-item') push({ kind: 'item', path: el.dataset.path ?? '', board: el.dataset.board });
    else if (act === 'tab' && top?.kind === 'board') {
      selectedTab.set(top.board, el.dataset.col ?? '');
      render();
    } else if (act === 'set-col' && top?.kind === 'item') {
      const it = byPath.get(top.path);
      const board = boardByPath(top.board);
      if (it && board && el.dataset.col && el.dataset.col !== 'other') {
        setFields(it, board.name, { [board.field]: el.dataset.col });
        selectedTab.set(board.path, el.dataset.col);
        render();
      }
    } else if (act === 'toggle-done') {
      const it = byPath.get(el.dataset.path ?? '');
      if (it) {
        const done = valueOf(it, 'Status').toLowerCase() === 'done';
        setFields(it, pageTitle(), done ? { Status: 'open', Completed: '' } : { Status: 'done', Completed: today });
        render();
      }
    } else if (act === 'toggle-completed') {
      showCompleted = !showCompleted;
      render();
    } else if (act === 'open-hexis') {
      void H!.openKbFile(el.dataset.path ?? '');
    } else if (act === 'discard') {
      pending.clear();
      render();
    } else if (act === 'send') {
      const text = instructions();
      el.setAttribute('disabled', '');
      H!.sendToChat(text).then(
        () => {
          for (const [path, e] of pending) sent.set(path, { ...(sent.get(path) ?? {}), ...e.sets });
          pending.clear();
          render();
        },
        () => {
          H!.toast('The chat did not take the message. Try again, or use the full page.');
          render();
        },
      );
    }
  });

  // Swipe between a board's columns.
  let touch: { x: number; y: number } | null = null;
  app.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    touch = t && (e.target as HTMLElement).closest('.hx-swipe') ? { x: t.clientX, y: t.clientY } : null;
  }, { passive: true });
  app.addEventListener('touchend', (e) => {
    const t = e.changedTouches[0];
    const top = stack[stack.length - 1];
    if (!touch || !t || top?.kind !== 'board') return;
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) < 60 || Math.abs(dy) > 40) return;
    const board = boardByPath(top.board);
    if (!board) return;
    const cols = columnsWithOther(board);
    const i = cols.indexOf(tabOf(board)) + (dx < 0 ? 1 : -1);
    if (i < 0 || i >= cols.length) return;
    selectedTab.set(board.path, cols[i]!);
    anim = dx < 0 ? 'push' : 'pop';
    render();
  }, { passive: true });

  window.addEventListener('scroll', () => {
    app.querySelector('.hx-bar')?.classList.toggle('is-scrolled', window.scrollY > 36);
  }, { passive: true });

  // -- compact (this) vs the full page -------------------------------------------------------
  const controls = document.createElement('div');
  controls.id = 'hx-page-controls';
  let override: 'native' | 'page' | null = null;
  let lastDisplay = H.context().displayMode;
  const canFullscreen = (): boolean => (H!.context().availableDisplayModes ?? []).includes('fullscreen');
  const autoMode = (): 'native' | 'page' => {
    const c = H!.context();
    return c.platform === 'mobile' || window.innerWidth < 720 || c.displayMode !== 'fullscreen' ? 'native' : 'page';
  };
  let shown: 'native' | 'page' | null = null;
  /**
   * Show what the mode says. Only a CHANGE of mode re-renders: a resize or a
   * context update that keeps the mode would otherwise loop (render, report a
   * height, the host resizes the frame, render again).
   */
  function applyMode(): void {
    const mode = override ?? autoMode();
    const native = mode === 'native';
    const full = H!.context().displayMode === 'fullscreen';
    const buttons = native
      ? ''
      : `<button data-act="compact">Compact view</button>${
          canFullscreen() ? `<button data-act="fullscreen">${full ? 'Exit full screen' : 'Full screen'}</button>` : ''
        }`;
    if (controls.innerHTML !== buttons) controls.innerHTML = buttons;
    controls.hidden = native;
    if (mode === shown) return;
    shown = mode;
    root.classList.toggle('hx-native', native);
    app.hidden = !native;
    if (native) render();
    else H!.reportSize();
  }
  async function showPage(): Promise<void> {
    override = 'page';
    if (canFullscreen() && H!.context().displayMode !== 'fullscreen') {
      try {
        await H!.requestDisplayMode('fullscreen');
      } catch {
        /* stays inline: the page shows there */
      }
    }
    applyMode();
  }
  controls.addEventListener('click', (event) => {
    const act = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'compact') {
      override = 'native';
      if (H!.context().displayMode === 'fullscreen') void H!.requestDisplayMode('inline').catch(() => {});
      applyMode();
    } else if (act === 'fullscreen') {
      const full = H!.context().displayMode === 'fullscreen';
      void H!.requestDisplayMode(full ? 'inline' : 'fullscreen').catch(() => {}).then(applyMode);
    }
  });

  H.on('context', () => {
    const display = H.context().displayMode;
    // A display-mode change is a fresh start: the host (or the person) chose a size.
    if (display !== lastDisplay) override = null;
    lastDisplay = display;
    applyMode();
  });
  H.on('snapshot', (next) => {
    load(next as SnapshotLite);
    live = true;
    liveError = '';
    reconcileSent();
    if (stack.length === 1) stack = [rootScreen()];
    if (!app.hidden) render();
  });
  H.on('live-error', (msg) => {
    liveError = String(msg ?? '');
    if (!app.hidden) render();
  });
  window.addEventListener('resize', () => {
    if (override === null) applyMode();
  });

  const start = (): void => {
    load(w.KB_SNAPSHOT ?? snap);
    document.body.append(app, controls);
    applyMode();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

const NATIVE_STYLE = `
html.hx-native, html.hx-native body { margin: 0 !important; padding: 0 !important; min-height: 0 !important; height: auto !important;
  background: var(--hx-page-bg, #f2f2f7) !important; overflow-x: hidden !important; }
html.hx-native body > :not(#hx-native):not(#hexis-bridge-toast) { display: none !important; }
#hx-native[hidden], #hx-page-controls[hidden] { display: none !important; }
:root { --hx-page-bg: var(--color-background-secondary, #f2f2f7); }
html.hx-native[data-hx-theme="light"] { color-scheme: light; }
html.hx-native[data-hx-theme="dark"] { color-scheme: dark; }
html[data-hx-theme="dark"] { --hx-page-bg: var(--color-background-secondary, #000); }
@media (prefers-color-scheme: dark) { html:not([data-hx-theme="light"]) { --hx-page-bg: var(--color-background-secondary, #000); } }

#hx-native {
  --hx-bg: var(--hx-page-bg); --hx-surface: var(--color-background-primary, #fff); --hx-text: var(--color-text-primary, #1c1c1e);
  --hx-text-2: var(--color-text-secondary, #6c6c70); --hx-text-3: var(--color-text-tertiary, #aeaeb2);
  --hx-sep: var(--color-border-tertiary, rgba(60, 60, 67, 0.18)); --hx-fill: rgba(120, 120, 128, 0.12);
  --hx-accent: var(--color-text-info, #0a7aff); --hx-danger: var(--color-text-danger, #e5484d);
  --hx-success: var(--color-text-success, #30a46c); --hx-warning: var(--color-text-warning, #e0a100);
  --hx-on-accent: #fff;
  all: initial; color-scheme: inherit; display: block; font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
  font-size: 16px; line-height: 1.35; color: var(--hx-text); background: var(--hx-bg); letter-spacing: -0.01em;
  -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; padding-bottom: env(safe-area-inset-bottom);
}
html[data-hx-theme="dark"] #hx-native {
  --hx-surface: var(--color-background-primary, #1c1c1e); --hx-text: var(--color-text-primary, #fff);
  --hx-text-2: var(--color-text-secondary, #98989f); --hx-text-3: var(--color-text-tertiary, #636366);
  --hx-sep: var(--color-border-tertiary, rgba(84, 84, 88, 0.6)); --hx-fill: rgba(118, 118, 128, 0.24); --hx-accent: var(--color-text-info, #0a84ff);
}
@media (prefers-color-scheme: dark) { html:not([data-hx-theme="light"]) #hx-native {
  --hx-surface: var(--color-background-primary, #1c1c1e); --hx-text: var(--color-text-primary, #fff);
  --hx-text-2: var(--color-text-secondary, #98989f); --hx-text-3: var(--color-text-tertiary, #636366);
  --hx-sep: var(--color-border-tertiary, rgba(84, 84, 88, 0.6)); --hx-fill: rgba(118, 118, 128, 0.24); --hx-accent: var(--color-text-info, #0a84ff);
} }
#hx-native *, #hx-native *::before, #hx-native *::after { box-sizing: border-box; }
#hx-native button { font: inherit; color: inherit; background: none; border: 0; margin: 0; padding: 0; cursor: pointer; text-align: inherit;
  letter-spacing: inherit; -webkit-tap-highlight-color: transparent; }
#hx-native button:focus-visible { outline: 2px solid var(--hx-accent); outline-offset: -2px; border-radius: 8px; }
#hx-native h1, #hx-native h2, #hx-native p { margin: 0; }
#hx-native .hx-i { width: 22px; height: 22px; flex: none; }
#hx-native .hx-i-sm { width: 14px; height: 14px; }
#hx-native .hx-chev { width: 16px; height: 16px; color: var(--hx-text-3); }

#hx-native .hx-bar { position: sticky; top: 0; z-index: 5; height: 48px; display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
  gap: 8px; padding: 0 8px; background: color-mix(in srgb, var(--hx-bg) 84%, transparent); -webkit-backdrop-filter: saturate(180%) blur(20px);
  backdrop-filter: saturate(180%) blur(20px); border-bottom: 0.5px solid transparent; transition: border-color 0.2s; }
#hx-native .hx-bar.is-scrolled { border-bottom-color: var(--hx-sep); }
#hx-native .hx-bar-c { font-weight: 600; font-size: 16px; max-width: 52vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  opacity: 0; transition: opacity 0.2s; }
#hx-native .hx-bar.is-scrolled .hx-bar-c { opacity: 1; }
#hx-native .hx-bar-r { justify-self: end; }
#hx-native .hx-back { display: inline-flex; align-items: center; gap: 0; min-height: 44px; padding: 0 6px 0 0; color: var(--hx-accent);
  font-size: 16px; max-width: 40vw; }
#hx-native .hx-back span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#hx-native .hx-i-back { width: 24px; height: 24px; }
#hx-native .hx-icon-btn { width: 36px; height: 36px; border-radius: 18px; display: grid; place-items: center; color: var(--hx-accent); }
#hx-native .hx-icon-btn .hx-i { width: 18px; height: 18px; }
#hx-native .hx-icon-btn:active { background: var(--hx-fill); }

#hx-native .hx-screen { padding: 0 16px 8px; max-width: 760px; margin: 0 auto; }
#hx-native .hx-bar { padding-inline: max(8px, calc((100% - 744px) / 2)); }
#hx-native .hx-pending { max-width: 760px; margin: 0 auto; }
#hx-native .hx-push { animation: hx-in-r 0.24s cubic-bezier(0.2, 0.8, 0.2, 1); }
#hx-native .hx-pop { animation: hx-in-l 0.24s cubic-bezier(0.2, 0.8, 0.2, 1); }
@keyframes hx-in-r { from { transform: translateX(28px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes hx-in-l { from { transform: translateX(-28px); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { #hx-native .hx-push, #hx-native .hx-pop { animation: none; } }

#hx-native .hx-title { font-size: 30px; line-height: 1.12; font-weight: 700; letter-spacing: -0.025em; margin: 2px 4px 4px; overflow-wrap: anywhere; }
#hx-native .hx-title-item { font-size: 24px; }
#hx-native .hx-sub { font-size: 15px; color: var(--hx-text-2); margin: 0 4px 18px; }
#hx-native .hx-accent { color: var(--hx-accent); }
#hx-native .hx-section { display: flex; align-items: center; gap: 6px; width: 100%; font-size: 13px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.03em; color: var(--hx-text-2); margin: 0 4px 8px; padding: 0 12px; }
#hx-native .hx-section span { font-weight: 400; color: var(--hx-text-3); }
#hx-native .hx-section.is-danger { color: var(--hx-danger); }
#hx-native .hx-disclose { margin-bottom: 12px; min-height: 32px; }
#hx-native .hx-disclose .hx-i { transition: transform 0.2s; margin-left: auto; }
#hx-native .hx-disclose.is-open .hx-i { transform: rotate(180deg); }

#hx-native .hx-tabs { position: sticky; top: 48px; z-index: 4; display: flex; gap: 8px; overflow-x: auto; scrollbar-width: none;
  padding: 6px 16px 12px; margin: 0 -16px 4px; background: color-mix(in srgb, var(--hx-bg) 84%, transparent);
  -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); }
#hx-native .hx-tabs::-webkit-scrollbar { display: none; }
#hx-native .hx-tab { flex: none; display: inline-flex; align-items: center; gap: 7px; height: 36px; padding: 0 14px; border-radius: 18px;
  background: var(--hx-surface); font-size: 15px; font-weight: 500; box-shadow: 0 0 0 0.5px var(--hx-sep); }
#hx-native .hx-tab.is-on { background: var(--hx-text); color: var(--hx-bg); box-shadow: none; }
#hx-native .hx-tab-n { font-size: 13px; color: var(--hx-text-2); font-variant-numeric: tabular-nums; }
#hx-native .hx-tab.is-on .hx-tab-n { color: inherit; opacity: 0.65; }

#hx-native .hx-group { background: var(--hx-surface); border-radius: 14px; overflow: hidden; margin-bottom: 22px; }
#hx-native .hx-row { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 48px; padding: 11px 14px 11px 16px; }
#hx-native .hx-row + .hx-row::before { content: ""; position: absolute; top: 0; right: 0; left: 16px; height: 0.5px; background: var(--hx-sep); }
#hx-native .hx-card + .hx-card::before, #hx-native .hx-option + .hx-option::before { left: 38px; }
#hx-native .hx-task + .hx-task::before { left: 52px; }
#hx-native button.hx-row:active, #hx-native .hx-task-main:active { background: var(--hx-fill); }
#hx-native .hx-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
#hx-native .hx-row-title { font-size: 17px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#hx-native .hx-row-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; font-size: 14px; color: var(--hx-text-2); }
#hx-native .hx-row-note { font-size: 14px; color: var(--hx-text-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
#hx-native .hx-progress { display: block; height: 4px; margin-top: 7px; border-radius: 2px; background: var(--hx-fill); overflow: hidden; }
#hx-native .hx-progress > span { display: block; height: 100%; border-radius: 2px; background: var(--hx-success); }
#hx-native .hx-dot { width: 10px; height: 10px; border-radius: 5px; flex: none; background: var(--tone); }
#hx-native .tone-neutral { --tone: var(--hx-text-3); } #hx-native .tone-danger { --tone: var(--hx-danger); }
#hx-native .tone-success { --tone: var(--hx-success); } #hx-native .tone-warning { --tone: var(--hx-warning); }
#hx-native .hx-chip { flex: none; font-size: 12px; font-weight: 500; padding: 3px 8px; border-radius: 10px; background: var(--hx-fill); color: var(--hx-text-2); }
#hx-native .hx-chip.is-pending { background: color-mix(in srgb, var(--hx-accent) 14%, transparent); color: var(--hx-accent); }
#hx-native .hx-option .hx-i-check { color: var(--hx-accent); margin-left: auto; }
#hx-native .hx-action, #hx-native .hx-link { color: var(--hx-accent); font-size: 17px; }
#hx-native .hx-link { justify-content: space-between; }
#hx-native .hx-kv { justify-content: space-between; }
#hx-native .hx-k { flex: none; color: var(--hx-text); }
#hx-native .hx-v { color: var(--hx-text-2); text-align: right; overflow-wrap: anywhere; }
#hx-native .hx-kv.is-long { flex-direction: column; align-items: stretch; gap: 4px; }
#hx-native .hx-kv.is-long .hx-k { font-size: 13px; color: var(--hx-text-2); }
#hx-native .hx-kv.is-long .hx-v { color: var(--hx-text); text-align: left; white-space: pre-line; }
#hx-native .hx-empty { padding: 24px 16px; text-align: center; color: var(--hx-text-2); font-size: 15px; }
#hx-native .hx-foot { text-align: center; font-size: 12px; color: var(--hx-text-3); margin: 0 0 14px; }

#hx-native .hx-task { gap: 12px; padding: 0 14px 0 16px; }
#hx-native .hx-task-main { padding: 11px 0; border-radius: 0; }
#hx-native .hx-check { width: 24px; height: 24px; border-radius: 12px; flex: none; display: grid; place-items: center;
  border: 2px solid var(--prio); color: transparent; background: color-mix(in srgb, var(--prio) 10%, transparent); transition: background 0.15s; }
#hx-native .hx-check .hx-i { width: 14px; height: 14px; stroke-width: 3; }
#hx-native .hx-check[aria-checked="true"] { background: var(--prio); color: var(--hx-on-accent); }
#hx-native .prio-p1 { --prio: var(--hx-danger); } #hx-native .prio-p2 { --prio: var(--hx-warning); }
#hx-native .prio-p3 { --prio: var(--hx-accent); } #hx-native .hx-check:not(.prio-p1):not(.prio-p2):not(.prio-p3) { --prio: var(--hx-text-3); }
#hx-native .hx-task.is-done .hx-row-title { text-decoration: line-through; color: var(--hx-text-2); }
#hx-native .hx-when { display: inline-flex; align-items: center; gap: 4px; }
#hx-native .hx-when.is-danger { color: var(--hx-danger); }
#hx-native .hx-proj { color: var(--hx-text-2); }

#hx-native .hx-pending { position: sticky; bottom: 0; z-index: 6; padding: 8px 12px calc(12px + env(safe-area-inset-bottom)); }
#hx-native .hx-pending-in { display: flex; align-items: center; gap: 6px; padding: 7px 7px 7px 16px; border-radius: 16px;
  background: var(--hx-text); color: var(--hx-bg); box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22); animation: hx-in-up 0.24s cubic-bezier(0.2, 0.8, 0.2, 1); }
@keyframes hx-in-up { from { transform: translateY(16px); opacity: 0; } to { transform: none; opacity: 1; } }
#hx-native .hx-pending-n { font-weight: 600; font-size: 15px; }
#hx-native .hx-btn-plain { margin-left: auto; padding: 8px 10px; font-size: 15px; opacity: 0.75; }
#hx-native .hx-btn { padding: 9px 14px; border-radius: 11px; background: var(--hx-accent); color: var(--hx-on-accent); font-weight: 600; font-size: 15px; }
#hx-native .hx-btn[disabled] { opacity: 0.6; }

#hx-page-controls { position: fixed; right: 12px; bottom: 12px; z-index: 2147483646; display: flex; gap: 8px; }
#hx-page-controls button { padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(55, 53, 47, 0.19); background: #fff; color: #37352f;
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; cursor: pointer; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }
`;

/** The compact presentation, as one `<style>` and one `<script>`, for after the bridge. */
export function nativeMarkup(): string {
  return `<style data-hexis-native>${NATIVE_STYLE}</style>\n<script data-hexis-native>(${nativeApp.toString()})();</script>`;
}
