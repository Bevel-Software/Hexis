import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxedHtml, sanitizeAgentHtml } from '../htmlSandbox';

/**
 * The `### Live data` subsection of the agent guide's `## HTML views` tells
 * page authors how a data-driven page loads: final shell first, one consistent
 * dataset at a time, refresh over the current board, a failed read with a
 * retry, reads in bounded parallel, links by root-relative path. Its reference
 * page is the one example an agent copies, so this suite runs THAT page —
 * taken out of the guide, not a copy of it — and holds it to every one of
 * those rules.
 *
 * The page goes through the renderer's own pipeline: the sanitizer, the
 * sandbox document and its tool-bridge runtime. The test plays the app on the
 * other side of the bridge, answering each `bevel.tool.call` the page posts
 * when the test decides — which is how a slow, partial or failed load is
 * produced without touching the page. The section is core-backend's file and
 * is read here as TEXT, in a test only, like `htmlViewsGuide.test.ts` does.
 */
const HTML_VIEWS_MD = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../../core-backend/agent-guide/html-views.md',
);

/** The checkout folder the guide is rendered for here: any name will do. */
const KB_DIR_NAME = 'knowledge-base';

function referencePage(): string {
  // Read as LF whatever the checkout's line endings.
  const section = readFileSync(HTML_VIEWS_MD, 'utf8').replace(/\r\n/g, '\n');
  const live = /\n### Live data[^\n]*\n([\s\S]*?)(?=\n### |$)/.exec(section);
  if (!live) throw new Error('the `## HTML views` section has no `### Live data` subsection');
  const page = /```html\n([\s\S]*?)\n```/.exec(live[1]!);
  if (!page) throw new Error('the `### Live data` subsection has no reference page');
  // Rendered as the guide renders it for a deployment.
  return page[1]!.replaceAll('{{kbDirName}}', KB_DIR_NAME);
}

const FOLDER = 'Data/Tickets';

interface ToolCall {
  requestId: string;
  fn: string;
  args: [string, { body: { branch: string; path: string } }];
}

/**
 * The reference page, mounted the way the renderer mounts it on the app's
 * file page, with the test as the app behind `window.bevel.tools`.
 */
async function mountReferencePage(branch = 'main') {
  const srcdoc = buildSandboxedHtml({
    title: 'Tickets',
    libModuleSources: [],
    bodyHtml: sanitizeAgentHtml(referencePage()),
    toolBridge: true,
    branch,
  });
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(srcdoc)![1]!;

  const calls: ToolCall[] = [];
  const answered = new Set<string>();
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const parent = {
    postMessage(msg: { type: string }) {
      if (msg.type === 'bevel.tool.call') calls.push(msg as unknown as ToolCall);
    },
  };
  const frameGlobal: Record<string, unknown> = {
    addEventListener(type: string, fn: (event: { source: unknown; data: unknown }) => void) {
      if (type === 'message') listeners.push(fn);
    },
    removeEventListener() {},
  };

  // Module scripts in document order over one global, as the frame runs them;
  // the page's own script may use top-level await.
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<void>;
  for (const script of Array.from(document.querySelectorAll('script[type="module"]'))) {
    const body = script.textContent!.replace(/<\\\/(script)/gi, '</$1');
    void new AsyncFunction('globalThis', 'window', 'document', 'parent', body)(
      frameGlobal,
      frameGlobal,
      document,
      parent,
    );
  }
  await settle();

  function respond(call: ToolCall, outcome: { ok: true; result: unknown } | { ok: false; error: string }) {
    answered.add(call.requestId);
    const data = { type: 'bevel.tool.response', requestId: call.requestId, ...outcome };
    for (const listener of listeners) listener({ source: parent, data });
  }

  return {
    calls,
    /** The calls the page is still waiting on. */
    pending: () => calls.filter((c) => !answered.has(c.requestId)),
    respond,
  };
}

type Page = Awaited<ReturnType<typeof mountReferencePage>>;

/** Let the page's promise chains and the bridge's replies run. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function ticket(name: string, status: string, eol = '\n') {
  return ['---', 'nodeType: "[Ticket](../NodeTypes/Ticket.md)"', '---', '', '# Name', name, '', '# Status', status, ''].join(eol);
}

/** The knowledge base the app answers from: file name → markdown. */
type Files = Record<string, string>;

