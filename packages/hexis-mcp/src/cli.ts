#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, USAGE, resolveConfig, type HexisMcpConfig } from './config.js';
import { DeploymentError, resolveMcpUrl } from './deployment.js';
import { OAuthError, establishOAuthConfig } from './oauth.js';
import { createHexisMcpServer } from './server.js';

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
  const { server, shutdown } = await createHexisMcpServer(config, packageVersion());
  await server.connect(new StdioServerTransport());

  // Deterministic teardown, on every way an MCP client lets go of us: stdin
  // EOF/close (the client hung up), SIGINT, SIGTERM. Killing this process
  // does NOT kill its grandchildren on Windows — only the transports' close()
  // inside `shutdown()` does — and an orphaned stdio server keeps its cwd
  // inside the materialized plugin root, holding it hostage (EBUSY) for every
  // later instance. So the spawned servers must die WITH this process, not be
  // left to a stdin-pipe EOF cascade that observably leaks.
  let exiting = false;
  const exitAfterShutdown = (): void => {
    if (exiting) return; // 'end' then 'close' both fire; signals can repeat
    exiting = true;
    void shutdown().finally(() => process.exit(0));
  };
  process.stdin.on('end', exitAfterShutdown);
  process.stdin.on('close', exitAfterShutdown);
  process.on('SIGINT', exitAfterShutdown);
  process.on('SIGTERM', exitAfterShutdown);
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
