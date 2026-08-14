import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { HexisMcpConfig } from './config.js';
import { callKbTool } from './deployment.js';

/**
 * Local materialization of a plugin, per the Agent Plugins runtime contract.
 *
 * A stdio MCP server is a subprocess on THIS machine, and the spec requires
 * its client to provide two real directories: `PLUGIN_ROOT` (the plugin's own
 * files) and `PLUGIN_DATA` (client-managed persistent state), expand exactly
 * those two placeholders in `args` elements, `env` values and `cwd`, and
 * resolve a `./` command against the plugin root — refusing anything that
 * escapes it. None of that is possible against a knowledge base that lives on
 * a server, so the plugin's files are fetched here first, over the same
 * key-authenticated tools any agent uses (`list_files` + `read_file`).
 *
 * Layout: `~/.hexis/plugins/<host>/<plugin>` as PLUGIN_ROOT, refreshed on
 * every server start (a stale copy is the cost of a running session, not of a
 * lifetime); `~/.hexis/plugin-data/<host>/<plugin>` as PLUGIN_DATA, created
 * once and NEVER cleared — it is the server's persistent state, and the spec
 * says the client manages its lifetime, not its contents.
 *
 * Honest limitation: files arrive through `read_file`, a TEXT surface — a
 * binary asset does not survive the trip. Scripts, configs and manifests do,
 * which is what a stdio server's plugin realistically carries today.
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
 * Fetch every file under `Plugins/<folder>` into the local root. The listing
 * comes from the deployment's own `list_files` tool, so access control is the
 * caller's key's — a file the key cannot read is a file that stays remote.
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

  const rels = await listPluginFiles(config, `Plugins/${folder}`);
  for (const rel of rels) {
    const res = (await callKbTool(config, 'read_file', {
      path: `Plugins/${folder}/${rel}`,
    })) as { content?: unknown };
    if (typeof res?.content !== 'string') continue;
    const abs = path.join(pluginRoot, ...rel.split('/'));
    // The server names the paths; keep a hostile-looking one inside the root.
    if (!isWithin(pluginRoot, abs)) continue;
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, res.content, 'utf8');
  }
  return { pluginRoot, pluginData };
}

/** Recursive listing of workspace-relative file paths under `dir`, relative to it. */
async function listPluginFiles(config: HexisMcpConfig, dir: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [''];
  // Bounded sweep: a plugin is a folder of scripts and notes, and a listing
  // that large means something else is being pointed at.
  let guard = 0;
  while (queue.length > 0 && guard++ < 500) {
    const sub = queue.shift()!;
    const res = (await callKbTool(config, 'list_files', {
      path: sub ? `${dir}/${sub}` : dir,
    })) as { entries?: { name?: unknown; type?: unknown }[] };
    for (const e of res?.entries ?? []) {
      if (typeof e?.name !== 'string' || e.name === '.git') continue;
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.type === 'directory') queue.push(rel);
      else out.push(rel);
    }
  }
  return out;
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
  const cwd = spec.cwd !== undefined ? expandPlaceholders(spec.cwd, m) : m.pluginRoot;
  if (spec.cwd?.startsWith('./') && !isWithin(m.pluginRoot, path.resolve(m.pluginRoot, cwd))) {
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
    cwd: spec.cwd?.startsWith('./') ? path.resolve(m.pluginRoot, cwd) : cwd,
  };
}
