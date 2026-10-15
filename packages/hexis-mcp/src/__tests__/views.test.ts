import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  isKnowledgeView,
  mirrorFiles,
  readEmbeddedSnapshot,
  replaceEmbeddedSnapshot,
  type KbReader,
  type Selection,
} from '../views/snapshot.js';
import { injectBridge, VIEW_META_KEY } from '../views/bridge.js';
import {
  createViewCatalog,
  summarize,
  viewPathsFromGrep,
  viewToolName,
  VIEW_DATA_TOOL,
  VIEW_MIME_TYPE,
} from '../views/catalog.js';

const ONT = 'KnowledgeBase/Ops';
const hashOf = (url: string): string => createHash('sha256').update(url).digest('hex').slice(0, 8);
const TASK_TYPE = [
  '---',
  'nodeType: "[NodeType](../NodeType.md)"',
  '---',
  '# Name',
  '# Status',
  '# Project (link outbound)',
  '# Blocked By (link inbound)',
].join('\n');
const PROJECT_TYPE = ['---', 'nodeType: "[NodeType](../NodeType.md)"', '---', '# Name', '# Goal'].join('\n');

const task = (name: string, extra: string[] = []): string =>
  [
    '---',
    'nodeType: "[Task](../../NodeTypes/Task.md)"',
    `id: task-${name.toLowerCase()}`,
    'owner: "Juan <juan@bevel.software>"',
    '---',
    '# Name',
    name,
    '# Status',
    'open',
    ...extra,
  ].join('\n');

const FILES: Record<string, string> = {
  [`${ONT}/NodeTypes/Task.md`]: TASK_TYPE,
  [`${ONT}/NodeTypes/Project.md`]: PROJECT_TYPE,
  [`${ONT}/Knowledge/Tasks/Bread.md`]: task('Bread', [
    '# Project',
    'For [Groceries](../Projects/Groceries.md).',
    '<details>',
    '<summary>Source of Information</summary>',
    '',
    '1. Binding Slack thread — the status (2026-09-29)',
    '</details>',
    '# Blocked By',
    'Waiting on [Dentist](task-dentist).',
    '# Notes',
    'Not a selected field.',
  ]),
  [`${ONT}/Knowledge/Tasks/Dentist.md`]: task('Dentist'),
  [`${ONT}/Knowledge/Projects/Groceries.md`]: [
    '---',
    'nodeType: "[Project](../../NodeTypes/Project.md)"',
    '---',
    '# Name',
    'Groceries',
    '# Goal',
    'Food',
  ].join('\n'),
};

describe('buildSnapshot (port of build_snapshot.py)', () => {
  const selection: Selection = { type: ['Task'], fields: 'Name,Status,Project,Blocked By', keep_soi: true };
  const snap = buildSnapshot(FILES, selection, 'main', '2026-10-07');

  it('keeps the selected nodes with the selected fields, in the wire shape', () => {
    expect(Object.keys(snap.nodes)).toEqual([`${ONT}/Knowledge/Tasks/Bread.md`, `${ONT}/Knowledge/Tasks/Dentist.md`]);
    const bread = snap.nodes[`${ONT}/Knowledge/Tasks/Bread.md`]!;
    expect(bread).toMatchObject({ node_type: 'Task', id: 'task-bread', owner: 'Juan <juan@bevel.software>' });
    expect(Object.keys(bread.fields)).toEqual(['Name', 'Status', 'Project', 'Blocked By']);
    expect(bread.fields.Name).toEqual({ text: 'Bread' });
  });

  it('resolves path links and id links, and files them under the NodeType categories', () => {
    const bread = snap.nodes[`${ONT}/Knowledge/Tasks/Bread.md`]!;
    expect(bread.links).toEqual({
      outbound: [{ text: 'Groceries', path: `${ONT}/Knowledge/Projects/Groceries.md` }],
      inbound: [{ text: 'Dentist', path: `${ONT}/Knowledge/Tasks/Dentist.md` }],
    });
    // Only edges between kept nodes, inbound ones pointing at the linking node.
    expect(snap.edges).toEqual([
      { source: `${ONT}/Knowledge/Tasks/Dentist.md`, target: `${ONT}/Knowledge/Tasks/Bread.md`, label: 'Dentist', category: 'inbound' },
    ]);
  });

  it('lifts a Source of Information block out of the field text', () => {
    const project = snap.nodes[`${ONT}/Knowledge/Tasks/Bread.md`]!.fields.Project!;
    expect(project.text).toBe('For [Groceries](../Projects/Groceries.md).');
    expect(project.sourceOfInformation).toEqual([
      { source: 'Binding Slack thread', validates: 'the status', date: '2026-09-29', tier: 'binding-data' },
    ]);
  });

  it('records the selection and the format', () => {
    expect(snap).toMatchObject({ format: 'hexis-kb-snapshot/1', takenAt: '2026-10-07', branch: 'main', selection, withheld: 0 });
  });
});

