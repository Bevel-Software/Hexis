import type { Server as HttpServer } from 'node:http';
import type { RequestHandler } from 'express';
import express from 'express';
import { createMcpRoutes } from '../mcp.routes.js';

/**
 * The shared mount for every `createMcpRoutes` suite.
 *
 * Three suites exercise different slices of this router — the transport's
 * session routing, the connection-key routes, the local-token exchange — and
 * each had grown its own copy of the same scaffolding: a `fakeAuth` stand-in,
 * an `app.listen(0)` plus `afterEach` close, and the eight-argument
 * `createMcpRoutes` call with stubs in every position the suite does not care
 * about. Three copies meant a signature change had three places to patch, and
 * they had already drifted from one another.
 *
 * Not collected by vitest: the include pattern is `**\/*.test.ts`, and this is
 * not a test file.
 */

/**
 * Auth stand-in binding the user named by `x-test-user`, defaulting to user-A.
 *
 * The header lets a suite act as a second user (the cross-user checks need
 * one); suites that never send it see the single fixed user their assertions
 * were written against.
 */
export const fakeAuth: RequestHandler = (req, _res, next) => {
  req.userId = (req.headers['x-test-user'] as string | undefined) ?? 'user-A';
  next();
};

/**
 * The collaborators a suite actually cares about. Anything omitted is stubbed:
 * `createMcpRoutes` only dereferences a dependency inside the handler that
 * needs it, so a suite that never calls that route never touches the stub.
 */
export interface McpRoutesDeps {
  mcpService?: unknown;
  externalApiKeyService?: unknown;
  llmUsageService?: unknown;
  internalTokens?: unknown;
  oauthProvider?: unknown;
  resourceMetadataUrl?: string;
}

/** Servers opened by `mountMcpRoutes`, closed together by `closeMountedRoutes`. */
const openServers = new Set<HttpServer>();

/**
 * Mount the router on an ephemeral port; returns its base URL. Every mount is
 * tracked, so a suite's teardown is one `closeMountedRoutes()` regardless of
 * how many it opened.
 */
export async function mountMcpRoutes(deps: McpRoutesDeps = {}): Promise<string> {
  const stub = {} as never;
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    createMcpRoutes(
      // `createMcpRoutes` calls `onSessionEvicted` at CONSTRUCTION, so unlike
      // the others this one needs a real function even when unused.
      (deps.mcpService ?? { onSessionEvicted: () => {} }) as never,
      (deps.externalApiKeyService ?? stub) as never,
      fakeAuth,
      fakeAuth,
      (deps.llmUsageService ?? stub) as never,
      (deps.internalTokens ?? stub) as never,
      (deps.oauthProvider ?? stub) as never,
      deps.resourceMetadataUrl ?? '',
    ),
  );
  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  openServers.add(server);
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}`;
}

/** Close every server this harness opened. Safe to call when none are open. */
export async function closeMountedRoutes(): Promise<void> {
  const servers = [...openServers];
  openServers.clear();
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
}
