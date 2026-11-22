import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../tool-registry.js';
import { createManualRoutes } from '../manual.routes.js';
import { ConnectionScope } from '../../agent-scope/index.js';
import { registerChangeRequestApplyTools } from '../../version-control/agent-tools/change-request-apply.tools.js';
import { registerChangeRequestReadTools } from '../../version-control/agent-tools/change-request-read.tools.js';
import { testKbContext } from '../../../__tests__/kb-context.js';

/**
 * The manuals every agent surface lists tools from — the hosted MCP endpoint
 * and the local server read the agent manual, the in-app agent the internal
 * one — offer approving and applying a change request to a connection made
 * as a bot, and to nobody else. A Myself connection's listing is what it was
 * before bots, so what agents acting as a person read does not change.
 */

const pass: express.RequestHandler = (_req, _res, next) => next();
const handler = (() => pass) as never;
const accessControl = { canReadBatchAtRef: async () => new Map<string, boolean>() };
const BOT_ONLY = ['approve_change_request', 'apply_change_request'];
const READ_TOOLS = ['list_change_requests', 'get_change_request', 'list_change_request_files', 'list_change_request_reviews'];

async function manualOf(connection: ConnectionScope | undefined, route: '/agent/utcp' | '/agent/internal/utcp'): Promise<string[]> {
  const registry = new ToolRegistry();
  const router = express.Router();
  registerChangeRequestReadTools(registry, router, pass, handler, accessControl, testKbContext());
  registerChangeRequestApplyTools(registry, router, pass, handler, accessControl, testKbContext());
  const auth: express.RequestHandler = (req, _res, next) => {
    req.toolAuth = {
      source: route === '/agent/internal/utcp' ? 'internal' : 'external',
      userId: 'u-1',
      scope: 'write',
      ...(connection ? { connection } : {}),
    } as never;
    next();
  };
  const app = express();
  app.use('/api', createManualRoutes(registry, auth));
  // Each listing its own server, closed before the next one starts: a check
  // that asks several times leaves nothing listening behind it.
  const server = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api${route}`);
    return ((await res.json()) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('the bot-only tools in the manuals', () => {
  it.each(['/agent/utcp', '/agent/internal/utcp'] as const)('%s leaves them out for Myself, and keeps every other tool', async (route) => {
    for (const connection of [undefined, ConnectionScope.myself()]) {
      const names = await manualOf(connection, route);
      for (const tool of BOT_ONLY) expect(names).not.toContain(tool);
      for (const tool of READ_TOOLS) expect(names).toContain(tool);
    }
  });

  it.each(['/agent/utcp', '/agent/internal/utcp'] as const)('%s lists them for a bot, unless the distribution does not offer the bot them', async (route) => {
    const bot = { path: 'ops@agent.hexis', name: 'ops' };
    const all = await manualOf(ConnectionScope.asBot(bot, null, 'fp'), route);
    for (const tool of BOT_ONLY) expect(all).toContain(tool);
    const narrowed = await manualOf(ConnectionScope.asBot(bot, ['get_change_request'], 'fp'), route);
    expect(narrowed).toEqual(['get_change_request']);
  });
});
