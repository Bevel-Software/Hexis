import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '@utcp/mcp'; // side effect: registers the 'mcp' UTCP communication protocol
import { CodeModeUtcpClient } from '@utcp/code-mode';
import type { CallTemplate } from '@utcp/sdk';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { DEFAULT_BRANCH } from '@bevel-software/platform-shared';
import { registerManual } from '@bevel-software/platform-mcp-core';
import { ToolManualService } from '../tool-manuals.service.js';
import { workspaceIdForBranch } from '../../../shared/workspace-id.js';
import type { WorkspaceService } from '../../workspace/index.js';
import type { IAccessControl } from '../../access/index.js';
import { testKbContext } from '../../../__tests__/kb-context.js';
import { realDisk, realPluginSource } from '../../../__tests__/real-disk.js';

/**
 * `excludeTools` from a plugin's `plugin.json` to a client's tool list, with
 * nothing hand-written in between: discovery reads the files, the service
 * builds the call template (`toManualCallTemplates`), and a real UTCP client
 * registers it against a real MCP server, over HTTP and over stdio.
 */

const KB_DIR = 'knowledge-base';
const wsId = workspaceIdForBranch(DEFAULT_BRANCH);

/** A minimal MCP stdio server listing `probe` and `extra`, with no dependencies. */
const STDIO_SERVER = `'use strict';
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
const tool = (name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    send({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: req.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '0.0.0' } } });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: [tool('probe'), tool('extra')] } });
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'not implemented' } });
  }
});
`;

let root = '';
let httpServer: http.Server | null = null;
let httpUrl = '';
const clients: CodeModeUtcpClient[] = [];

const workspaceService = {
  getOrCreateForBranch: async () => ({ id: wsId }),
  getWorkspacePath: async (id: string) => join(root, id),
} as unknown as WorkspaceService;
const readsEverything = {
  canRead: async () => true,
  canReadBatch: async (_w: string, _e: string, paths: string[]) => new Map(paths.map((p) => [p, true])),
} as unknown as IAccessControl;

function service(): ToolManualService {
  const kb = testKbContext({ kbDirName: KB_DIR });
  const disk = realDisk();
  return new ToolManualService(workspaceService, readsEverything, kb, disk, realPluginSource(disk, kb));
}

/** A plugin folder holding `mcp.json` and a `plugin.json` that leaves `exclude` out of `server`. */
async function writePlugin(folder: string, server: string, entry: Record<string, unknown>, ext: Record<string, unknown>) {
  const dir = join(root, wsId, KB_DIR, 'Plugins', folder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'mcp.json'), JSON.stringify({ mcpServers: { [server]: entry } }));
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify({ name: folder.toLowerCase(), extensions: { 'software.bevel.hexis': { mcpServers: { [server]: ext } } } }),
  );
  return dir;
}

/** The template the service builds for `name`, then the tools a real client registers from it. */
async function registered(name: string): Promise<{ template: CallTemplate; tools: string[] }> {
  const template = (await service().toManualCallTemplates('user@example.com')).find((t) => t.name === name);
  expect(template, `no call template named ${name}`).toBeDefined();
  const client = await CodeModeUtcpClient.create(process.cwd(), null);
  clients.push(client);
  expect(await registerManual(client, template!)).toEqual({ ok: true });
  return { template: template!, tools: (await client.getTools()).map((t) => t.name) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'exclude-tools-'));
  httpServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      void (async () => {
        const mcp = new Server({ name: 'fixture', version: '0.0.0' }, { capabilities: { tools: {} } });
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: ['echo', 'paid'].map((name) => ({ name, description: name, inputSchema: { type: 'object' as const, properties: {} } })),
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body ? (JSON.parse(body) as unknown) : undefined);
      })();
    });
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, '127.0.0.1', resolve));
  httpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  httpServer?.closeAllConnections();
  await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe("plugin.json's excludeTools, through the service's call template and a real registration", () => {
  it('leaves the tool off an HTTP server', async () => {
    // `local: true`: a loopback URL is only accepted from a server declared local.
    await writePlugin('Docs', 'docs', { type: 'streamable-http', url: httpUrl }, { local: true, excludeTools: ['paid'] });

    const { template, tools } = await registered('docs');

    expect((template as { config: { mcpServers: Record<string, unknown> } }).config.mcpServers.docs).toMatchObject({
      exclude_tools: ['paid'],
    });
    expect(tools).toEqual(['docs.docs.echo']);
  });

  it('leaves the tool off a stdio server', { timeout: 30_000 }, async () => {
    const dir = await writePlugin('Probe', 'probe', { type: 'stdio', command: 'node', args: [] }, { excludeTools: ['extra'] });
    await writeFile(join(dir, 'server.cjs'), STDIO_SERVER);
    // The script's absolute path, which only this test knows; the rest is as discovery read it.
    await writeFile(
      join(dir, 'mcp.json'),
      JSON.stringify({ mcpServers: { probe: { type: 'stdio', command: 'node', args: [join(dir, 'server.cjs')] } } }),
    );

    const { template, tools } = await registered('probe');

    expect((template as { config: { mcpServers: Record<string, unknown> } }).config.mcpServers.probe).toMatchObject({
      exclude_tools: ['extra'],
    });
    expect(tools).toEqual(['probe.probe.probe']);
  });
});
