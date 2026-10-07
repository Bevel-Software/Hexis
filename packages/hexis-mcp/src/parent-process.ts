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
 * `node`, which runs this file — with shells in between, and on Windows
 * `cmd`. The walk goes up from the parent and stops at the first ancestor
 * it can NAME: a program on the list below, recognised by its executable,
 * its macOS bundle, or — for an agent that runs on a runtime such as `node`
 * — by the package or script its command line names. Everything else is
 * passed over, plumbing and unknown alike: a terminal, an ssh daemon, a
 * container runtime, an Electron helper are not agents, and a name the
 * list does not know is not a guess, it is a mystery, which the Audit log
 * must not carry. No match in a bounded number of hops is "no guess".
 *
 * Passing over the shells has one consequence worth knowing: a server
 * started BY HAND from an editor's integrated terminal has that editor
 * above the shell, and is named after it — the chain looks exactly like the
 * editor spawning the server through `cmd` or `sh`, which it does. The
 * stderr line says the name was guessed, and from what; a client that
 * names itself in its handshake is never guessed at.
 *
 * One process-table read per guess, never one per hop: the table is one or
 * two short commands on every platform, and a guess is made once, at sign-in.
 *
 * Nothing here is authoritative. A client that names itself always wins, and
 * the sign-in says on stderr when the name was guessed.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The executable as the platform reports it: `Claude.exe`, `node`, or a full path on macOS and Linux. */
  name: string;
  /** The full command line, when the platform gives it. */
  command?: string;
}

export type ProcessTable = () => Promise<ProcessRow[]>;

/**
 * The agents this guess can name. `key` is a KNOWN_AGENTS key (handshake.ts),
 * so the guess is displayed exactly like a handshake that said the same.
 * `program` matches the executable's base name (suffix off) or the macOS
 * bundle name; `command` matches the command line of a RUNTIME process —
 * `node …/@anthropic-ai/claude-code/cli.js`, `node /usr/local/bin/claude` —
 * because a runtime is named by what it runs, not by its own binary.
 */
const AGENTS: ReadonlyArray<{ key: string; program: RegExp; command?: RegExp }> = [
  // Claude.app and claude.exe are Claude Desktop or Claude Code's native
  // binary; Claude Code installed with npm runs on node, as its package or
  // its `claude` bin shim.
  // A scoped package is matched to its segment end: `@openai/codex` is Codex,
  // `@openai/codex-notes` is some other package that happens to start the same.
  { key: 'claude', program: /^claude$/i, command: /@anthropic-ai[\\/]claude-code(?=[\\/"'\s]|$)|[\\/]claude(\.[cm]?js)?(?=["'\s]|$)/i },
  { key: 'cursor', program: /^cursor( helper.*)?$/i },
  { key: 'windsurf', program: /^windsurf( helper.*)?$/i },
  // `Code.exe` / `Code - Insiders.exe` on Windows, `code` / `code-insiders`
  // on Linux, the `Visual Studio Code[ - Insiders].app` bundle on macOS.
  { key: 'code', program: /^(code|code - insiders|code-insiders|visual studio code( - insiders)?)( helper.*)?$/i },
  { key: 'codium', program: /^(codium|vscodium)( helper.*)?$/i },
  { key: 'zed', program: /^zed$/i },
  { key: 'codex', program: /^codex$/i, command: /@openai[\\/]codex(?=[\\/"'\s]|$)|[\\/]codex(\.[cm]?js)?(?=["'\s]|$)/i },
  { key: 'gemini-cli', program: /^gemini$/i, command: /@google[\\/]gemini-cli(?=[\\/"'\s]|$)|[\\/]gemini(\.[cm]?js)?(?=["'\s]|$)/i },
  { key: 'cline', program: /^cline$/i, command: /[\\/]cline(\.[cm]?js)?(?=["'\s]|$)/i },
];

/** A process whose identity is in its command line, not its executable. */
const RUNTIME = /^(node|nodejs|bun|deno|electron|python[0-9.]*)$/i;

const exec = promisify(execFile);
const TABLE_TIMEOUT_MS = 4_000;

/** The platform's process table; empty when it cannot be read. */
export const readProcessTable: ProcessTable = async () => {
  try {
    if (process.platform === 'win32') {
      // One tab-separated row per process; a command line may be empty for
      // a process this user may not inspect.
      const { stdout } = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | ForEach-Object { @($_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine) -join [char]9 }',
        ],
        { timeout: TABLE_TIMEOUT_MS, windowsHide: true },
      );
      const rows: ProcessRow[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const [pid, ppid, name, ...command] = line.split('\t');
        if (!pid || !ppid || !name || !/^\d+$/.test(pid) || !/^\d+$/.test(ppid)) continue;
        rows.push({ pid: Number(pid), ppid: Number(ppid), name, command: command.join('\t') });
      }
      return rows;
    }
    // `comm` can be a full path with spaces ("…/Visual Studio Code.app/…"),
    // so it is read on its own and the command lines joined by pid.
    const [{ stdout: tree }, { stdout: commands }] = await Promise.all([
      exec('ps', ['-axo', 'pid=,ppid=,comm='], { timeout: TABLE_TIMEOUT_MS }),
      exec('ps', ['-axo', 'pid=,args='], { timeout: TABLE_TIMEOUT_MS }),
    ]);
    const commandByPid = new Map<number, string>();
    for (const line of commands.split('\n')) {
      const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
      if (m) commandByPid.set(Number(m[1]), m[2]!);
    }
    const rows: ProcessRow[] = [];
    for (const line of tree.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*?)\s*$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      rows.push({ pid, ppid: Number(m[2]), name: m[3]!, command: commandByPid.get(pid) });
    }
    return rows;
  } catch {
    return [];
  }
};

/** The agent a process row is, by the list above, or null for anything else. */
function agentOf(row: ProcessRow): string | null {
  const program = (row.name.split(/[\\/]/).pop() ?? row.name).replace(/\.(exe|app)$/i, '').trim();
  // On macOS the executable inside a bundle may be generic ("Electron" for
  // VS Code); the bundle's own name says what it is.
  const bundle = /([^\\/]+)\.app(?=[\\/]|$)/i.exec(row.name)?.[1];
  for (const agent of AGENTS) {
    if (agent.program.test(program) || (bundle && agent.program.test(bundle))) return agent.key;
    if (agent.command && row.command && RUNTIME.test(program) && agent.command.test(row.command)) return agent.key;
  }
  return null;
}

/**
 * The nearest ancestor of `startPid` that is an agent this module can name,
 * as an identity marked `guessed` — or null when the table cannot be read,
 * the chain ends, or no ancestor within `maxHops` is one. Loop-safe: a
 * table that reports a cycle (a reaped parent whose pid was reused) ends the
 * walk instead of spinning.
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
    const key = agentOf(row);
    if (key) return { name: key, guessed: true };
    pid = row.ppid;
  }
  return null;
}