const FIRST: Files = {
  'A.md': ticket('Alpha', 'todo'),
  'B.md': ticket('Bravo', 'todo'),
  'C.md': ticket('Charlie', 'doing'),
  'D.md': ticket('Delta', 'done'),
  'E.md': ticket('Echo', 'done'),
  'F.md': ticket('Foxtrot', 'done'),
};

const SECOND: Files = { ...FIRST, 'A.md': ticket('Alpha', 'done'), 'G.md': ticket('Golf', 'doing') };

/** Answer the page's pending `list_files` from `files`, naming paths as the tool does: checkout folder first. */
async function answerListing(page: Page, files: Files) {
  const listing = page.pending().find((c) => c.args[0] === 'list_files');
  expect(listing, 'the page lists its folder first').toBeDefined();
  page.respond(listing!, {
    ok: true,
    result: {
      path: `${KB_DIR_NAME}/${FOLDER}`,
      entries: Object.keys(files).map((name) => ({ name, type: 'file', canWrite: false })),
    },
  });
  await settle();
}

/**
 * Answer up to `count` of the page's pending reads from `files` (all of them
 * when omitted), failing the one named by `fail`.
 */
async function answerReads(page: Page, files: Files, { count = Infinity, fail }: { count?: number; fail?: string } = {}) {
  let left = count;
  while (left > 0) {
    const read = page.pending().find((c) => c.args[0] === 'read_file');
    if (!read) break;
    const name = read.args[1].body.path.slice(FOLDER.length + 1);
    if (name === fail) page.respond(read, { ok: false, error: `You cannot read ${read.args[1].body.path}.` });
    else
      page.respond(read, {
        ok: true,
        // The tool answers the path checkout folder first, whatever spelling it was asked with.
        result: { path: `${KB_DIR_NAME}/${read.args[1].body.path}`, content: files[name], canWrite: false },
      });
    left -= 1;
    await settle();
  }
}

const el = (id: string) => document.getElementById(id)!;
const status = () => el('status').textContent;
const countOf = (column: string) => document.querySelector(`[data-status="${column}"] .count`)!.textContent;
const cardsOf = (column: string) =>
  Array.from(document.querySelectorAll(`[data-status="${column}"] li`)).map((li) =>
    li.classList.contains('placeholder') ? '…' : li.textContent,
  );
const boardText = () => ['todo', 'doing', 'done'].map((c) => [countOf(c), ...cardsOf(c)].join('|')).join(' / ');

const FIRST_BOARD = '(2)|Alpha|Bravo / (1)|Charlie / (3)|Delta|Echo|Foxtrot';
const SECOND_BOARD = '(1)|Bravo / (2)|Charlie|Golf / (4)|Alpha|Delta|Echo|Foxtrot';
const LOADING_BOARD = '|…|… / |…|… / |…|…';

/**
 * The shell's elements, and a watch on the page's top level: a load that
 * replaces the page instead of filling it shows up as a changed element or a
 * child added to or removed from `<body>`.
 */
