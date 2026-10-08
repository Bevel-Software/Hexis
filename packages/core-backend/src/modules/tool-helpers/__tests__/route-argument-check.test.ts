import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolHandlerFactory } from '../tool-handler.js';
import { declareRouteTool, routeToolName, routeToolSchemas } from '../route-tool-schemas.js';
import { toolDef } from '../tool-def.js';
import type { ToolContext } from '../tool.contract.js';
import type { ToolAuth } from '../../tool-auth/tool-auth.middleware.js';

/**
 * The route's argument check at the level of the helper that runs it: what it
 * does with a tool nothing declared, what it leaves to the tool's own refusals,
 * and that it never touches the arguments of a call that matches.
 */

let server: HttpServer | undefined;
const calls: Array<Record<string, unknown>> = [];

afterEach(async () => {
  // A spy on `console.warn` is restored here, not at the end of its test, so
  // a failing assertion cannot leave warnings silenced for the rest of the file.
  vi.restoreAllMocks();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  calls.length = 0;
});

/** One route per tool name, mounted exactly as a module (or a deployment) mounts it. */
async function mount(...tools: string[]): Promise<string> {
  const toolHandler = createToolHandlerFactory(
    async (auth: ToolAuth, abortSignal: AbortSignal): Promise<ToolContext> =>
      ({ user: { id: 'u', email: 'e@x.io', name: 'N' }, scope: auth.scope, source: auth.source, abortSignal }) as unknown as ToolContext,
  );
  const app = express();
  app.use(express.json());
  for (const tool of tools) {
    app.post(
      `/api/agent/tools/${tool}`,
      (req, _res, next) => {
        req.toolAuth = { source: 'external', userId: 'u', scope: 'write' };
        next();
      },
      toolHandler(async (args) => {
        calls.push(args);
        return { ran: tool, args };
      }),
    );
  }
  server = await new Promise<HttpServer>((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

const post = (base: string, tool: string, body: unknown) =>
  fetch(`${base}/api/agent/tools/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
    body: JSON.stringify(body),
  });

describe('routeToolName', () => {
  it('is the last segment of the route, query and trailing slash aside', () => {
    expect(routeToolName('/api/agent/tools/write_file')).toBe('write_file');
    expect(routeToolName('/agent/tools/grep/')).toBe('grep');
    expect(routeToolName('/api/agent/tools/grep?x=1')).toBe('grep');
    expect(routeToolName('/')).toBe('');
  });
});

describe('a tool declared with `toolDef`', () => {
  it('is checked by its route without the module saying so', async () => {
    toolDef({
      name: 'declared_by_tooldef',
      description: 'A tool a deployment adds.',
      path: '/api/agent/tools/declared_by_tooldef',
      inputs: {
        type: 'object',
        properties: { q: { type: 'string', description: 'What to look for.' } },
        required: ['q'],
        additionalProperties: false,
      },
    });
    const base = await mount('declared_by_tooldef');
    const res = await post(base, 'declared_by_tooldef', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; kind: string };
    expect(body.kind).toBe('arguments-do-not-match');
    expect(body.error).toContain('"q" is required, and was not given.');
    expect(body.error).toContain('q (string, required) — What to look for.');
    expect(body.error.split('\n').pop()).toBe('Call: KNOWLEDGE_BASE.declared_by_tooldef({ body: { q: "..." } })');
    expect(calls).toEqual([]);
  });

  it('receives a matching call with exactly the arguments that were sent', async () => {
    toolDef({
      name: 'untouched_arguments',
      description: 'A tool that reports what it was given.',
      path: '/api/agent/tools/untouched_arguments',
      inputs: {
        type: 'object',
        properties: { q: { type: 'string' }, limit: { type: 'integer' }, deep: { type: 'object', properties: {} } },
        required: ['q'],
        additionalProperties: false,
      },
    });
    const base = await mount('untouched_arguments');
    const sent = { q: 'hello', limit: 3, deep: { a: 1 } };
    const res = await post(base, 'untouched_arguments', sent);
    expect(res.status).toBe(200);
    expect(calls).toEqual([sent]);
    expect(Object.keys(calls[0])).toEqual(['q', 'limit', 'deep']);
  });
});

describe('a tool with nothing to check against', () => {
  it('is called unchecked, and the reason is logged once for that tool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = await mount('nobody_declared_me');
    expect((await post(base, 'nobody_declared_me', { whatever: 1 })).status).toBe(200);
    expect((await post(base, 'nobody_declared_me', { whatever: 1 })).status).toBe(200);
    expect(calls).toHaveLength(2);
    const mine = warn.mock.calls.filter((c) => c.join(' ').includes('nobody_declared_me'));
    expect(mine).toHaveLength(1);
    expect(mine[0].join(' ')).toContain('no input schema is declared for its route');
  });

  it('is called unchecked when the schema uses a keyword the check cannot reason about', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    declareRouteTool('uncheckable_schema', { anyOf: [{ type: 'object' }, { type: 'string' }] } as never);
    const base = await mount('uncheckable_schema');
    expect((await post(base, 'uncheckable_schema', { anything: true })).status).toBe(200);
    const mine = warn.mock.calls.filter((c) => c.join(' ').includes('uncheckable_schema'));
    expect(mine).toHaveLength(1);
    expect(mine[0].join(' ')).toContain('anyOf');
  });
});

describe('a call made in the wrong shape', () => {
  it('refuses a flat call to a tool whose arguments are all optional, instead of running it on defaults', async () => {
    // Over the http protocol a flat call's arguments ride the query string
    // and the body is empty — which matches an all-optional tool as `{}`.
    declareRouteTool('all_optional', {
      type: 'object',
      properties: { branch: { type: 'string' }, limit: { type: 'integer' } },
      additionalProperties: false,
    } as never);
    const base = await mount('all_optional');
    const res = await fetch(`${base}/api/agent/tools/all_optional?branch=main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { kind: string; error: string };
    expect(body.kind).toBe('arguments-do-not-match');
    expect(body.error).toContain('This tool takes its arguments under "body", not at the top level.');
    expect(calls).toHaveLength(0);
  });

  it('refuses a flat call to a tool that requires a branch the same way, rather than as a missing branch', async () => {
    declareRouteTool('flat_with_branch', {
      type: 'object',
      properties: { branch: { type: 'string' }, path: { type: 'string' } },
      required: ['branch', 'path'],
      additionalProperties: false,
    } as never);
    const base = await mount('flat_with_branch');
    const res = await fetch(`${base}/api/agent/tools/flat_with_branch?branch=main&path=a.md`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error.split('\n')[1]).toBe(
      'This tool takes its arguments under "body", not at the top level.',
    );
  });
});

