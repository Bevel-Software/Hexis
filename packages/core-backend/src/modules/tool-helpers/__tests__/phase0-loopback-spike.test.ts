import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import '@utcp/http'; // registers the http CallTemplate serializer + protocol
import { HttpCallTemplateSerializer } from '@utcp/http';
import { CodeModeUtcpClient } from '../../code-mode/index.js';

const httpTemplate = new HttpCallTemplateSerializer();

/**
 * PHASE 0 SPIKE (gates the unified-registry plan): prove the agent's INTERNAL
 * execution model works — a real `CodeModeUtcpClient` discovers an HTTP UTCP
 * manual over loopback and calls its tools from inside `call_tool_chain`, with a
 * bearer token resolved from per-client config. Also benchmark per-op loopback
 * latency (R1). This mirrors what each agent turn will do against the internal
 * manual endpoint. Throwaway once the real registry e2e lands.
 */

const MANUAL = 'bevel';

// The internal UTCP manual a module-hosted endpoint would serve. Tools use the
// `{body}` wrapper (body_field:'body') so multi-field args ride the JSON body —
// the only standard-http way to do that (verified in @utcp/http callTool).
function manual(): unknown {
  const httpTool = (name: string, bodyProps: Record<string, unknown>) => ({
    name,
    description: `the ${name} tool`,
    inputs: {
      type: 'object',
      properties: { body: { type: 'object', properties: bodyProps } },
      required: ['body'],
    },
    outputs: { type: 'object', properties: {} },
    tags: [],
    tool_call_template: {
      call_template_type: 'http',
      http_method: 'POST',
      url: `\${API_URL}/api/agent/tools/${name}`,
      content_type: 'application/json',
      headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
      body_field: 'body',
    },
  });
  return {
    utcp_version: '1.1.0',
    manual_version: '1.0.0',
    tools: [httpTool('list_branches', {}), httpTool('echo', { msg: { type: 'string' } })],
  };
}

let httpServer: HttpServer | undefined;
let seenAuth: string | undefined;

async function startApp(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.get('/api/agent/internal/utcp', (_req, res) => res.json(manual()));
  app.post('/api/agent/tools/list_branches', (req, res) => {
    seenAuth = req.headers.authorization;
    res.json({ branches: ['current-company-state', 'target-company-state'] });
  });
  app.post('/api/agent/tools/echo', (req, res) => {
    res.json({ echoed: (req.body as { msg?: string })?.msg ?? null });
  });
  httpServer = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (httpServer.address() as { port: number }).port;
  return `http://127.0.0.1:${port}`;
}

async function buildClient(baseUrl: string, token: string): Promise<CodeModeUtcpClient> {
  // Per-client config carries the loopback base URL + the scoped token under the
  // manual namespace (`<MANUAL>_API_URL` / `<MANUAL>_CONNECTION_KEY`).
  const client = await CodeModeUtcpClient.create(process.cwd(), {
    variables: { [`${MANUAL}_API_URL`]: baseUrl, [`${MANUAL}_CONNECTION_KEY`]: token },
  } as never);
  await client.registerManual(
    httpTemplate.validateDict({
      name: MANUAL,
      call_template_type: 'http',
      http_method: 'GET',
      url: '${API_URL}/api/agent/internal/utcp',
      content_type: 'application/json',
      headers: { Authorization: 'Bearer ${CONNECTION_KEY}' },
    }),
  );
  return client;
}

afterEach(async () => {
  if (httpServer) await new Promise<void>((r) => httpServer!.close(() => r()));
  httpServer = undefined;
  seenAuth = undefined;
});

describe('Phase 0 — internal loopback execution', () => {
  it('discovers an http manual and calls its tools from inside call_tool_chain', async () => {
    const base = await startApp();
    const client = await buildClient(base, 'internal-token-abc');

    const tools = await client.getTools();
    expect(tools.map((t) => t.name).sort()).toEqual([`${MANUAL}.echo`, `${MANUAL}.list_branches`]);

    const { result } = await client.callToolChain(
      `return { a: ${MANUAL}.list_branches({ body: {} }), b: ${MANUAL}.echo({ body: { msg: 'hi' } }) };`,
      20_000,
    );
    expect(result.a).toEqual({ branches: ['current-company-state', 'target-company-state'] });
    expect(result.b).toEqual({ echoed: 'hi' });
    // The per-client token reached the loopback endpoint.
    expect(seenAuth).toBe('Bearer internal-token-abc');
  });

  it('benchmark: per-op loopback latency inside a code-mode loop', async () => {
    const base = await startApp();
    const client = await buildClient(base, 'tok');
    const N = 30;
    const t0 = performance.now();
    const { result } = await client.callToolChain(
      `let n = 0; for (let i = 0; i < ${N}; i++) { ${MANUAL}.echo({ body: { msg: 'x' } }); n++; } return n;`,
      30_000,
    );
    const ms = performance.now() - t0;
    expect(result).toBe(N);
    // eslint-disable-next-line no-console
    console.log(`[phase0] ${N} loopback tool calls in one code-mode chain: ${ms.toFixed(0)}ms total, ${(ms / N).toFixed(1)}ms/op`);
  });
});
