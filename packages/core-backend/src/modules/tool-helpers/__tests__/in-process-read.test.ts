import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { createInProcessToolCaller, createToolHandlerFactory, type HostedRead } from '../tool-handler.js';
import { ToolError, type ToolContext } from '../tool.contract.js';
import type { ResolveToolContext } from '../tool-context.js';
import type { ToolAuth } from '../../tool-auth/index.js';
import { ConnectionScope, NOT_AVAILABLE_TO_CONNECTION } from '../../agent-scope/index.js';

/**
 * A hosted discovery read called as a function runs what its route runs once
 * the route's auth has passed: the caller's context, the connection's scope,
 * then the handler. Each test puts the route and the in-process call side by
 * side, on one handler and one context resolver.
 */

let server: HttpServer | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

const AGENT = 'Agents/narrow.agent';

/** A connection whose agent loads `platformTools`, and nothing else. */
const narrowedTo = (platformTools: string[]) =>
  ConnectionScope.narrowed({ path: AGENT, name: 'narrow' }, { skills: [], connectors: [], platformTools }, 'fingerprint');

interface Seen {
  args: Record<string, unknown>;
  email: string;
  scope: ConnectionScope | undefined;
}

/**
 * The read `list_things`, hosted on a route and callable in process. `scopeOf`
 * is what the context resolver answers for a credential: a scope, or none (a
 * resolver that knows nothing of agents).
 */
