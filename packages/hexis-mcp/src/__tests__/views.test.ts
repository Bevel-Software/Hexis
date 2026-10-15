import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildSnapshot,
  isKnowledgeView,
  mirrorFiles,
  readEmbeddedSnapshot,
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
  VIEW_LINK_TOOL,
  VIEW_MIME_TYPE,
} from '../views/catalog.js';
import { FILES, ONT, VIEW, fakeKb, page, snapshotOnPage } from './fixtures/views-kb.js';


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

  it("reads a field's links the way the app does (platform-shared scanMarkdownLinks and resolveMdLink)", () => {
    const errand = `${ONT}/Knowledge/Tasks/Errand.md`;
    const files = {
      ...FILES,
      [errand]: [
        '---',
        'nodeType: "[Task](../../NodeTypes/Task.md)"',
        '---',
        '# Name',
        'Errand',
        '# Project',
        // A link with an anchor, one written with an escape, and one in code, which the app does not read as a link.
        'For [Groceries](../Projects/Groceries.md#goal) and [Big shop](../Projects/Big%20Shop.md), not `[Code](../Projects/Code.md)`.',
      ].join('\n'),
    };
    const built = buildSnapshot(files, { type: ['Task'], fields: 'Name,Project' }, 'main');
    expect(built.nodes[errand]!.links.outbound).toEqual([
      { text: 'Groceries', path: `${ONT}/Knowledge/Projects/Groceries.md` },
      { text: 'Big shop', path: `${ONT}/Knowledge/Projects/Big Shop.md` },
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

  it("reads a file's frontmatter by the platform's one rule (platform-shared extractFrontmatter)", async () => {
    const spaced = `${ONT}/Knowledge/Tasks/Spaced.md`;
    const unclosed = `${ONT}/Knowledge/Tasks/Unclosed.md`;
    const files: Record<string, string> = {
      ...FILES,
      // A fence is `---`, whitespace aside; line endings are the file's own.
      [spaced]: ['  ---  ', 'nodeType: "[Task](../../NodeTypes/Task.md)"', ' --- ', '# Name', 'Spaced', '# Status', 'open'].join('\r\n'),
      // A fence that never closes opens no frontmatter, so this is no node, whatever its first lines say.
      [unclosed]: ['---', 'nodeType: "[Task](../../NodeTypes/Task.md)"', '# Name', 'Unclosed'].join('\n'),
    };
    const over: KbReader = {
      list: async (path: string) => {
        const names = new Map<string, string>();
        for (const p of Object.keys(files)) {
          if (!p.startsWith(`${path}/`)) continue;
          const rest = p.slice(path.length + 1);
          names.set(rest.split('/')[0]!, rest.includes('/') ? 'directory' : 'file');
        }
        return [...names].map(([name, type]) => ({ name, type }));
      },
      read: async (path: string) => files[path]!,
    };
    const { files: mirrored } = await mirrorFiles(over, { dirs: [`${ONT}/Knowledge`], deep: true, types: ['Task'], fields: ['Status'] });
    expect(Object.keys(mirrored)).toContain(spaced);
    expect(Object.keys(mirrored)).not.toContain(unclosed);
    expect(buildSnapshot(mirrored, { type: ['Task'], fields: 'Name,Status' }, 'main').nodes[spaced]?.fields.Status?.text).toBe('open');
  });

  it('reports a file it could not read instead of failing the mirror', async () => {
    const { errors } = await mirrorFiles(reader, { paths: [`${ONT}/Knowledge/Missing.md`] });
    expect(errors).toEqual([`${ONT}/Knowledge/Missing.md: no ${ONT}/Knowledge/Missing.md`]);
  });
});

describe('the page and its bridge', () => {
  it('reads the snapshot a page carries', () => {
    const html = page({ format: 'hexis-kb-snapshot/1', selection: { type: ['Task'] } });
    expect(isKnowledgeView(html)).toBe(true);
    expect(readEmbeddedSnapshot(html)?.selection).toEqual({ type: ['Task'] });
    expect(isKnowledgeView('<html></html>')).toBe(false);
  });

  it('reads back a snapshot as build_snapshot.py writes it, with </ and <!-- escaped', () => {
    const snapshot = { format: 'hexis-kb-snapshot/1', nodes: { a: { fields: { Name: { text: 'see <!-- the note --> </script>' } } } } };
    // build_snapshot.py's `serialise`: no `</` and no `<!--` inside the <script>.
    const written = JSON.stringify(snapshot).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
    const html = `<!doctype html><html><body><script id="kb-snapshot">\nwindow.KB_SNAPSHOT = ${written};\n</script></body></html>`;
    expect(html).not.toContain('</script> ');
    expect(readEmbeddedSnapshot(html)).toEqual(snapshot);
  });

  it('injects the bridge as the first script, with its config safe inside <script>', () => {
    const html = injectBridge(page({}), {
      view: 'show_x',
      dataTool: VIEW_DATA_TOOL,
      linkTool: VIEW_LINK_TOOL,
      pagePath: 'KnowledgeBase/</script><script>alert(1)</script>.html',
      branch: 'main',
      kbDir: 'knowledge-base',
    });
    expect(html.indexOf('data-hexis-bridge')).toBeGreaterThan(html.indexOf('<head>'));
    expect(html.indexOf('data-hexis-bridge')).toBeLessThan(html.indexOf('id="kb-snapshot"'));
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain(`'${VIEW_META_KEY}'`);
  });
});

describe('the view catalog', () => {
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

  it('lists a tool per view that points at its ui:// page, plus the app-only data tool', async () => {
    const views = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)) });
    const tools = await views.listTools();
    expect(tools.map((t) => t.name)).toEqual(['show_to_do_list', VIEW_DATA_TOOL, VIEW_LINK_TOOL]);
    expect(tools[0]).toMatchObject({ _meta: { ui: { resourceUri: 'ui://hexis/views/to_do_list.html' } } });
    // The page's own title, once its page has been read behind the listing.
    await vi.waitFor(async () => expect((await views.listTools())[0]?.title).toBe('To-do list'));
    expect(tools[1]!._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(tools[2]!._meta).toEqual({ ui: { visibility: ['app'] } });
    expect(views.handles('show_to_do_list')).toBe(true);
    expect((await views.listResources()).resources[0]).toMatchObject({ uri: 'ui://hexis/views/to_do_list.html', mimeType: VIEW_MIME_TYPE });
  });

  it('serves the page with the bridge, as an MCP App', async () => {
    const views = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)) });
    await views.listTools();
    const { contents } = await views.readResource('ui://hexis/views/to_do_list.html');
    expect(contents[0]).toMatchObject({ mimeType: VIEW_MIME_TYPE, _meta: { ui: { prefersBorder: true } } });
    expect((contents[0] as { text: string }).text).toContain('data-hexis-bridge');
    expect((contents[0] as { text: string }).text).toContain('data-hexis-native');
  });

  it('serves the page with the data it was saved with: live data comes only with a tool result', async () => {
    const views = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)) });
    await views.listTools();
    await views.callTool('show_to_do_list', {}); // a live read, which is not kept
    const { contents } = await views.readResource('ui://hexis/views/to_do_list.html');
    const served = readEmbeddedSnapshot((contents[0] as { text: string }).text);
    expect(served?.nodes).toEqual({});
  });

  /**
   * A link followed in a view goes where the same link goes in the app: the
   * app's grammar (platform-shared resolveKbHref), against the page the link
   * sits in, and the app's scheme allowlist, since the host opens the answer.
   */
  it.each([
    ['../Tasks/Bread.md#due', {}, 'https://kb.example/workspace/main/knowledge-base/KnowledgeBase/Juan/Tasks/Bread.md#due'],
    ['#overview', {}, 'https://kb.example/workspace/main/knowledge-base/KnowledgeBase/Juan/Dashboards/To-Do-List.html#overview'],
    ['/knowledge-base/KnowledgeBase/Ops/A.md', {}, 'https://kb.example/workspace/main/knowledge-base/KnowledgeBase/Ops/A.md'],
    ['/workspace/dev/knowledge-base/KnowledgeBase/Ops/A.md', {}, 'https://kb.example/workspace/dev/knowledge-base/KnowledgeBase/Ops/A.md'],
    ['../Tasks/Bread.md', { branch: 'dev' }, 'https://kb.example/workspace/dev/knowledge-base/KnowledgeBase/Juan/Tasks/Bread.md'],
    ['  https://example.com/x  ', {}, 'https://example.com/x'],
    ['//cdn.example.com/x', {}, '//cdn.example.com/x'],
    // A file name with a `#` and a `%` in it, as the bridge sends one (each segment encoded).
    ['/knowledge-base/KnowledgeBase/Ops/Q%231%20100%25.md', {}, 'https://kb.example/workspace/main/knowledge-base/KnowledgeBase/Ops/Q%231%20100%25.md'],
  ])('opens %s where the app does', async (href, extra, url) => {
    const views = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)) });
    await views.listTools();
    const result = await views.callTool(VIEW_LINK_TOOL, { view: 'show_to_do_list', href, ...extra });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ url });
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', ''])('refuses to open %j', async (href) => {
    const views = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)) });
    await views.listTools();
    const result = await views.callTool(VIEW_LINK_TOOL, { view: 'show_to_do_list', href });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(`This link cannot be opened: ${href}`);
    expect(result.structuredContent).toBeUndefined();
  });

  it('reads the view live: a summary for the model, the snapshot for the page', async () => {
    const kb = fakeKb(page(snapshotOnPage));
    const views = createViewCatalog(CONFIG, { callKb: kb });
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
    const views = createViewCatalog(CONFIG, { callKb: kb, onChange });
    // Listed at once under their file names, then titled from their pages, which is announced.
    expect((await views.listTools()).map((t) => [t.name, t.title])).toEqual([
      ['show_to_do_list', 'To Do List'],
      ['show_board', 'Board'],
      [VIEW_DATA_TOOL, 'Knowledge view data'],
      [VIEW_LINK_TOOL, 'Knowledge view link'],
    ]);
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(kb.mock.calls.filter(([tool]) => tool === 'grep')).toHaveLength(1);
    // In path order: KnowledgeBase/Juan/... before KnowledgeBase/Ops/...
    expect((await views.listTools()).map((t) => [t.name, t.title])).toEqual([
      ['show_to_do_list', 'To-do list'],
      ['show_board', 'Ops board'],
      [VIEW_DATA_TOOL, 'Knowledge view data'],
      [VIEW_LINK_TOOL, 'Knowledge view link'],
    ]);
  });

  it('finds a view in a knowledge base with more pages than the search returns', async () => {
    const files: Record<string, string> = {};
    // Ordinary pages first, as a walk may meet them: each has a title and no snapshot.
    for (let i = 0; i < 1200; i++) files[`Data/PR-Overviews/PR-${i}.html`] = `<html><head><title>PR ${i}</title></head></html>`;
    files[VIEW] = page(snapshotOnPage);
    const tools = await createViewCatalog(CONFIG, { callKb: searchableKb(files) }).listTools();
    expect(tools.map((t) => t.name)).toEqual(['show_to_do_list', VIEW_DATA_TOOL, VIEW_LINK_TOOL]);
  });

  it('lists the views without waiting for their pages', async () => {
    const kb = searchableKb({ [VIEW]: page(snapshotOnPage) });
    const search = kb.getMockImplementation()!;
    // A page read that never answers, as a slow deployment's would not within a listing.
    kb.mockImplementation(async (tool, args) => (tool === 'read_file' ? new Promise(() => {}) : search(tool, args)));
    const tools = await createViewCatalog(CONFIG, { callKb: kb }).listTools();
    expect(tools.map((t) => [t.name, t.title])).toEqual([
      ['show_to_do_list', 'To Do List'],
      [VIEW_DATA_TOOL, 'Knowledge view data'],
      [VIEW_LINK_TOOL, 'Knowledge view link'],
    ]);
  });

  it('keeps the views a capped search did not reach', async () => {
    const other = 'KnowledgeBase/Ops/Board.html';
    const kb = searchableKb({ [VIEW]: page(snapshotOnPage), [other]: page(snapshotOnPage) });
    const views = createViewCatalog(CONFIG, { callKb: kb });
    expect((await views.listTools()).map((t) => t.name)).toEqual(['show_to_do_list', 'show_board', VIEW_DATA_TOOL, VIEW_LINK_TOOL]);
    // The next search stops after one view.
    const full = kb.getMockImplementation()!;
    kb.mockImplementation(async (tool, args) =>
      tool === 'grep' ? full(tool, { ...args, max_results: 1 }) : full(tool, args),
    );
    // An unknown view makes the catalog search again before it answers.
    await expect(views.readResource('ui://hexis/views/nope.html')).rejects.toThrow(/Unknown resource/);
    expect(kb.mock.calls.filter(([tool]) => tool === 'grep')).toHaveLength(2);
    expect((await views.listTools()).map((t) => t.name)).toEqual(['show_to_do_list', 'show_board', VIEW_DATA_TOOL, VIEW_LINK_TOOL]);
  });

  describe('what it keeps, and for whom', () => {
    it('keeps nothing on disk', async () => {
      const home = mkdtempSync(path.join(tmpdir(), 'hexis-home-'));
      const previous = process.env.HEXIS_HOME;
      process.env.HEXIS_HOME = home;
      try {
        const views = createViewCatalog(CONFIG, { callKb: fakeKb(page(snapshotOnPage)) });
        await views.listTools();
        await views.callTool('show_to_do_list', {});
        await views.readResource('ui://hexis/views/to_do_list.html');
        await new Promise((resolve) => setTimeout(resolve, 400)); // past any write that would follow
        expect(readdirSync(home)).toEqual([]);
      } finally {
        if (previous === undefined) delete process.env.HEXIS_HOME;
        else process.env.HEXIS_HOME = previous;
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('shows nothing a reader can no longer read, though it showed it a moment ago', async () => {
      const kb = fakeKb(page(snapshotOnPage));
      const views = createViewCatalog(CONFIG, { callKb: kb });
      await views.listTools();
      await views.readResource('ui://hexis/views/to_do_list.html');
      // The reader loses access to the page.
      const allowed = kb.getMockImplementation()!;
      kb.mockImplementation(async (tool, args) => {
        if (tool === 'read_file' && String(args.path).endsWith(VIEW)) throw new Error('not readable for this reader');
        return allowed(tool, args);
      });
      await expect(views.readResource('ui://hexis/views/to_do_list.html')).rejects.toThrow(/not readable/);
    });

    /** A knowledge base that shows this reader nothing, as one with no access to the view would. */
    const refusing = () =>
      vi.fn(async (tool: string): Promise<unknown> => {
        if (tool === 'start_session') return { sessionId: 's-2' };
        if (tool === 'grep') return { matches: [], truncated: false };
        throw new Error('not readable for this reader');
      });

    it('lets go of what it kept when the credential changes mid-run', async () => {
      const config = { ...CONFIG, connectionKey: 'key-a' };
      const kb = fakeKb(page(snapshotOnPage));
      const views = createViewCatalog(config, { callKb: kb });
      expect((await views.listTools()).map((t) => t.name)).toEqual(['show_to_do_list', VIEW_DATA_TOOL, VIEW_LINK_TOOL]);
      await views.callTool('show_to_do_list', {});
      config.connectionKey = 'key-b';
      kb.mockImplementation(refusing());
      expect(await views.listTools()).toEqual([]);
      expect(views.handles('show_to_do_list')).toBe(false);
      await expect(views.readResource('ui://hexis/views/to_do_list.html')).rejects.toThrow(/Unknown resource/);
      // A session of its own for the new reader: one per reader, not the last one's reused.
      expect(kb.mock.calls.filter(([tool]) => tool === 'start_session')).toHaveLength(2);
    });

    /** A KB whose `tool` calls wait until released: a read caught in flight. */
    const held = (tool: string) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const base = fakeKb(page(snapshotOnPage));
      const kb = vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
        if (name === tool) await gate;
        return base(name, args);
      });
      return { kb, release };
    };

    it('does not answer a view call with what it read for a reader who changed meanwhile', async () => {
      const config = { ...CONFIG, connectionKey: 'key-a' };
      const { kb, release } = held('list_files'); // the live read's walk
      const views = createViewCatalog(config, { callKb: kb });
      await views.listTools();
      const answer = views.callTool('show_to_do_list', {});
      await vi.waitFor(() => expect(kb.mock.calls.some(([tool]) => tool === 'list_files')).toBe(true));
      config.connectionKey = 'key-b';
      release();
      const result = await answer;
      expect(result.isError).toBe(true);
      expect(result._meta).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('Bread');
    });

    it('does not serve a page it read for a reader who changed meanwhile', async () => {
      const config = { ...CONFIG, connectionKey: 'key-a' };
      const { kb, release } = held('read_file'); // the page itself
      const views = createViewCatalog(config, { callKb: kb });
      await views.listTools();
      const answer = views.readResource('ui://hexis/views/to_do_list.html');
      config.connectionKey = 'key-b';
      release();
      await expect(answer).rejects.toThrow(/sign-in changed/);
    });

    it('announces a change the background refresh found', async () => {
      const kb = fakeKb(page(snapshotOnPage));
      const onChange = vi.fn();
      const views = createViewCatalog(CONFIG, { callKb: kb, onChange });
      await views.listTools();
      // The first list is not a change; its page then naming the view is.
      await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
      onChange.mockClear();
      kb.mockImplementation(async (tool: string) =>
        tool === 'start_session' ? { sessionId: 's-1' } : { matches: [] },
      );
      // Six minutes on, the list is old: a listing answers with it and refreshes behind it.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 6 * 60_000);
      try {
        expect((await views.listTools()).map((t) => t.name)).toContain('show_to_do_list');
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