describe('mirrorFiles (port of mirror.chain.js)', () => {
  const reader: KbReader = {
    list: vi.fn(async (path: string) => {
      const prefix = `${path}/`;
      const names = new Map<string, string>();
      for (const p of Object.keys(FILES)) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        names.set(rest.split('/')[0]!, rest.includes('/') ? 'directory' : 'file');
      }
      return [...names].map(([name, type]) => ({ name, type }));
    }),
    read: vi.fn(async (path: string) => {
      if (!(path in FILES)) throw new Error(`no ${path}`);
      return FILES[path]!;
    }),
  };

  it('walks the folders, keeps nodes of the wanted types cut to the wanted fields, and brings their NodeTypes', async () => {
    const { files, errors } = await mirrorFiles(reader, {
      dirs: [`${ONT}/Knowledge`],
      deep: true,
      types: ['Task'],
      fields: ['Status'],
    });
    expect(errors).toEqual([]);
    expect(Object.keys(files).sort()).toEqual([
      `${ONT}/Knowledge/Tasks/Bread.md`,
      `${ONT}/Knowledge/Tasks/Dentist.md`,
      `${ONT}/NodeTypes/Task.md`,
    ]);
    expect(files[`${ONT}/Knowledge/Tasks/Bread.md`]).not.toContain('# Notes');
    expect(files[`${ONT}/Knowledge/Tasks/Bread.md`]).toContain('# Name');
  });

  it('reports a file it could not read instead of failing the mirror', async () => {
    const { errors } = await mirrorFiles(reader, { paths: [`${ONT}/Knowledge/Missing.md`] });
    expect(errors).toEqual([`${ONT}/Knowledge/Missing.md: no ${ONT}/Knowledge/Missing.md`]);
  });
});

const page = (snapshot: object): string =>
  `<!doctype html>\n<html><head><title>To-do list</title></head><body>` +
  `<script id="kb-snapshot">\nwindow.KB_SNAPSHOT = ${JSON.stringify(snapshot)};\n</script></body></html>`;

