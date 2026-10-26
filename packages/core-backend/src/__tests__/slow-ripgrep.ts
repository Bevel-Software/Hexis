import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

/**
 * A ripgrep that never finishes a TREE search, for the suites about the
 * search budget and about stopping: an `rg` put first on this process's PATH,
 * where the server finds its ripgrep. A run reading stdin (the pattern check,
 * a document's text) is handed to the real `rg`, so a pattern is judged as it
 * always is; a walk records its process id and sleeps for a minute, which no
 * budget waits out — or, given `walkMs`, sleeps that long and then finishes
 * having found nothing, which is how a suite spends a budget in parts.
 *
 * `alive()` answers which of the walks it started are still running, so a
 * suite can assert that a stopped search left no process behind. `remove()`
 * puts the PATH back.
 */
export interface SlowRipgrep {
  alive(): Promise<number[]>;
  remove(): Promise<void>;
}

export async function slowRipgrep(opts: { walkMs?: number } = {}): Promise<SlowRipgrep> {
  const seconds = opts.walkMs === undefined ? '60' : (opts.walkMs / 1000).toFixed(3);
  const real = (await promisify(execFile)('sh', ['-c', 'command -v rg'])).stdout.trim();
  const dir = await mkdtemp(join(tmpdir(), 'slow-rg-'));
  const pids = join(dir, 'pids');
  const binary = join(dir, 'rg');
  await writeFile(
    binary,
    [
      '#!/bin/sh',
      'for a in "$@"; do last="$a"; done',
      `if [ "$last" = "-" ]; then exec '${real}' "$@"; fi`,
      `echo $$ >> '${pids}'`,
      `exec sleep ${seconds}`,
      '',
    ].join('\n'),
  );
  await chmod(binary, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path ?? ''}`;
  return {
    async alive() {
      const started = (await readFile(pids, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map(Number);
      return started.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    },
    async remove() {
      process.env.PATH = path;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