function watchShell() {
  const ids = ['board', 'status', 'refresh', 'retry'];
  const elements = [...ids.map(el), ...Array.from(document.querySelectorAll('.column, .column ul'))];
  const topLevel: MutationRecord[] = [];
  const observer = new MutationObserver((records) => topLevel.push(...records));
  observer.observe(document.body, { childList: true });
  return {
    expectUnchanged() {
      topLevel.push(...observer.takeRecords());
      expect(topLevel, 'nothing is added to or removed from <body>').toEqual([]);
      const now = [...ids.map(el), ...Array.from(document.querySelectorAll('.column, .column ul'))];
      expect(now.length).toBe(elements.length);
      now.forEach((node, i) => expect(node, 'the same shell element').toBe(elements[i]));
    },
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe("the guide's live-data reference page", () => {
  it('is plain HTML with inline script: the sanitizer keeps all of it', () => {
    const page = referencePage();
    expect(page).not.toMatch(/<script[^>]*\bsrc=|import\s|React|useState/);
    const kept = sanitizeAgentHtml(page);
    for (const id of ['board', 'status', 'refresh', 'retry']) expect(kept).toContain(`id="${id}"`);
    expect(kept).toContain('<script type="module">');
  });

  it('cold load: the final shell at once, no partial data, then the whole board in one step', async () => {
    const page = await mountReferencePage();
    const shell = watchShell();

    // Before any data: the board's columns, with placeholders inside them.
    expect(status()).toBe('Loading…');
    expect(el('board').getAttribute('aria-busy')).toBe('true');
    expect(boardText()).toBe(LOADING_BOARD);
    expect((el('refresh') as HTMLButtonElement).disabled).toBe(true);

    await answerListing(page, FIRST);
    await answerReads(page, FIRST, { count: 4 });
    // Four of six read: no count, card or empty column is shown yet.
    expect(boardText()).toBe(LOADING_BOARD);
    expect(status()).toBe('Loading…');

    await answerReads(page, FIRST);
    expect(boardText()).toBe(FIRST_BOARD);
    expect(el('board').getAttribute('aria-busy')).toBe('false');
    expect(status()).toMatch(/^Updated /);
    expect((el('refresh') as HTMLButtonElement).disabled).toBe(false);
    shell.expectUnchanged();
  });

  it('links each card to the file on the branch it read it from, by the path the tool answered', async () => {
    const page = await mountReferencePage();
    await answerListing(page, FIRST);
    await answerReads(page, FIRST);
    const hrefs = Array.from(document.querySelectorAll('.column a')).map((a) => a.getAttribute('href'));
    // The tool's path already carries the checkout folder; the page adds nothing in front of it.
    expect(hrefs).toEqual(Object.keys(FIRST).map((name) => `/workspace/main/${KB_DIR_NAME}/${FOLDER}/${name}`));
  });

  it('keeps a name carrying `#`, `?` or `%` in the link, each segment encoded on its own', async () => {
    const files: Files = { 'A#1.md': ticket('Sharp', 'todo'), 'B?2.md': ticket('Query', 'doing'), 'C%3.md': ticket('Percent', 'done') };
    const page = await mountReferencePage();
    await answerListing(page, files);
    await answerReads(page, files);
    const hrefs = Array.from(document.querySelectorAll('.column a')).map((a) => a.getAttribute('href'));
    // `#1.md` would otherwise be the URL's fragment, and the card would open `A`.
    expect(hrefs).toEqual([
      `/workspace/main/${KB_DIR_NAME}/Data/Tickets/A%231.md`,
      `/workspace/main/${KB_DIR_NAME}/Data/Tickets/B%3F2.md`,
      `/workspace/main/${KB_DIR_NAME}/Data/Tickets/C%253.md`,
    ]);
  });

  it('reads a file saved with Windows line endings like any other', async () => {
    const page = await mountReferencePage();
    const crlf: Files = { 'A.md': ticket('Alpha', 'todo', '\r\n'), 'B.md': ticket('Bravo', 'done', '\r\n') };
    await answerListing(page, crlf);
    await answerReads(page, crlf);
    expect(boardText()).toBe('(1)|Alpha / (0)|None / (1)|Bravo');
  });

  it('reads its data and links its cards on the branch it is viewed on, read from window.bevel.branch', async () => {
    const page = await mountReferencePage('alice/drafts');
    expect(page.calls.map((c) => [c.args[0], c.args[1].body.branch])).toEqual([['list_files', 'alice/drafts']]);
    await answerListing(page, FIRST);
    expect(page.pending().every((c) => c.args[1].body.branch === 'alice/drafts')).toBe(true);
    await answerReads(page, FIRST);
    const hrefs = Array.from(document.querySelectorAll('.column a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(Object.keys(FIRST).map((name) => `/workspace/alice%2Fdrafts/${KB_DIR_NAME}/${FOLDER}/${name}`));
  });

  it('reads in bounded parallel, only after listing, through read-only tools, never a chain', async () => {
    const page = await mountReferencePage();
    expect(page.calls.map((c) => c.args[0])).toEqual(['list_files']);

    await answerListing(page, FIRST);
    // Six files to read, four at a time.
    expect(page.pending().length).toBe(4);
    await answerReads(page, FIRST, { count: 1 });
    expect(page.pending().length).toBe(4);
    await answerReads(page, FIRST);

    expect(page.calls.filter((c) => c.args[0] === 'read_file').map((c) => c.args[1].body.path).sort()).toEqual(
      Object.keys(FIRST).map((name) => `${FOLDER}/${name}`),
    );
    for (const call of page.calls) {
      expect(call.fn).toBe('callTool');
      expect(['list_files', 'read_file']).toContain(call.args[0]);
    }
  });

  it('warm refresh: the current board stays, marked busy, while a small refreshing state shows, then is replaced whole', async () => {
    const page = await mountReferencePage();
    await answerListing(page, FIRST);
    await answerReads(page, FIRST);
    const shell = watchShell();

    (el('refresh') as HTMLButtonElement).click();
    await settle();
    expect(status()).toBe('Refreshing…');
    expect(el('board').getAttribute('aria-busy')).toBe('true');
    expect((el('refresh') as HTMLButtonElement).disabled).toBe(true);
    expect(boardText()).toBe(FIRST_BOARD);

    await answerListing(page, SECOND);
    await answerReads(page, SECOND, { count: 5 });
    // Part of the new dataset is in: the board is still the last whole one.
    expect(boardText()).toBe(FIRST_BOARD);
    expect(status()).toBe('Refreshing…');

    await answerReads(page, SECOND);
    expect(boardText()).toBe(SECOND_BOARD);
    expect(el('board').getAttribute('aria-busy')).toBe('false');
    expect(status()).toMatch(/^Updated /);
    expect((el('refresh') as HTMLButtonElement).disabled).toBe(false);
    shell.expectUnchanged();
  });

  it('a failed read on refresh keeps the last good board, says why, and retry recovers', async () => {
    const page = await mountReferencePage();
    await answerListing(page, FIRST);
    await answerReads(page, FIRST);
    const shell = watchShell();

    (el('refresh') as HTMLButtonElement).click();
    await settle();
    await answerListing(page, SECOND);
    await answerReads(page, SECOND, { fail: 'C.md' });

    expect(boardText()).toBe(FIRST_BOARD);
    expect(el('status').className).toBe('error');
    expect(status()).toBe('Could not refresh; showing the last loaded board. You cannot read Data/Tickets/C.md.');
    expect(el('retry').hidden).toBe(false);

    el('retry').click();
    await settle();
    expect(el('retry').hidden).toBe(true);
    expect(status()).toBe('Refreshing…');
    await answerListing(page, SECOND);
    await answerReads(page, SECOND);
    expect(boardText()).toBe(SECOND_BOARD);
    expect(el('status').className).toBe('');
    shell.expectUnchanged();
  });

  it('a failed read starts no further read and offers Retry only once the reads in flight settle', async () => {
    const page = await mountReferencePage();
    await answerListing(page, FIRST);
    const reads = () => page.calls.filter((c) => c.args[0] === 'read_file').length;
    expect(reads()).toBe(4);

    await answerReads(page, FIRST, { count: 1, fail: 'A.md' });
    // Three reads still in flight; the two files left are not started.
    expect(page.pending().length).toBe(3);
    expect(reads()).toBe(4);
    expect(el('retry').hidden).toBe(true);
    expect(status()).toBe('Loading…');

    await answerReads(page, FIRST);
    expect(reads()).toBe(4);
    expect(status()).toBe('Could not load the tickets. You cannot read Data/Tickets/A.md.');
    expect(el('retry').hidden).toBe(false);
    expect(boardText()).toBe(LOADING_BOARD);
  });

  it('a failed read on the first load keeps the shell, says why, and retry recovers', async () => {
    const page = await mountReferencePage();
    const shell = watchShell();
    await answerListing(page, FIRST);
    await answerReads(page, FIRST, { fail: 'E.md' });

    // The reads that succeeded are not shown as if they were the board.
    expect(boardText()).toBe(LOADING_BOARD);
    expect(status()).toBe('Could not load the tickets. You cannot read Data/Tickets/E.md.');
    expect(el('retry').hidden).toBe(false);

    el('retry').click();
    await settle();
    expect(status()).toBe('Loading…');
    await answerListing(page, FIRST);
    await answerReads(page, FIRST);
    expect(boardText()).toBe(FIRST_BOARD);
    expect(el('retry').hidden).toBe(true);
    shell.expectUnchanged();
  });
});
