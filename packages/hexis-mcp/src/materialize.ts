import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { HexisMcpConfig } from './config.js';

/**
 * Local materialization of a plugin, per the Agent Plugins runtime contract.
 *
 * A stdio MCP server is a subprocess on THIS machine, and the spec requires
 * its client to provide two real directories: `PLUGIN_ROOT` (the plugin's own
 * files) and `PLUGIN_DATA` (client-managed persistent state), expand exactly
 * those two placeholders in `args` elements, `env` values and `cwd`, and
 * resolve a `./` command against the plugin root — refusing anything that
 * escapes it. None of that is possible against a knowledge base that lives on
 * a server, so the plugin's files are fetched here first, via the deployment's
 * plugin-archive endpoint (key-authenticated, per-file read-ACL'd).
 *
 * Layout: `~/.hexis/plugins/<host>/<plugin>` as PLUGIN_ROOT, refreshed on
 * every server start (a stale copy is the cost of a running session, not of a
 * lifetime); `~/.hexis/plugin-data/<host>/<plugin>` as PLUGIN_DATA, created
 * once and NEVER cleared — it is the server's persistent state, and the spec
 * says the client manages its lifetime, not its contents.
 */

/** Where a deployment's materialized plugins live, keyed by host so two workspaces never collide. */
export function hexisHome(): string {
  return process.env.HEXIS_HOME || path.join(os.homedir(), '.hexis');
}

function hostKey(baseUrl: string): string {
  const host = new URL(baseUrl).host.replace(/[^a-zA-Z0-9.-]+/g, '_');
  // The hash keeps two base urls on one host (different ports/paths) apart.
  return `${host}-${createHash('sha256').update(baseUrl).digest('hex').slice(0, 8)}`;
}

/** One path segment, refusing separators and dot-navigation — a folder name, not a path. */
function assertSegment(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error(`"${name}" is not a plugin folder name`);
  }
}

export interface MaterializedPlugin {
  pluginRoot: string;
  pluginData: string;
}

/**
 * Fetch the plugin into the local root, byte-for-byte. The archive is built
 * server-side and filtered per file by the caller's own read access — a file
 * the key cannot read is a file that stays remote.
 */