describe('the page and its bridge', () => {
  it('reads the snapshot a page carries', () => {
    const html = page({ format: 'hexis-kb-snapshot/1', selection: { type: ['Task'] } });
    expect(isKnowledgeView(html)).toBe(true);
    expect(readEmbeddedSnapshot(html)?.selection).toEqual({ type: ['Task'] });
    expect(isKnowledgeView('<html></html>')).toBe(false);
  });

  it('reads back a snapshot whose data holds <!--, which the page carries escaped', () => {
    const next = buildSnapshot(FILES, { type: ['Task'], fields: 'Name' }, 'main', '2026-10-07');
    next.nodes[`${ONT}/Knowledge/Tasks/Bread.md`]!.fields.Name = { text: 'see <!-- the note -->' };
    const html = replaceEmbeddedSnapshot(page({ format: 'hexis-kb-snapshot/1' }), next);
    expect(html).toContain('<\\!--');
    expect(readEmbeddedSnapshot(html)?.nodes?.[`${ONT}/Knowledge/Tasks/Bread.md`]?.fields.Name).toEqual({
      text: 'see <!-- the note -->',
    });
  });

  it('swaps the snapshot a page carries, safely inside <script>', () => {
    const next = buildSnapshot(FILES, { type: ['Task'], fields: 'Name' }, 'main', '2026-10-07');
    next.nodes[`${ONT}/Knowledge/Tasks/Bread.md`]!.fields.Name = { text: '</script><b>x</b>' };
    const html = replaceEmbeddedSnapshot(page({ format: 'hexis-kb-snapshot/1' }), next);
    expect(html).not.toContain('</script><b>');
    expect(readEmbeddedSnapshot(html)?.nodes?.[`${ONT}/Knowledge/Tasks/Bread.md`]?.fields.Name?.text).toBe('</script><b>x</b>');
  });

  it('injects the bridge as the first script, with its config safe inside <script>', () => {
    const html = injectBridge(page({}), {
      view: 'show_x',
      dataTool: VIEW_DATA_TOOL,
      pagePath: 'KnowledgeBase/</script><script>alert(1)</script>.html',
      branch: 'main',
      webBase: 'https://kb.example',
      kbDir: 'knowledge-base',
    });
    expect(html.indexOf('data-hexis-bridge')).toBeGreaterThan(html.indexOf('<head>'));
    expect(html.indexOf('data-hexis-bridge')).toBeLessThan(html.indexOf('id="kb-snapshot"'));
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain(`'${VIEW_META_KEY}'`);
  });
});

