import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentIdentity } from './handshake.js';

/**
 * Who spawned this process — a GUESS, for a client that names itself to
 * nobody in its MCP handshake (handshake.ts holds the identity that is not a
 * guess). Before this, such a client signed in as "hexis-mcp on <host>", and
 * the person reading the Audit log saw the local server where they wanted
 * the agent.
 *
 * The agent is somewhere up the process tree: it spawns `npx`, which spawns
 * `node`, which runs this file — on Windows with `cmd` in between. So the
 * walk skips the plumbing (shells, package runners, the runtime itself) and
 * stops at the first process that is something else. One process-table read
 * per guess, never one per hop: the table is one short command on every
 * platform, and a guess is made once, at sign-in.
 *
 * Nothing here is authoritative. A client that names itself always wins, and
 * the sign-in says on stderr when the name was guessed.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The executable's base name as the platform reports it (`Claude.exe`, `node`). */
  name: string;
}

export type ProcessTable = () => Promise<ProcessRow[]>;

/** The runtime, the runners and the shells between an agent and this process. */
const PLUMBING =
  /^(node|nodejs|npm|npx|pnpm|pnpx|yarn|bun|bunx|deno|corepack|cmd|sh|bash|zsh|fish|dash|pwsh|powershell|conhost|wsl|wslhost|env|sudo|login|script|tmux|screen)$/i;

const exec = promisify(execFile);
const TABLE_TIMEOUT_MS = 4_000;

/** The platform's process table as `pid ppid name` rows; empty when it cannot be read. */
export const readProcessTable: ProcessTable = async () => {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
        ],
        { timeout: TABLE_TIMEOUT_MS, windowsHide: true },
      );
      return parseRows(stdout);
    }
    const { stdout } = await exec('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: TABLE_TIMEOUT_MS });
    return parseRows(stdout);
  } catch {
    return [];
  }
};

function parseRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    // `comm` on macOS and Linux may be a full path; the name wanted is the program's.
    const name = m[3]!.split(/[\\/]/).pop() ?? m[3]!;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name });
  }
  return rows;
}

/**
 * The first ancestor of `startPid` that is not plumbing, as an identity
 * marked `guessed` — or null when the table cannot be read, the chain ends,
 * or only plumbing is found. Bounded in hops and loop-safe: a table that
 * reports a cycle (a reaped parent whose pid was reused) ends the walk
 * instead of spinning.
 */
export async function guessAgentFromAncestry(
  startPid: number = process.ppid,
  table: ProcessTable = readProcessTable,
  maxHops = 8,
): Promise<AgentIdentity | null> {
  const rows = await table();
  if (rows.length === 0) return null;
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  let pid = startPid;
  for (let hop = 0; hop < maxHops; hop++) {
    if (!pid || pid <= 1 || seen.has(pid)) return null;
    seen.add(pid);
    const row = byPid.get(pid);
    if (!row) return null;
    // The base name, with the platform's suffix off: a table that reports a
    // full path (as `ps` can) is read the same way as one that does not.
    const program = (row.name.split(/[\\/]/).pop() ?? row.name).replace(/\.(exe|app)$/i, '').trim();
    if (program && !PLUMBING.test(program)) return { name: program, guessed: true };
    pid = row.ppid;
  }
  return null;
}