export async function materializePlugin(
  config: HexisMcpConfig,
  folder: string,
): Promise<MaterializedPlugin> {
  assertSegment(folder);
  const home = hexisHome();
  const key = hostKey(config.baseUrl);
  const pluginRoot = path.join(home, 'plugins', key, folder);
  const pluginData = path.join(home, 'plugin-data', key, folder);
  await fs.mkdir(pluginData, { recursive: true });

  // Refresh from scratch each start: correctness over cleverness. Staleness
  // becomes bounded by process lifetime, and there is no cache-invalidation
  // protocol to get wrong. The tree is small (a plugin, not a repo).
  await fs.rm(pluginRoot, { recursive: true, force: true });
  await fs.mkdir(pluginRoot, { recursive: true });

  // One request, byte-for-byte: the deployment's plugin-archive endpoint zips
  // the folder server-side, filtered per file by the caller's own read access.
  // This is deliberately NOT `read_file` — that is the agent's reading surface
  // (text, one file at a time); a plugin must land here exactly as it is,
  // binaries included, or a stdio server's assets arrive corrupted.
  const res = await fetch(
    `${config.baseUrl}/api/agent/plugins/${encodeURIComponent(folder)}/archive`,
    {
      headers: { Authorization: `Bearer ${config.connectionKey}` },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    throw new Error(`could not fetch plugin "${folder}": HTTP ${res.status}`);
  }
  // Client-side ceilings, independent of the server's own cap: this function
  // is the boundary that protects the MEMBER's machine, and its disk/memory
  // must not be fully delegated to the deployment's good behavior.
  const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
  const MAX_ENTRIES = 5_000;
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  let extracted = 0;
  let count = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    if (++count > MAX_ENTRIES) {
      throw new Error(`plugin "${folder}" archive has more than ${MAX_ENTRIES} entries — refusing to materialize`);
    }
    const abs = path.join(pluginRoot, ...entry.entryName.split('/'));
    // The archive names the paths; keep a hostile-looking one inside the root.
    if (!isWithin(pluginRoot, abs)) continue;
    // DECLARED size before allocation: `getData()` allocates the uncompressed
    // buffer, so checking after it would let one crafted entry OOM this
    // process before the limit ever ran. The header's size is the archive's
    // own claim; a lying header still cannot exceed the cap, because the
    // post-decompress length is counted again below.
    const declared = entry.header.size;
    if (declared > MAX_EXTRACTED_BYTES || extracted + declared > MAX_EXTRACTED_BYTES) {
      throw new Error(
        `plugin "${folder}" exceeds the ${MAX_EXTRACTED_BYTES / (1024 * 1024)}MB extraction limit — refusing to materialize`,
      );
    }
    const data = entry.getData();
    extracted += data.length;
    if (extracted > MAX_EXTRACTED_BYTES) {
      throw new Error(
        `plugin "${folder}" exceeds the ${MAX_EXTRACTED_BYTES / (1024 * 1024)}MB extraction limit — refusing to materialize`,
      );
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data);
    // Unix mode rides in the zip attrs (high 16 bits); restoring the exec
    // bits is what lets a `./`-command stdio server actually run. Only
    // Windows gets a pass on failure — its permission model makes chmod a
    // near-no-op; anywhere else a failed chmod is a real materialization
    // problem that must not surface later as a confusing spawn EACCES.
    const mode = (entry.attr >>> 16) & 0o777;
    if (mode & 0o111) {
      await fs.chmod(abs, mode).catch((err: unknown) => {
        if (process.platform !== 'win32') throw err;
      });
    }
  }
  return { pluginRoot, pluginData };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Expansion per the spec: a single, non-recursive textual replacement of the
 * two placeholders — applied ONLY to `args` elements, `env` values and `cwd`,
 * never to `command` or `env` keys. Unrecognized `${…}` text stays literal.
 */
export function expandPlaceholders(value: string, m: MaterializedPlugin): string {
  return value.split('${PLUGIN_ROOT}').join(m.pluginRoot).split('${PLUGIN_DATA}').join(m.pluginData);
}

/**
 * Resolve a stdio `command` token: a bare name passes through to PATH lookup;
 * a `./` path resolves against the plugin root and must STAY within it after
 * symlink resolution — `realpath` is what makes a link pointing outside the
 * root a refusal instead of an escape. Anything else is refused outright (the
 * spec allows exactly those two shapes).
 */
export async function resolveCommand(command: string, m: MaterializedPlugin): Promise<string> {
  if (command.startsWith('./')) {
    const abs = path.resolve(m.pluginRoot, command);
    if (!isWithin(m.pluginRoot, abs)) {
      throw new Error(`stdio command "${command}" escapes the plugin root`);
    }
    const real = await fs.realpath(abs).catch(() => {
      throw new Error(`stdio command "${command}" does not exist in the materialized plugin`);
    });
    if (!isWithin(await fs.realpath(m.pluginRoot), real)) {
      throw new Error(`stdio command "${command}" resolves outside the plugin root`);
    }
    return abs;
  }
  if (/[/\\]/.test(command)) {
    throw new Error(
      `stdio command "${command}" must be a bare executable name or a ./ path inside the plugin`,
    );
  }
  return command;
}

/** The spawn spec as it appears inside a UTCP mcp call template's config. */
export interface StdioServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/**
 * Apply the whole runtime contract to one stdio server spec: expand, resolve,
 * contain, and add the two environment variables — which the server's own
 * `env` MUST NOT declare (the client owns them; a plugin shadowing them would
 * be lying to the process about where it lives).
 */
export async function prepareStdioSpec(
  spec: StdioServerSpec,
  m: MaterializedPlugin,
): Promise<StdioServerSpec> {
  const declared = Object.keys(spec.env ?? {});
  if (declared.includes('PLUGIN_ROOT') || declared.includes('PLUGIN_DATA')) {
    throw new Error('a stdio server env must not declare PLUGIN_ROOT or PLUGIN_DATA');
  }
  // EVERY cwd shape is contained, not just `./` ones: `../x`, an absolute
  // `/etc`, or a crafted expansion would otherwise pass through to spawn
  // unchecked. After expansion the cwd must land inside one of the two
  // directories the runtime contract hands the server — the plugin root or
  // its data dir (either directory itself included).
  const expandedCwd = spec.cwd !== undefined ? expandPlaceholders(spec.cwd, m) : m.pluginRoot;
  const resolvedCwd = path.resolve(m.pluginRoot, expandedCwd);
  // Canonicalized on BOTH sides: a symlink inside the plugin pointing at /tmp
  // would pass a lexical check while spawning the process outside the roots.
  // A cwd that does not exist is refused outright — spawn would fail on it
  // anyway, and an honest error beats ENOENT out of a subprocess.
  const realCwd = await fs.realpath(resolvedCwd).catch(() => {
    throw new Error(`stdio cwd "${spec.cwd}" does not exist in the materialized plugin`);
  });
  const [realRoot, realData] = await Promise.all([
    fs.realpath(m.pluginRoot),
    fs.realpath(m.pluginData),
  ]);
  const within = (root: string): boolean => {
    const rel = path.relative(root, realCwd);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  if (!within(realRoot) && !within(realData)) {
    throw new Error(`stdio cwd "${spec.cwd}" escapes the plugin root`);
  }
  return {
    command: await resolveCommand(spec.command, m),
    args: (spec.args ?? []).map((a) => expandPlaceholders(a, m)),
    env: {
      ...Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, expandPlaceholders(v, m)])),
      PLUGIN_ROOT: m.pluginRoot,
      PLUGIN_DATA: m.pluginData,
    },
    cwd: resolvedCwd,
  };
}
