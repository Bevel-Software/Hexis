#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigError, USAGE, resolveConfig } from './config.js';
import { DeploymentError } from './deployment.js';
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

  const config = resolveConfig(argv, process.env);
  const server = await createHexisMcpServer(config, packageVersion());
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // A startup failure the person can act on (bad URL, dead key, unreachable
  // deployment) prints its own message and nothing else; an unexpected one
  // keeps its stack, because that is a bug report.
  if (err instanceof ConfigError || err instanceof DeploymentError) {
    process.stderr.write(`${err.message}\n`);
  } else {
    console.error(err);
  }
  process.exitCode = 1;
});
