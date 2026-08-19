import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { hostKey } from '../materialize.js';

/**
 * END-TO-END: spawned stdio servers die WITH the CLI process.
 *
 * The leak this pins: the CLI's grandchildren (stdio MCP servers spawned by
 * @utcp/mcp) are NOT killed by the CLI's own death on Windows, and one that
 * survives keeps its cwd inside the materialized plugin root — holding it
 * EBUSY-hostage for every later instance. The fix is the cli.ts teardown:
 * stdin EOF → shutdown() → UtcpClient.close() → the stdio transports
 * terminate their children.
 *
 * So this test runs the REAL CLI as a real child process against a stub
 * deployment (config + MCP endpoint + manuals + plugin archive — the same
 * faked HTTP surface the stdio e2e uses, plus a genuine streamable-HTTP MCP
 * endpoint so the remote manual registers). The grandchild fixture writes its
 * own pid on boot; the test closes the CLI's stdin — exactly what an MCP
 * client hanging up looks like — and asserts the grandchild is GONE within a
 * bound, on the platform where nothing else would have killed it.
 */

/** The grandchild: reports its pid, then lives until its transport closes. */
const EXIT_PROBE = `'use strict';
const fs = require('node:fs');
fs.writeFileSync(process.env.PIDFILE, String(process.pid));
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: {
      protocolVersion: req.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'exit-probe', version: '0.0.0' },
    }});
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{
      name: 'noop',
      description: 'Exists so registration discovers something.',
      inputSchema: { type: 'object', properties: {} },
    }] } });
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'not implemented' } });
  }
});
// A well-behaved stdio server exits when its client hangs up; the interval
// models a long-running one, so ONLY a closed transport ends this process.
rl.on('close', () => process.exit(0));
setInterval(() => {}, 1000);
`;

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** tsx is not this package's dependency; borrow the workspace's copy to run src/cli.ts directly. */
function resolveTsxLoader(): string {
  const repoRoot = path.resolve(pkgDir, '..', '..');
  return createRequire(path.join(repoRoot, 'packages', 'core-backend', 'package.json')).resolve('tsx');
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let httpServer: http.Server | null = null;
let base = '';
let home = '';

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-teardown-'));

  const zip = new AdmZip();
  zip.addFile('bin/server.cjs', Buffer.from(EXIT_PROBE), '', 0o755);
  const archive = zip.toBuffer();

  httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      void (async () => {
        const pathname = (req.url ?? '/').split('?')[0]!;
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (pathname === '/api/config') {
          json(200, { mcpUrl: `${base}/api/mcp` });
          return;
        }
        if (pathname === '/api/mcp') {
          // A REAL MCP endpoint, stateless streamable-HTTP: one server +
          // transport per request is the SDK's documented sessionless shape,
          // and it is enough for the remote manual to register (initialize +
          // tools/list). GET/DELETE fall through to the transport's own 405s.
          const mcp = new Server(
            { name: 'stub-deployment', version: '0.0.0' },
            { capabilities: { tools: {} } },
          );
          mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on('close', () => {
            void transport.close();
            void mcp.close();
          });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body ? (JSON.parse(body) as unknown) : undefined);
          return;
        }
        if (pathname === '/api/agent/all-tools') {
          json(200, {
            manuals: [
              {
                name: 'local_toolbox',
                call_template_type: 'mcp',
                config: {
                  mcpServers: {
                    probe: {
                      transport: 'stdio',
                      command: 'node',
                      args: ['${PLUGIN_ROOT}/bin/server.cjs'],
                      env: { PIDFILE: '${PLUGIN_DATA}/exit-probe.pid' },
                    },
                  },
                },
              },
            ],
          });
          return;
        }
        if (pathname === '/api/agent/tools/list_local_tools') {
          json(200, { tools: [{ name: 'local_toolbox', path: 'Plugins/GTM/mcp.json' }] });
          return;
        }
        if (pathname === '/api/agent/plugins/GTM/archive') {
          res.writeHead(200, { 'Content-Type': 'application/zip' });
          res.end(archive);
          return;
        }
        if (pathname === '/api/agent/tools/list_skills') {
          json(200, { skills: [] });
          return;
        }
        json(404, {});
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(httpServer!.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (httpServer) {
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }
  await fs.rm(home, { recursive: true, force: true });
});

describe('deterministic teardown', () => {
  it(
    'closing the CLI\'s stdin ends the spawned grandchild within a bound',
    { timeout: 120_000 },
    async () => {
      const pidFile = path.join(home, 'plugin-data', hostKey(base), 'GTM', 'exit-probe.pid');
      let cli: ChildProcess | null = null;
      let stderr = '';
      let grandchildPid = 0;
      try {
        cli = spawn(
          process.execPath,
          [
            '--import',
            pathToFileURL(resolveTsxLoader()).href,
            path.join(pkgDir, 'src', 'cli.ts'),
            '--url',
            base,
            '--key',
            'bevel_teardown',
          ],
          { cwd: pkgDir, env: { ...process.env, HEXIS_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        cli.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        const exited = new Promise<number | null>((resolve) => cli!.once('exit', (code) => resolve(code)));

        // Startup is done materializing + spawning once the grandchild has
        // reported its own pid.
        const bootDeadline = Date.now() + 90_000;
        for (;;) {
          const raw = await fs.readFile(pidFile, 'utf8').catch(() => '');
          grandchildPid = Number.parseInt(raw, 10) || 0;
          if (grandchildPid > 0) break;
          if (cli.exitCode !== null || Date.now() > bootDeadline) {
            throw new Error(`the CLI never spawned the probe server. stderr:\n${stderr}`);
          }
          await sleep(200);
        }
        expect(pidAlive(grandchildPid)).toBe(true);
        // Let the CLI finish connecting its stdio transport (the ready line
        // and the teardown handlers land right after the spawn we just saw).
        await sleep(750);

        // The MCP client hangs up.
        cli.stdin!.end();

        // The GRANDCHILD dies within a bound — this is the assertion that
        // fails when nothing closes the UTCP client, because killing/ending
        // the CLI process alone does not end its grandchildren on Windows.
        const exitDeadline = Date.now() + 20_000;
        while (pidAlive(grandchildPid)) {
          if (Date.now() > exitDeadline) {
            throw new Error(`grandchild ${grandchildPid} still alive 20s after stdin closed. stderr:\n${stderr}`);
          }
          await sleep(200);
        }
        // And the CLI itself exited cleanly.
        expect(await exited).toBe(0);
        cli = null;
      } finally {
        // Belt for a failed run: nothing may outlive the test.
        if (grandchildPid > 0 && pidAlive(grandchildPid)) {
          try {
            process.kill(grandchildPid);
          } catch {
            /* already gone */
          }
        }
        if (cli && cli.exitCode === null) {
          cli.kill();
          await new Promise<void>((resolve) => cli!.once('exit', () => resolve()));
        }
        // Give Windows a beat to release cwd handles before afterAll's rm.
        await sleep(250);
      }
    },
  );
});