describe('the view catalog', () => {
  const VIEW = 'KnowledgeBase/Juan/Dashboards/To-Do-List.html';
  const CONFIG = { baseUrl: 'https://kb.example', connectionKey: 'k' };

  it('finds views in a grep, learns the repository folder, and skips skill templates', () => {
    expect(
      viewPathsFromGrep({
        matches: [
          { path: `knowledge-base/${VIEW}`, line: 9, text: '<script id="kb-snapshot">' },
          { path: `knowledge-base/${VIEW}`, line: 4, text: '<title>To-do list</title>' },
          { path: 'knowledge-base/Plugins/Everyone/skills/html-knowledge-view/assets/template.html', text: '<script id="kb-snapshot">' },
          { path: 'knowledge-base/Data/PR-1.html', text: '<title>PR 1</title>' },
        ],
      }),
    ).toEqual({ kbDir: 'knowledge-base', paths: [VIEW] });
  });

  it('names a view after its file, uniquely', () => {
    const taken = new Set<string>();
    expect(viewToolName('A/To-Do-List.html', taken)).toBe('show_to_do_list');
    expect(viewToolName('B/To-Do-List.html', taken)).toBe('show_to_do_list_2');
  });

  const snapshotOnPage = {
    format: 'hexis-kb-snapshot/1',
    takenAt: '2026-10-01',
    nodes: {},
    selection: {
      type: ['Task'],
      fields: 'Name,Status',
      mirror: { branch: 'main', dirs: [`${ONT}/Knowledge`], deep: true, types: ['Task'], fields: ['Name', 'Status'] },
    },
  };
  const fakeKb = (pageHtml: string) =>
    vi.fn(async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
      const path = String(args.path ?? '').replace(/^knowledge-base\//, '');
      switch (tool) {
        case 'start_session':
          return { sessionId: 's-1' };
        case 'grep':
          return {
            matches: [
              { path: `knowledge-base/${VIEW}`, text: '<title>To-do list</title>' },
              { path: `knowledge-base/${VIEW}`, text: '<script id="kb-snapshot">' },
            ],
          };
        case 'read_file':
          if (path === VIEW) return { path, content: pageHtml };
          if (path in FILES) return { path, content: FILES[path] };
          throw new Error(`no ${path}`);
        case 'list_files': {
          const prefix = `${path}/`;
          const names = new Map<string, string>();
          for (const p of Object.keys(FILES)) {
            if (!p.startsWith(prefix)) continue;
            const rest = p.slice(prefix.length);
            names.set(rest.split('/')[0]!, rest.includes('/') ? 'directory' : 'file');
          }
          return { entries: [...names].map(([name, type]) => ({ name, type })) };
        }
        default:
          throw new Error(`unexpected ${tool}`);
      }
    });

  it('lists a tool per view that points at its ui:// page, plus the app-only data tool', async () => {
    const views = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)), cacheDir: null });
    const tools = await views.listTools();
    expect(tools.map((t) => t.name)).toEqual(['show_to_do_list', VIEW_DATA_TOOL]);
    expect(tools[0]).toMatchObject({ _meta: { ui: { resourceUri: 'ui://hexis/views/to_do_list.html' } } });
    // The page's own title, once its page has been read behind the listing.
    await vi.waitFor(async () => expect((await views.listTools())[0]?.title).toBe('To-do list'));
    expect(tools[1]!._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(views.handles('show_to_do_list')).toBe(true);
    expect((await views.listResources()).resources[0]).toMatchObject({ uri: 'ui://hexis/views/to_do_list.html', mimeType: VIEW_MIME_TYPE });
  });

  it('serves the page with the bridge, as an MCP App', async () => {
    const views = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)), cacheDir: null });
    await views.listTools();
    const { contents } = await views.readResource('ui://hexis/views/to_do_list.html');
    expect(contents[0]).toMatchObject({ mimeType: VIEW_MIME_TYPE, _meta: { ui: { prefersBorder: true } } });
    expect((contents[0] as { text: string }).text).toContain('data-hexis-bridge');
    expect((contents[0] as { text: string }).text).toContain('data-hexis-native');
  });

  it('paints first with the last live read, not the snapshot the page was committed with', async () => {
    const views = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)), cacheDir: null });
    await views.listTools();
    await views.callTool('show_to_do_list', {});
    const { contents } = await views.readResource('ui://hexis/views/to_do_list.html');
    const served = readEmbeddedSnapshot((contents[0] as { text: string }).text);
    expect(Object.keys(served?.nodes ?? {})).toHaveLength(2);
  });

  it('reads the view live: a summary for the model, the snapshot for the page', async () => {
    const kb = fakeKb(page(snapshotOnPage));
    const views = createViewCatalog(CONFIG, { callKb: kb, cacheDir: null });
    await views.listTools();
    const result = await views.callTool('show_to_do_list', {});
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('live from branch main: 2 item(s)');
    expect(text).toContain(`- [Task] Bread · Status open (${ONT}/Knowledge/Tasks/Bread.md)`);
    const meta = result._meta?.[VIEW_META_KEY] as { snapshot: { nodes: object } };
    expect(Object.keys(meta.snapshot.nodes)).toHaveLength(2);
    // Every read carries the one session the catalog minted.
    expect(kb.mock.calls.filter(([tool]) => tool === 'start_session')).toHaveLength(1);
    expect(kb.mock.calls.filter(([tool]) => tool !== 'start_session').every(([, args]) => args.sessionId === 's-1')).toBe(true);
  });

  it('falls back to the embedded snapshot when the page records no mirror', async () => {
    const views = createViewCatalog(CONFIG, {
      callKb: fakeKb(page({ ...snapshotOnPage, selection: { type: ['Task'] } })),
      cacheDir: null,
    });
    await views.listTools();
    const result = await views.callTool('show_to_do_list', {});
    expect((result.content[0] as { text: string }).text).toContain('from its embedded snapshot; live data did not load');
    expect(result._meta?.[VIEW_META_KEY]).toMatchObject({ liveError: expect.stringContaining('no mirror configuration') });
  });

  /**
   * A knowledge base as the grep tool searches it: the pattern runs over every
   * line of every file, case-sensitively unless `ignore_case` says otherwise,
   * and stops at `max_results` with `truncated` set.
   */
  const searchableKb = (files: Record<string, string>) =>
    vi.fn(async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
      const rel = String(args.path ?? '').replace(/^knowledge-base\//, '');
      if (tool === 'start_session') return { sessionId: 's-1' };
      if (tool === 'read_file') {
        if (rel in files) return { path: rel, content: files[rel] };
        throw new Error(`no ${rel}`);
      }
      if (tool !== 'grep') throw new Error(`unexpected ${tool}`);
      const re = new RegExp(String(args.pattern), args.ignore_case ? 'i' : '');
      const max = Number(args.max_results ?? 200);
      const matches: { path: string; line: number; text: string }[] = [];
      for (const [p, text] of Object.entries(files)) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i]!)) continue;
          if (matches.length === max) return { matches, truncated: true };
          matches.push({ path: `knowledge-base/${p}`, line: i + 1, text: lines[i]! });
        }
      }
      return { matches, truncated: false };
    });

  it('finds the views in ONE search, whatever case their markup is in, and titles them from their pages', async () => {
    const files: Record<string, string> = {
      [VIEW]: page(snapshotOnPage),
      // Upper-case markup, with the snapshot block on a line of its own.
      'KnowledgeBase/Ops/Board.html':
        '<!DOCTYPE html>\n<HTML><HEAD><TITLE>Ops board</TITLE></HEAD>\n<BODY>\n' +
        `<SCRIPT ID="kb-snapshot">\nwindow.KB_SNAPSHOT = ${JSON.stringify(snapshotOnPage)};\n</SCRIPT>\n</BODY></HTML>`,
    };
    const kb = searchableKb(files);
    const onChange = vi.fn();
    const views = createViewCatalog(CONFIG, { callKb: kb, cacheDir: null, onChange });
    // Listed at once under their file names, then titled from their pages, which is announced.
    expect((await views.listTools()).map((t) => [t.name, t.title])).toEqual([
      ['show_to_do_list', 'To Do List'],
      ['show_board', 'Board'],
      [VIEW_DATA_TOOL, 'Knowledge view data'],
    ]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(kb.mock.calls.filter(([tool]) => tool === 'grep')).toHaveLength(1);
    // In path order: KnowledgeBase/Juan/... before KnowledgeBase/Ops/...
    expect((await views.listTools()).map((t) => [t.name, t.title])).toEqual([
      ['show_to_do_list', 'To-do list'],
      ['show_board', 'Ops board'],
      [VIEW_DATA_TOOL, 'Knowledge view data'],
    ]);
  });

  it('finds a view in a knowledge base with more pages than the search returns', async () => {
    const files: Record<string, string> = {};
    // Ordinary pages first, as a walk may meet them: each has a title and no snapshot.
    for (let i = 0; i < 1200; i++) files[`Data/PR-Overviews/PR-${i}.html`] = `<html><head><title>PR ${i}</title></head></html>`;
    files[VIEW] = page(snapshotOnPage);
    const tools = await createViewCatalog(CONFIG, { callKb: searchableKb(files), cacheDir: null }).listTools();
    expect(tools.map((t) => t.name)).toEqual(['show_to_do_list', VIEW_DATA_TOOL]);
  });

  it('lists the views without waiting for their pages', async () => {
    const kb = searchableKb({ [VIEW]: page(snapshotOnPage) });
    const search = kb.getMockImplementation()!;
    // A page read that never answers, as a slow deployment's would not within a listing.
    kb.mockImplementation(async (tool, args) => (tool === 'read_file' ? new Promise(() => {}) : search(tool, args)));
    const tools = await createViewCatalog(CONFIG, { callKb: kb, cacheDir: null }).listTools();
    expect(tools.map((t) => [t.name, t.title])).toEqual([
      ['show_to_do_list', 'To Do List'],
      [VIEW_DATA_TOOL, 'Knowledge view data'],
    ]);
  });

  it('keeps the views a capped search did not reach', async () => {
    const other = 'KnowledgeBase/Ops/Board.html';
    const kb = searchableKb({ [VIEW]: page(snapshotOnPage), [other]: page(snapshotOnPage) });
    const views = createViewCatalog(CONFIG, { callKb: kb, cacheDir: null });
    expect((await views.listTools()).map((t) => t.name)).toEqual(['show_to_do_list', 'show_board', VIEW_DATA_TOOL]);
    // The next search stops after one view.
    const full = kb.getMockImplementation()!;
    kb.mockImplementation(async (tool, args) =>
      tool === 'grep' ? full(tool, { ...args, max_results: 1 }) : full(tool, args),
    );
    // An unknown view makes the catalog search again before it answers.
    await expect(views.readResource('ui://hexis/views/nope.html')).rejects.toThrow(/Unknown resource/);
    expect(kb.mock.calls.filter(([tool]) => tool === 'grep')).toHaveLength(2);
    expect((await views.listTools()).map((t) => t.name)).toEqual(['show_to_do_list', 'show_board', VIEW_DATA_TOOL]);
  });

  describe('kept between runs', () => {
    let dir = '';
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('answers a restart from disk without searching, and refreshes behind it', async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'hexis-views-'));
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        const first = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)), cacheDir: dir });
        await first.listTools();
        await first.callTool('show_to_do_list', {});
        await vi.runAllTimersAsync(); // the coalesced save
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(readFileSync(path.join(dir, `${'kb.example'}-${hashOf(CONFIG.baseUrl)}.json`), 'utf8')).toContain('show_to_do_list'));
      const file = path.join(dir, `kb.example-${hashOf(CONFIG.baseUrl)}.json`);
      expect(statSync(file).mode & 0o777).toBe(0o600);

      const never = vi.fn(async () => new Promise<unknown>(() => {}));
      const second = createViewCatalog(CONFIG, { callKb: never, cacheDir: dir });
      const tools = await second.listTools(); // the search below never answers
      expect(tools.map((t) => t.name)).toEqual(['show_to_do_list', VIEW_DATA_TOOL]);
      const { contents } = await second.readResource('ui://hexis/views/to_do_list.html');
      expect(Object.keys(readEmbeddedSnapshot((contents[0] as { text: string }).text)?.nodes ?? {})).toHaveLength(2);
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        second.prefetch();
        expect(never).not.toHaveBeenCalled(); // a kept list's refresh steps aside at start
        await vi.advanceTimersByTimeAsync(20_000);
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(never.mock.calls.length).toBeGreaterThan(0));
    });

    it('announces a change the background refresh found', async () => {
      dir = mkdtempSync(path.join(tmpdir(), 'hexis-views-'));
      const kb = fakeKb(page(snapshotOnPage));
      const onChange = vi.fn();
      const views = createViewCatalog(CONFIG, { callKb: kb, cacheDir: null, onChange });
      await views.listTools();
      // The first list is not a change; its page then naming the view is.
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      onChange.mockClear();
      kb.mockImplementation(async (tool: string) =>
        tool === 'start_session' ? { sessionId: 's-1' } : { matches: [] },
      );
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        views.prefetch();
        await vi.advanceTimersByTimeAsync(20_000);
      } finally {
        vi.useRealTimers();
      }
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      expect(await views.listTools()).toEqual([]);
    });
  });

  it('summarizes one line per node and says how many it left out', () => {
    const snap = buildSnapshot(FILES, { type: ['Task'], fields: 'Name,Status' }, 'main');
    expect(summarize(snap, 1).split('\n')).toEqual([
      `- [Task] Bread · Status open (${ONT}/Knowledge/Tasks/Bread.md)`,
      '- …and 1 more',
    ]);
  });
});