describe('a call whose URL also carries a query string', () => {
  it('runs when the body supplies the argument the query string repeats', async () => {
    declareRouteTool('query_echo', {
      type: 'object',
      properties: { branch: { type: 'string' }, limit: { type: 'integer' } },
      additionalProperties: false,
    } as never);
    const base = await mount('query_echo');
    const res = await fetch(`${base}/api/agent/tools/query_echo?branch=main`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer k' },
      body: JSON.stringify({ branch: 'main', limit: 2 }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ branch: 'main', limit: 2 }]);
  });
});

describe('routes that overlap', () => {
  it('check a request against the route that fits it best, not the one declared first', async () => {
    toolDef({
      name: 'short_overlap',
      description: 'Declared at the shorter route, first.',
      path: '/overlap_tool',
      inputs: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
    });
    toolDef({
      name: 'overlap_tool',
      description: 'Declared at the longer route, second.',
      path: '/api/agent/tools/overlap_tool',
      inputs: { type: 'object', properties: { b: { type: 'string' } }, required: ['b'], additionalProperties: false },
    });
    const base = await mount('overlap_tool');
    expect((await post(base, 'overlap_tool', { b: 'x' })).status).toBe(200);
    const res = await post(base, 'overlap_tool', { a: 'x' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('The arguments do not match the "overlap_tool" tool.');
  });
});

describe('a tool whose route does not end in its name', () => {
  it('is found by its route and checked under its own name', async () => {
    toolDef({
      name: 'named_apart',
      description: 'A tool hosted at a route of another name.',
      path: '/api/things/personal',
      inputs: { type: 'object', properties: {}, additionalProperties: false },
    });
    const toolHandler = createToolHandlerFactory(
      async (auth: ToolAuth, abortSignal: AbortSignal): Promise<ToolContext> =>
        ({ user: { id: 'u' }, scope: auth.scope, source: auth.source, abortSignal }) as unknown as ToolContext,
    );
    const app = express();
    app.use(express.json());
    // Mounted on a router, as the modules mount theirs: the handler sees only
    // the part of the path below `/api`, and must still find the tool.
    const router = express.Router();
    router.post(
      '/things/personal',
      (req, _res, next) => {
        req.toolAuth = { source: 'external', userId: 'u', scope: 'write' };
        next();
      },
      toolHandler(async (args) => {
        calls.push(args);
        return { ok: true };
      }),
    );
    app.use('/api', router);
    server = await new Promise<HttpServer>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const res = await fetch(`${base}/api/things/personal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stray: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('The arguments do not match the "named_apart" tool.');
    expect(body.error).toContain('"stray" is not an argument of this tool.');
    expect(calls).toHaveLength(0);
  });
});

describe('what the check says nothing about', () => {
  it('leaves `branch` to the one refusal that names it — absent, empty or a stringified nothing', async () => {
    declareRouteTool('needs_a_branch', {
      type: 'object',
      properties: { branch: { type: 'string' }, path: { type: 'string' } },
      required: ['branch', 'path'],
      additionalProperties: false,
    } as never);
    const base = await mount('needs_a_branch');
    for (const branch of [undefined, '', null, 42, ['main'], 'undefined', 'null']) {
      const res = await post(base, 'needs_a_branch', { path: 'a.md', ...(branch === undefined ? {} : { branch }) });
      // Forwarded, so the handler's own `branch-required` answers — and with a
      // valid branch the same call would be checked like any other.
      expect(res.status, String(branch)).toBe(200);
    }
    expect(calls).toHaveLength(7);
  });

  it('leaves an argument the tool refuses by name to the tool', async () => {
    toolDef({
      name: 'refuses_its_own_name',
      description: 'A tool with a refusal of its own.',
      path: '/api/agent/tools/refuses_its_own_name',
      inputs: {
        type: 'object',
        properties: { name: { type: 'string' }, other: { type: 'string' } },
        required: ['name', 'other'],
        additionalProperties: false,
      },
      refusesItself: ['name'],
    });
    expect(routeToolSchemas('refuses_its_own_name')?.refusesItself.has('name')).toBe(true);
    const base = await mount('refuses_its_own_name');
    // Only `name` is missing: forwarded, so the tool's own message answers.
    expect((await post(base, 'refuses_its_own_name', { other: 'o' })).status).toBe(200);
    // `other` is missing too, and that one IS reported.
    const res = await post(base, 'refuses_its_own_name', { name: 'n' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('"other" is required, and was not given.');
    expect(body.error).not.toContain('"name" is required');
  });
});
