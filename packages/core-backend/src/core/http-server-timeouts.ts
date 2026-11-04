import type { Server as HttpServer } from 'node:http';

/**
 * How long the server keeps an idle kept-alive connection open: 120 seconds.
 *
 * Node's default is 5 seconds. A reverse proxy keeps its connections to the
 * backend idle for much longer (Traefik 90 s, nginx and AWS ALB 60 s), so
 * between the server's 5 seconds and the proxy's limit the proxy holds a
 * socket the server already closed. The next request it sends there fails
 * with a reset, and a POST with a body (an MCP call among them) is never
 * retried: the client sees a dropped connection or a 502. 120 seconds is
 * longer than the default pools of the proxies above, so with their defaults
 * the proxy lets go first. A proxy configured with a longer idle pool must be
 * set below this value, or the same reset returns.
 */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 120_000;

/**
 * Applies the core's connection timeouts to a listening server and returns
 * it, so a shell can wrap its `app.listen(...)` call.
 *
 * Only `keepAliveTimeout` is set. Node derives the `Keep-Alive: timeout=`
 * response header from it, so nothing writes that header by hand. The
 * headers timeout and the request timeout keep Node's defaults on purpose:
 * they govern a request in flight, not an idle socket (verified 2026-11-03:
 * the headers timeout does not cut an idle kept-alive connection). Idle
 * sockets are still closed on a stop by the shutdown sequence's
 * `closeAllConnections`.
 */
export function applyHttpServerTimeouts<S extends Pick<HttpServer, 'keepAliveTimeout'>>(server: S): S {
  server.keepAliveTimeout = HTTP_KEEP_ALIVE_TIMEOUT_MS;
  return server;
}
