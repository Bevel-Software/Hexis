/**
 * ripgrep is what the agents' `grep` tool searches with (`ripgrep-search.ts`),
 * and there is no other search to fall back on. So its absence is found at
 * boot, the way a git too old is (`git-version.ts`): by the deploy that
 * produced the broken image, never by the first agent that searches.
 *
 * The Hexis Dockerfile installs it from Debian (`ripgrep`); a server run from
 * source needs `rg` on its PATH.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../../shared/logging.js';

const log = logger('grep');

const execFileAsync = promisify(execFile);

/**
 * Run `rg --version`, log what answered, and throw a worded error naming the
 * binary when it cannot be run. Call once during startup.
 */
export async function assertRipgrep(): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('rg', ['--version']));
  } catch (err) {
    throw new Error(
      `ripgrep (\`rg\`) is required on the server's PATH but could not be run: ${String(err)}. ` +
        'The grep tool searches with it. The Hexis Dockerfile installs it (Debian package `ripgrep`); ' +
        'a server run from source needs ripgrep installed.',
    );
  }
  log.info(`search engine: ${stdout.split('\n')[0]!.trim()}`);
}
