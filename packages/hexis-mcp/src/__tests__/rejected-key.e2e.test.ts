import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * END-TO-END: a rejected connection key ends the CLI with one plain sentence.
 *
 * The real CLI runs as a child process against a stub deployment that answers
 * `/api/config` and refuses every key-authenticated request the way the
 * deployment does (401, `invalid_token`, no `resource_metadata`). What this
 * pins: the sentence reaches stderr, the exit code is non-zero, the key is
 * never printed, and no browser sign-in is attempted — the stub records every
 * request, and none of them may touch discovery or the OAuth endpoints.
 */

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BAD_KEY = 'bevel_revokedKeyThatMustNeverBePrinted';

/** tsx is not this package's dependency; borrow the workspace's copy to run src/cli.ts directly. */
function resolveTsxLoader(): string {
  const repoRoot = path.resolve(pkgDir, '..', '..');
  return createRequire(path.join(repoRoot, 'packages', 'core-backend', 'package.json')).resolve('tsx');
}

let stub: http.Server;
let base = '';
let home = '';
const requests: string[] = [];

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'hexis-rejected-key-'));
  stub = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/api/config') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mcpUrl: `${base}/api/mcp`, agentInstructions: true }));
      return;
    }
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token", error_description="Invalid or revoked connection key"');
    res.end(JSON.stringify({ error: 'Invalid or revoked connection key. Mint a new one in External agent access.' }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
});

afterAll(async () => {
  // A CLI that regressed into hanging holds a keep-alive socket to the stub;
  // close() alone would wait on it forever and stall the whole suite.
  stub.closeAllConnections?.();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  await fs.rm(home, { recursive: true, force: true });
});

describe('a rejected connection key', () => {
  it('prints the sentence, exits non-zero, and never starts a browser sign-in', { timeout: 60_000 }, async () => {
    const cli = spawn(
      process.execPath,
      ['--import', pathToFileURL(resolveTsxLoader()).href, path.join(pkgDir, 'src', 'cli.ts'), '--url', base, '--key', BAD_KEY],
      // HEXIS_NO_BROWSER keeps a regression from opening a real browser here;
      // the request log below is what proves no sign-in was attempted.
      { cwd: pkgDir, env: { ...process.env, HEXIS_HOME: home, HEXIS_NO_BROWSER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    cli.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    cli.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    let code: number | null;
    try {
      code = await new Promise<number | null>((resolve) => cli.once('exit', (c) => resolve(c)));
    } finally {
      // Reaps a CLI that hangs instead of exiting, so the timeout fails this
      // test rather than leaving an orphan behind the suite.
      if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGKILL');
    }

    const sentence =
      `The connection key was rejected by ${base}. Mint a new one in External agent access. ` +
      '(Claude Code hides this message; run `claude mcp get <name>` or start the command in a terminal to see it.)';
    expect(code, stderr).not.toBe(0);
    // The fatal line is the process's last word.
    expect(stderr.trimEnd().split('\n').at(-1)).toBe(sentence);
    expect(stderr).not.toContain(BAD_KEY);
    expect(stdout).toBe('');

    expect(requests).toContain('GET /api/config');
    for (const r of requests) {
      expect(r).not.toMatch(/well-known|\/authorize|\/token|\/register|local-token/);
    }
  });
});
