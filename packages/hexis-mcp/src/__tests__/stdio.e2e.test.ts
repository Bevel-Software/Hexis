import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import '@utcp/mcp'; // side effect: registers the 'mcp' call-template protocol
import { CallTemplateSerializer, UtcpClientConfigSerializer } from '@utcp/sdk';
import { CodeModeUtcpClient } from '@utcp/code-mode';
import { registerManual } from '@bevel-software/platform-mcp-core';
import { materializePlugin, prepareStdioSpec } from '../materialize.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * END-TO-END: the stdio runtime contract, at the process boundary.
 *
 * The unit tests pin expansion and containment as functions; this test pins
 * the round-trip the risk review asked for: a plugin fetched from a (faked)
 * deployment archive endpoint, materialized to real disk, its stdio server
 * REALLY SPAWNED through the same UTCP mcp plugin `hexis-mcp` registers
 * manuals with, and the contract asserted from INSIDE the child — the spawned
 * process reports its own PLUGIN_ROOT, PLUGIN_DATA, cwd and env back through
 * a tool call, so a regression in any layer (archive, materialization,
 * expansion, spawn env) fails here even if every unit test still passes.
 *
 * Only the deployment's HTTP surface is faked, because the platform is not
 * what is at risk; the zip, the disk, the subprocess and the MCP handshake
 * are all real. The fixture server speaks raw newline-delimited JSON-RPC with
 * ZERO dependencies — the materialized copy has no node_modules to import
 * from, and needing none is what keeps the fixture honest.
 */

/** A minimal MCP stdio server: initialize, tools/list, tools/call(probe). */
const FIXTURE_SERVER = `'use strict';
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
      serverInfo: { name: 'probe-fixture', version: '0.0.0' },
    }});
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [{
      name: 'probe',
      description: 'Report the runtime contract as this process sees it.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    }] } });
  } else if (req.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify({
      pluginRoot: process.env.PLUGIN_ROOT ?? null,
      pluginData: process.env.PLUGIN_DATA ?? null,
      marker: process.env.MARKER ?? null,
      unknown: process.env.UNKNOWN ?? null,
      cwd: process.cwd(),
    }) }] } });
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'not implemented' } });
  }
});
`;

let httpServer: http.Server | null = null;
let home = '';
let config: HexisMcpConfig;
let client: CodeModeUtcpClient | null = null;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-e2e-'));
  process.env.HEXIS_HOME = home;

  // The faked deployment: ONLY the archive endpoint, serving a real zip.
  const zip = new AdmZip();
  zip.addFile('plugin.json', Buffer.from('{ "name": "gtm" }\n'));
  zip.addFile(
    'mcp.json',
    Buffer.from(JSON.stringify({ mcpServers: { probe: { type: 'stdio', command: 'node' } } })),
  );
  // Plain mode, as the backend's archive route now passes it — adm-zip masks
  // a numeric attr with 0xfff and positions it into the high bits itself.
  zip.addFile('bin/server.cjs', Buffer.from(FIXTURE_SERVER), '', 0o755);
  const archive = zip.toBuffer();

  httpServer = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/agent/plugins/GTM/archive')) {
      if (req.headers.authorization !== 'Bearer bevel_e2e') {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/zip' }).end(archive);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  const port = (httpServer!.address() as { port: number }).port;
  config = { baseUrl: `http://127.0.0.1:${port}`, connectionKey: 'bevel_e2e' };
});

