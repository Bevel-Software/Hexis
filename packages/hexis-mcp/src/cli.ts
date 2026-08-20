#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, USAGE, resolveConfig, type HexisMcpConfig } from './config.js';
import { DeploymentError, resolveMcpUrl } from './deployment.js';
import { OAuthError, establishOAuthConfig } from './oauth.js';
import { createHexisMcpServer } from './server.js';
import { beginOrderlyExit, makeExitAfterShutdown, type ShutdownHolder } from './teardown.js';

/**
 * stdio is the protocol channel: anything written to stdout that is not a
 * JSON-RPC message corrupts the stream and the client drops the connection.
 * Every diagnostic in this package therefore goes to stderr, which MCP clients
 * collect as server logs.
 */
function packageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf-8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(USAGE);
    return;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    process.stderr.write(`${packageVersion()}\n`);
    return;
  }

  const resolved = resolveConfig(argv, process.env);
  let config: HexisMcpConfig;
  if (resolved.connectionKey !== undefined) {
    // Key mode: autonomous, exactly the pre-OAuth behavior.
    config = { baseUrl: resolved.baseUrl, connectionKey: resolved.connectionKey };
  } else {
    // No key = browser sign-in. Discovery starts from the deployment's OWN
    // MCP endpoint; `/api/config` is unauthenticated, so resolving it needs
    // no credential — which is the point: none exists yet.
    const mcpUrl = await resolveMcpUrl({ baseUrl: resolved.baseUrl, connectionKey: '' });
    config = await establishOAuthConfig(resolved.baseUrl, mcpUrl, { noOpen: resolved.noOpen });
  }
  // Deterministic teardown, on every way an MCP client lets go of us: stdin
  // EOF/close (the client hung up), SIGINT, SIGTERM. Killing this process
  // does NOT kill its grandchildren on Windows — only the transports' close()
  // inside `shutdown()` does — and an orphaned stdio server keeps its cwd
  // inside the materialized plugin root, holding it hostage (EBUSY) for every
  // later instance. So the spawned servers must die WITH this process, not be
  // left to a stdin-pipe EOF cascade that observably leaks.
  //
  // Installed BEFORE `createHexisMcpServer`, because the children spawn
  // DURING it: a client that hangs up (or a Ctrl+C) mid-startup used to land
  // in a window with no handler at all, leaving exactly the orphans the
  // teardown exists to prevent. Until the handle exists there is nothing
  // reachable to close — the UTCP client lives inside the create call — so an
  // early let-go only RECORDS the request (plus a bounded force-exit, for a
  // create that never resolves); the moment create resolves, main() sees it
  // and shuts the freshly built handle down immediately. The states live in
  // teardown.ts, where the unit tests can reach them.
  const holder: ShutdownHolder = { shutdown: null, exitRequested: false, exiting: false };
  const exitAfterShutdown = makeExitAfterShutdown(holder);
  process.stdin.on('end', exitAfterShutdown);
  process.stdin.on('close', exitAfterShutdown);
  process.on('SIGINT', exitAfterShutdown);
  process.on('SIGTERM', exitAfterShutdown);

  try {
    const { server, shutdown } = await createHexisMcpServer(config, packageVersion());
    holder.shutdown = shutdown;
    if (holder.exitRequested) {
      // The client let go while we were starting up: close what was just built
      // — children included — and leave, without ever connecting the transport.
      // Through the same bounded path the handler uses: a hung close must not
      // keep the children alive forever.
      beginOrderlyExit(holder);
      return;
    }
    await server.connect(new StdioServerTransport());
  } catch (err) {
    // Startup failed with the let-go listeners already armed. They must not
    // stay that way: the signal handlers alone would hold this dead-on-arrival
    // process open forever, and a later hang-up would exit 0 over a failure.
    // Close whatever was built — children included — and let the rejection
    // reach main().catch, which reports it. The status is recorded HERE, not
    // only there, so a let-go racing this very failure already sees it.
    process.exitCode = 1;
    process.stdin.off('end', exitAfterShutdown);
    process.stdin.off('close', exitAfterShutdown);
    process.off('SIGINT', exitAfterShutdown);
    process.off('SIGTERM', exitAfterShutdown);
    await holder.shutdown?.();
    throw err;
  }
}

main().catch((err: unknown) => {
  // A startup failure the person can act on (bad URL, dead key, unreachable
  // deployment) prints its own message and nothing else; an unexpected one
  // keeps its stack, because that is a bug report.
  if (err instanceof ConfigError || err instanceof DeploymentError || err instanceof OAuthError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
