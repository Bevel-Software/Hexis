import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * END-TO-END: a rejected connection key ends the CLI with one plain sentence.
 *
 * The real CLI runs as a child process against a stub deployment that answers
 * `/api/config` and refuses every key-authenticated request the way the
 * deployment does (401, `invalid_token`, no `resource_metadata`). What this
 * pins: the sentence reaches stderr, the exit code is non-zero, the key is
 * never printed, and no browser sign-in is attempted — the stub records every
 * request, and none of them may touch discovery or the OAuth endpoints.
 */

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAD_KEY = 'bevel_revokedKeyThatMustNeverBePrinted';

/** tsx is not this package's dependency; borrow the workspace's copy to run src/cli.ts directly. */
function resolveTsxLoader(): string {
  const repoRoot = path.resolve(pkgDir, '..', '..');
  return createRequire(path.join(repoRoot, 'packages', 'core-backend', 'package.json')).resolve('tsx');
}

let stub: http.Server;
let base = '';
let home = '';
const requests: string[] = [];

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-rejected-key-'));
  stub = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/api/config') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mcpUrl: `${base}/api/mcp`, agentInstructions: true }));
      return;
    }
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Invalid or revoked connection key"');
    res.end(JSON.stringify({ error: 'Invalid or revoked connection key. Mint a new one in External agent access.' }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
});

afterAll(async () => {
  // A CLI that regressed into hanging holds a keep-alive socket to the stub;
  // close() alone would wait on it forever and stall the whole suite.
  stub.closeAllConnections?.();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  await fs.rm(home, { recursive: true, force: true });
});

describe('a rejected connection key', () => {
  it('prints the sentence, exits non-zero, and never starts a browser sign-in', { timeout: 60_000 }, async () => {
    const cli = spawn(
      process.execPath,
      ['--import', pathToFileURL(resolveTsxLoader()).href, path.join(pkgDir, 'src', 'cli.ts'), '--url', base, '--key', BAD_KEY],
      // HEXIS_NO_BROWSER keeps a regression from opening a real browser here;
      // the request log below is what proves no sign-in was attempted.
      { cwd: pkgDir, env: { ...process.env, HEXIS_HOME: home, HEXIS_NO_BROWSER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    cli.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    cli.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve) => cli.once('exit', (c) => resolve(c)));
    } finally {
      // Reaps a CLI that hangs instead of exiting, so the timeout fails this
      // test rather than leaving an orphan behind the suite.
      if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
    }

    const sentence =
      `The connection key was rejected by ${base}. Mint a new one in External agent access. ` +
      '(Claude Code hides this message; run `claude mcp get <name>` or start the command in a terminal to see it.)';
    expect(code, stderr).not.toBe(0);
    // The fatal line is the process's last word.
    expect(stderr.trimEnd().split('\n').at(-1)).toBe(sentence);
    expect(stderr).not.toContain(BAD_KEY);
    expect(stdout).toBe('');

    expect(requests).toContain('GET /api/config');
    for (const r of requests) {
      expect(r).not.toMatch(/well-known|\/authorize|\/token|\/register|local-token/);
    }
  });
});

/**
 * END-TO-END: a key revoked WHILE the CLI runs. The stub accepts the key
 * through startup and one listing, then refuses it the way a Disconnect on
 * External agent access does. The next call must be answered with the plain
 * sentence, and the process must then exit non-zero on its own: nothing is
 * left serving on a dead key.
 */
describe('a connection key revoked mid-run', () => {
  const LIVE_KEY = 'bevel_liveThenRevokedKeyThatMustNeverBePrinted';
  const SENTENCE = 'Invalid or revoked connection key. Mint a new one in External agent access.';
  let live: http.Server;
  let liveBase = '';
  let revoked = false;

  beforeAll(async () => {
    const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const { ListToolsRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');
    live = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        void (async () => {
          const pathname = (req.url ?? '/').split('?')[0]!;
          const json = (status: number, payload: unknown): void => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
          };
          if (pathname === '/api/config') return json(200, { mcpUrl: `${liveBase}/api/mcp`, agentInstructions: true });
          if (revoked || req.headers.authorization !== `Bearer ${LIVE_KEY}`) return json(401, { error: SENTENCE });
          if (pathname === '/api/agent/instructions') return json(200, { instructions: 'Search the knowledge base.' });
          if (pathname === '/api/agent/all-tools') return json(200, { manuals: [] });
          if (pathname === '/api/agent/tools/list_local_tools') return json(200, { tools: [] });
          if (pathname === '/api/mcp') {
            const parsed = body ? (JSON.parse(body) as unknown) : undefined;
            const mcp = new Server({ name: 'stub-deployment', version: '0.0.0' }, { capabilities: { tools: {} } });
            mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
              tools: [{ name: 'list_files', description: 'List files.', inputSchema: { type: 'object' as const } }],
            }));
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            res.on('close', () => {
              void transport.close();
              void mcp.close();
            });
            await mcp.connect(transport);
            await transport.handleRequest(req, res, parsed);
            return;
          }
          json(404, {});
        })().catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
    });
    await new Promise<void>((resolve) => live.listen(0, '127.0.0.1', resolve));
    liveBase = `http://127.0.0.1:${(live.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    live.closeAllConnections?.();
    await new Promise<void>((resolve) => live.close(() => resolve()));
  });

  it('answers the next call with the sentence and exits non-zero', { timeout: 60_000 }, async () => {
    const cli = spawn(
      process.execPath,
      ['--import', pathToFileURL(resolveTsxLoader()).href, path.join(pkgDir, 'src', 'cli.ts'), '--url', liveBase, '--key', LIVE_KEY],
      { cwd: pkgDir, env: { ...process.env, HEXIS_HOME: home, HEXIS_NO_BROWSER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    cli.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolve) => cli.once('exit', (c) => resolve(c)));
    // Newline-delimited JSON-RPC, the stdio transport's framing.
    const pending = new Map<number, (msg: { result?: unknown; error?: { message: string } }) => void>();
    let buffered = '';
    cli.stdout!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
        if (typeof msg.id === 'number') pending.get(msg.id)?.(msg);
      }
    });
    let nextId = 0;
    const request = (method: string, params: unknown) =>
      new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
        const id = ++nextId;
        pending.set(id, resolve);
        cli.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    try {
      const init = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '0.0.0' },
      });
      expect(init.error).toBeUndefined();
      cli.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const listed = await request('tools/list', {});
      expect(listed.error, stderr).toBeUndefined();

      revoked = true;
      const refused = await request('tools/call', { name: 'list_tools', arguments: {} });
      expect(refused.error?.message).toContain(SENTENCE);

      const code = await Promise.race([
        exited,
        new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), 20_000)),
      ]);
      expect(code, stderr).toBe(1);
      expect(stderr).toContain('hexis-mcp has stopped serving');
      expect(stderr).not.toContain(LIVE_KEY);
    } finally {
      if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
    }
  });
});