afterAll(async () => {
  await client?.close().catch(() => {});
  if (httpServer) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  delete process.env.HEXIS_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe('stdio end-to-end', () => {
  it(
    'materializes the plugin, spawns the server, and the CHILD confirms the contract',
    { timeout: 60_000 },
    async () => {
      const plugin = await materializePlugin(config, 'GTM');
      // Byte-for-byte materialization, binaries-capable path included.
      expect(await fs.readFile(path.join(plugin.pluginRoot, 'bin', 'server.cjs'), 'utf8')).toBe(
        FIXTURE_SERVER,
      );
      // The exec bit survives the zip round trip — what lets a `./`-command
      // stdio server actually run. Windows has no comparable mode bits, so
      // the assertion is POSIX-only; the spawn below covers Windows.
      if (process.platform !== 'win32') {
        const mode = (await fs.stat(path.join(plugin.pluginRoot, 'bin', 'server.cjs'))).mode;
        expect(mode & 0o111, 'materialized server lost its exec bit').toBeTruthy();
      }

      // The same preparation `prepareLocalManuals` applies before registration.
      const spec = await prepareStdioSpec(
        {
          command: 'node',
          args: ['${PLUGIN_ROOT}/bin/server.cjs'],
          env: { MARKER: '${PLUGIN_DATA}/mark', UNKNOWN: '${NOPE}' },
          cwd: '${PLUGIN_ROOT}',
        },
        plugin,
      );
      // The Agent Plugins rule stops HERE: our expansion touches exactly the
      // two runtime placeholders and leaves the rest literal…
      expect(spec.env?.UNKNOWN).toBe('${NOPE}');

      // Registered through the SAME stack hexis-mcp uses: a UTCP mcp call
      // template on a CodeModeUtcpClient — @utcp/mcp does the actual spawn.
      const template = new CallTemplateSerializer().validateDict({
        name: 'gtmprobe',
        call_template_type: 'mcp',
        config: { mcpServers: { probe: { transport: 'stdio', ...spec } } },
      });
      // …and UTCP takes over from there: a remaining `${VAR}` resolves from
      // the client's variables under the manual's namespace — which is exactly
      // how a local tool's credentials arrive from the MCP client config's env
      // in the real hexis-mcp process.
      client = await CodeModeUtcpClient.create(
        process.cwd(),
        new UtcpClientConfigSerializer().validateDict({
          variables: { gtmprobe_NOPE: 'credential-from-launch-env' },
        }),
      );
      const registered = await registerManual(client, template);
      expect(registered).toEqual({ ok: true });

      const tools = await client.getTools();
      const probe = tools.find((t) => t.name.endsWith('probe'));
      expect(probe, `no probe tool discovered; got: ${tools.map((t) => t.name).join(', ')}`).toBeTruthy();

      // One real call, answered by the spawned process about ITSELF.
      let last: unknown;
      for await (const chunk of client.callToolStreaming(probe!.name, {})) last = chunk;
      const text =
        typeof last === 'string'
          ? last
          : ((last as { content?: { text?: string }[] })?.content?.[0]?.text ?? JSON.stringify(last));
      const reported = JSON.parse(text) as Record<string, string | null>;

      // Realpath both sides: the OS may hand the child a canonicalized cwd
      // (macOS /tmp is a symlink), and the contract is about identity, not
      // spelling.
      const real = async (p: string | null) => (p ? fs.realpath(p).catch(() => p) : p);
      expect(await real(reported.pluginRoot)).toBe(await real(plugin.pluginRoot));
      expect(await real(reported.pluginData)).toBe(await real(plugin.pluginData));
      expect(await real(reported.cwd)).toBe(await real(plugin.pluginRoot));
      // env VALUES expand; unknown placeholders stay literal — per spec.
      // Expansion is TEXTUAL (single, non-recursive) — the template wrote '/',
      // so the child sees pluginData + '/mark' verbatim on every OS.
      expect(reported.marker).toBe(`${plugin.pluginData}/mark`);
      // The credential the launch env supplied arrived INSIDE the child.
      expect(reported.unknown).toBe('credential-from-launch-env');

      // Close HERE, not in afterAll: the child's cwd is inside the plugin
      // root, and Windows refuses to remove a directory a live process holds
      // — the later tests' cleanup would EBUSY against it.
      await client.close();
      client = null;
    },
  );

  it('refuses to register a stdio server whose credential variable is missing', async () => {
    // The flip side of the resolution above: a `${VAR}` nobody supplied is a
    // REGISTRATION refusal naming the namespaced key — which is how a missing
    // local credential presents to a hexis-mcp user, and registerManual's
    // never-throw contract is what keeps it from taking the session down.
    // A hand-built plugin dir: refusal happens before any spawn, and
    // re-materializing GTM would race the previous test's teardown.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-e2e-orphan-'));
    const plugin = { pluginRoot: path.join(dir, 'root'), pluginData: path.join(dir, 'data') };
    await fs.mkdir(plugin.pluginRoot, { recursive: true });
    await fs.mkdir(plugin.pluginData, { recursive: true });
    const spec = await prepareStdioSpec(
      { command: 'node', args: ['${PLUGIN_ROOT}/bin/server.cjs'], env: { KEY: '${ABSENT}' } },
      plugin,
    );
    const bare = await CodeModeUtcpClient.create(
      process.cwd(),
      new UtcpClientConfigSerializer().validateDict({ variables: {} }),
    );
    try {
      const result = await registerManual(
        bare,
        new CallTemplateSerializer().validateDict({
          name: 'orphan',
          call_template_type: 'mcp',
          config: { mcpServers: { probe: { transport: 'stdio', ...spec } } },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('orphan_ABSENT');
    } finally {
      await bare.close().catch(() => {});
    }
  });

  it('refuses an escaping cwd within the same composed flow', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-e2e-escape-'));
    const plugin = { pluginRoot: path.join(dir, 'root'), pluginData: path.join(dir, 'data') };
    await fs.mkdir(plugin.pluginRoot, { recursive: true });
    await fs.mkdir(plugin.pluginData, { recursive: true });
    await expect(
      prepareStdioSpec({ command: 'node', args: [], cwd: '../../outside' }, plugin),
    ).rejects.toThrow(/escapes the plugin root|does not exist/);
  });
});