async function start(opts: { scopeOf?: (auth: ToolAuth) => ConnectionScope | undefined; discovery?: boolean } = {}) {
  const seen: Seen[] = [];
  const resolve: ResolveToolContext = async (auth, abortSignal, sessionId) =>
    ({
      user: { id: auth.userId, email: `${auth.userId}@example.com`, name: auth.userId },
      scope: auth.scope,
      source: auth.source,
      tokenId: auth.tokenId,
      sessionId,
      abortSignal,
      connectionScope: opts.scopeOf?.(auth),
    }) as unknown as ToolContext;
  const read: HostedRead = {
    name: 'list_things',
    options: { discovery: opts.discovery === true },
    handler: async (args, ctx) => {
      seen.push({ args, email: ctx.user.email, scope: ctx.connectionScope });
      return { things: ['a', 'b'], for: ctx.user.email, asked: args };
    },
  };
  const toolHandler = createToolHandlerFactory(resolve);
  let auth: ToolAuth | undefined;
  const app = express();
  app.use(express.json());
  app.post(
    '/api/agent/tools/list_things',
    (req, _res, next) => {
      req.toolAuth = auth;
      next();
    },
    toolHandler(read.handler, read.options),
  );
  server = await new Promise<HttpServer>((res) => {
    const s = app.listen(0, () => res(s));
  });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const overHttp = async (as: ToolAuth, body: Record<string, unknown> = {}) => {
    auth = as;
    const res = await fetch(`${base}/api/agent/tools/list_things`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { seen, overHttp, inProcess: createInProcessToolCaller(resolve)(read) };
}

const caller = (over: Partial<ToolAuth> = {}): ToolAuth => ({ source: 'external', userId: 'ada', scope: 'write', ...over });

/** What an in-process call threw, as the route would have answered it. */
const refusalOf = async (call: Promise<unknown>) => {
  const err = await call.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ToolError);
  const refusal = err as ToolError;
  return { status: refusal.status, body: { ...refusal.details, error: refusal.message } };
};

describe('a hosted read called in process', () => {
  it('answers what its route answers, from the same handler and the same context', async () => {
    const { seen, overHttp, inProcess } = await start();
    const route = await overHttp(caller(), { kind: 'x' });
    const direct = await inProcess(caller(), { kind: 'x' });

    expect(route.status).toBe(200);
    expect(direct).toEqual(route.body);
    expect(seen.map((s) => s.email)).toEqual(['ada@example.com', 'ada@example.com']);
    expect(seen.map((s) => s.args)).toEqual([{ kind: 'x' }, { kind: 'x' }]);
  });

  it('takes no arguments as none', async () => {
    const { seen, inProcess } = await start();
    await inProcess(caller());
    expect(seen[0]!.args).toEqual({});
  });

  it('hands the handler the scope the caller connects with: Everything for a credential with no agent', async () => {
    const { seen, inProcess } = await start();
    await inProcess(caller());
    expect(seen[0]!.scope?.toWire()).toBeUndefined();
    expect(seen[0]!.scope?.allowsPlatformTool('anything')).toBe(true);
  });

  // A resolver that knows nothing of agents answers no scope. A credential
  // that names an agent is then refused, never served Everything.
  it('refuses a credential that names an agent when the context carries no scope, as its route does', async () => {
    const { seen, overHttp, inProcess } = await start();
    const route = await overHttp(caller({ agentPath: AGENT }));
    expect(route.status).toBe(403);
    expect(route.body.code).toBe(NOT_AVAILABLE_TO_CONNECTION);
    expect(await refusalOf(inProcess(caller({ agentPath: AGENT })))).toEqual(route);
    expect(seen).toEqual([]);
  });

  it('refuses a read the connection does not list, by the route\'s own words, and does not run it', async () => {
    const { seen, overHttp, inProcess } = await start({ scopeOf: () => narrowedTo(['read_file']) });
    const route = await overHttp(caller({ agentPath: AGENT }));
    expect(route.status).toBe(403);
    expect(String(route.body.error)).toContain('list_things');
    expect(await refusalOf(inProcess(caller({ agentPath: AGENT })))).toEqual(route);
    expect(seen).toEqual([]);
  });

  it('runs a read the connection lists, narrowed to that connection', async () => {
    const { seen, overHttp, inProcess } = await start({ scopeOf: () => narrowedTo(['list_things']) });
    const route = await overHttp(caller({ agentPath: AGENT }));
    expect(route.status).toBe(200);
    expect(await inProcess(caller({ agentPath: AGENT }))).toEqual(route.body);
    expect(seen.map((s) => s.scope?.toWire()?.agent.path)).toEqual([AGENT, AGENT]);
  });

  // A discovery read is how the connection's own surface is read (its skills,
  // its connectors), so it is answered a connection that does not list it as a
  // tool. A connection that loads nothing is refused it like every other read.
  it('runs a discovery read for a connection that does not list it, and refuses one that loads nothing', async () => {
    const listsOther = await start({ scopeOf: () => narrowedTo(['read_file']), discovery: true });
    const route = await listsOther.overHttp(caller({ agentPath: AGENT }));
    expect(route.status).toBe(200);
    expect(await listsOther.inProcess(caller({ agentPath: AGENT }))).toEqual(route.body);
    await new Promise<void>((r) => server!.close(() => r()));

    const loadsNothing = await start({ scopeOf: () => ConnectionScope.gone(AGENT), discovery: true });
    const refused = await loadsNothing.overHttp(caller({ agentPath: AGENT }));
    expect(refused.status).toBe(403);
    expect(await refusalOf(loadsNothing.inProcess(caller({ agentPath: AGENT })))).toEqual(refused);
    expect(loadsNothing.seen).toEqual([]);
  });

  it('throws on what the handler throws, and what the context resolver throws', async () => {
    const boom = new ToolError('The catalog is being rebuilt.', 503);
    const failing: HostedRead = {
      name: 'list_things',
      options: {},
      handler: async () => {
        throw boom;
      },
    };
    const resolve = (async () => ({ user: { email: 'ada@example.com' } })) as unknown as ResolveToolContext;
    await expect(createInProcessToolCaller(resolve)(failing)(caller())).rejects.toBe(boom);

    const gone = new ToolError('Your account is no longer available.', 401);
    const noAccount = (async () => {
      throw gone;
    }) as unknown as ResolveToolContext;
    const never: HostedRead = { name: 'list_things', options: {}, handler: async () => ({ ran: true }) };
    await expect(createInProcessToolCaller(noAccount)(never)(caller())).rejects.toBe(gone);
  });

  it('refuses a tool that streams its answer: it is for reads that answer a value', async () => {
    const streaming: HostedRead = {
      name: 'list_things',
      options: {},
      handler: async function* () {
        yield { chunk: 1 };
      },
    };
    const resolve = (async () => ({ user: { email: 'ada@example.com' } })) as unknown as ResolveToolContext;
    await expect(createInProcessToolCaller(resolve)(streaming)(caller())).rejects.toThrow('streams its answer');
  });
});
