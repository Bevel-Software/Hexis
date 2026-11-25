import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, type Rollup } from 'vite';

/**
 * A 410 for a branch, through Chromium's own HTTP cache.
 *
 * What failed: a person opened their own applied change request, whose
 * suggestions branch the apply had removed, and `GET /api/workspace` answered
 * 410 with no caching rule. Chromium kept that answer, and the next proposal's
 * read of the same address, after the proposal had created the branch again,
 * was answered from the cache: "HTTP 410", in that browser. The unit suites
 * check the header the route sends and the option the app's read passes; this
 * is the browser between them. Served by a real HTTP server, not a Playwright
 * route: routing turns the browser's cache off.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const BRANCH = 'suggestions/rae-u9-1234-/knowledge';
const ADDRESS = `/api/workspace?branch=${encodeURIComponent(BRANCH)}`;

let pageBundle: string | undefined;
async function bundle(): Promise<string> {
  if (pageBundle) return pageBundle;
  const built = (await build({
    configFile: false,
    root: path.resolve(here, 'fixtures'),
    logLevel: 'silent',
    esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    build: {
      write: false,
      minify: false,
      lib: { entry: path.resolve(here, 'fixtures/workspace-bootstrap.ts'), formats: ['iife'], name: 'WorkspaceBootstrap', fileName: () => 'bootstrap.js' },
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  const outputs = Array.isArray(built) ? built : [built];
  const chunk = outputs.flatMap((o) => o.output).find((o): o is Rollup.OutputChunk => o.type === 'chunk');
  if (!chunk) throw new Error('the page bundle produced no chunk');
  pageBundle = chunk.code;
  return pageBundle;
}

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The branch removed: the body the route sends, an ETag as Express adds one, and the caching rule given. */
function gone(cacheControl?: string): Answer {
  return {
    status: 410,
    headers: { 'content-type': 'application/json', etag: 'W/"gone"', ...(cacheControl ? { 'cache-control': cacheControl } : {}) },
    body: JSON.stringify({ kind: 'remote-branch-gone', branch: BRANCH, error: `Branch "${BRANCH}" no longer exists on the remote.` }),
  };
}

/** The branch there again. */
function there(): Answer {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', etag: 'W/"there"' },
    body: JSON.stringify({
      workspace: { id: encodeURIComponent(BRANCH), name: BRANCH, absolutePath: '/w', createdAt: new Date(0).toISOString(), kbDirName: 'knowledge-base' },
      fileTree: { name: 'knowledge-base', path: '', type: 'directory', children: [] },
    }),
  };
}

const servers: http.Server[] = [];
test.afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A server whose `GET /api/workspace` gives `answers` in turn, and counts what reached it. */
async function serve(answers: Answer[]): Promise<{ origin: string; asked: () => number }> {
  const script = await bundle();
  let asked = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><html><body></body></html>');
    } else if (req.url === '/bootstrap.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(script);
    } else if (req.url === ADDRESS) {
      const answer = answers[asked++] ?? { status: 500, headers: {}, body: '' };
      res.writeHead(answer.status, answer.headers).end(answer.body);
    } else {
      res.writeHead(404).end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, asked: () => asked };
}

async function open(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/`);
  await page.addScriptTag({ url: '/bootstrap.js' });
}

// The first test in each worker bundles the workspace module's entry.
test.setTimeout(90_000);

/** A plain read of the address, as any page script or an earlier build of the app made it. */
const plainRead = (page: Page) => page.evaluate((address) => fetch(address).then((r) => r.status), ADDRESS);
const openBranch = (page: Page) => page.evaluate((branch) => window.openBranch(branch), BRANCH);

test('opens a branch that answered 410 earlier and is there again: the second read reaches the server', async ({ page }) => {
  // The ticket's sequence: the request's dialog reads the removed branch, the
  // proposal creates it again and reads it. Both reads are the app's.
  const server = await serve([gone(), there()]);
  await open(page, server.origin);

  expect(await openBranch(page)).toBe('failed 410');
  expect(await openBranch(page)).toBe(`200 ${encodeURIComponent(BRANCH)}`);
  expect(server.asked()).toBe(2);
});

test('opens the branch even when the browser already holds a 410 for its address', async ({ page }) => {
  const server = await serve([gone(), there()]);
  await open(page, server.origin);

  // The intermediary as it is: a 410 sent without a caching rule is kept,
  // and a plain read of the same address is answered from it, the server
  // not asked again.
  expect(await plainRead(page)).toBe(410);
  expect(await plainRead(page)).toBe(410);
  expect(server.asked()).toBe(1);

  // The app's read is not answered from it.
  expect(await openBranch(page)).toBe(`200 ${encodeURIComponent(BRANCH)}`);
  expect(server.asked()).toBe(2);
});

test('does not keep a 410 sent with the no-store rule GET /api/workspace now gives', async ({ page }) => {
  const server = await serve([gone('no-store'), there()]);
  await open(page, server.origin);

  expect(await plainRead(page)).toBe(410);
  expect(await plainRead(page)).toBe(200);
  expect(server.asked()).toBe(2);
});
