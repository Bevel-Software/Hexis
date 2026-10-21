import { parse as parseYaml } from 'yaml';
import { extractFrontmatter } from '../../shared/frontmatter-id.js';

/** The extension an agent definition carries. */
export const AGENT_FILE_EXTENSION = '.agent';

/**
 * What the PLATFORM reads out of an `.agent` file: who the agent is, and the
 * four lists that narrow what a connection made as it loads. Everything else
 * the file carries — the harness, the model, `env:`, the system prompt, the
 * harness allowlist (`harnessTools`, `tools.allow` before it) — is the
 * runner's, and the platform reads none of it.
 *
 * A list that is ABSENT and a list that is EMPTY are different answers only
 * for `platformTools`, where absent means every platform tool. For the other
 * three, absent and empty both name nothing: a connection loads the union of
 * what the lists name, so an agent that names no skills loads none.
 */
export interface AgentFileDefinition {
  /** Frontmatter `name` folded to one line of at most `AGENT_NAME_MAX` characters, else the file's base name. */
  name: string;
  /** Frontmatter `description`, folded to one line of at most `AGENT_DESCRIPTION_MAX`; empty when there is none. */
  description: string;
  /** Plugin folders (a parent folder means every plugin under it). */
  plugins: string[];
  /** Skill folders (a parent folder means every skill under it). */
  skills: string[];
  /** `.tool` files and MCP server definitions (a folder means every connector under it). */
  connectors: string[];
  /** Names of the platform's own tools; null when the file names none (= all of them). */
  platformTools: string[] | null;
}

/** An `.agent` file that cannot be read as an agent definition. The reason never quotes the file. */
export class AgentFileError extends Error {}

/**
 * Parse an `.agent` file the way a `.tool` file is parsed: one `---` fenced
 * YAML document, with free prose after the closing fence.
 *
 * A list may be written as a YAML list or, for one entry, as a plain string.
 * A list that is neither (a number, a map) makes the whole file invalid
 * rather than being read as empty: an agent whose author meant to narrow and
 * got the shape wrong must not load more than they meant, nor silently less.
 * Entries are knowledge-base paths, repo-relative (`Plugins/Engineering/x`),
 * with an optional leading or trailing `/`; an entry
 * that climbs (`..`) or is empty is dropped, as one naming nothing.
 */
export function parseAgentFile(content: string, repoPath: string): AgentFileDefinition {
  const fm = extractFrontmatter(content);
  if (!fm) throw new AgentFileError('it has no `---` fenced definition at the top');
  let parsed: unknown;
  try {
    parsed = parseYaml(fm.frontmatter);
  } catch {
    throw new AgentFileError('its definition is not valid YAML');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentFileError('its definition is not a YAML map');
  }
  const obj = parsed as Record<string, unknown>;
  const base = repoPath.slice(repoPath.lastIndexOf('/') + 1).replace(/\.agent$/i, '');
  // Both are written by anyone who may edit the file and are read back into
  // the handshake, the agent guide and refusals, so they are folded to one
  // line and bounded: a newline must not break the text they sit in.
  const name = foldLine(obj.name, AGENT_NAME_MAX) || foldLine(base, AGENT_NAME_MAX);
  const description = foldLine(obj.description, AGENT_DESCRIPTION_MAX);
  return {
    name,
    description,
    plugins: pathList(obj, 'plugins'),
    skills: pathList(obj, 'skills').map((p) => p.replace(/\/SKILL\.md$/i, '')),
    connectors: pathList(obj, 'connectors'),
    platformTools: obj.platformTools === undefined || obj.platformTools === null ? null : names(obj, 'platformTools'),
  };
}

/** The longest `name` an agent is shown by. */
export const AGENT_NAME_MAX = 80;
/** The longest `description` an agent is shown with. */
export const AGENT_DESCRIPTION_MAX = 300;

/** A frontmatter string folded to one trimmed line of at most `max` characters; empty for anything else. */
function foldLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function entries(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  throw new AgentFileError(`its \`${key}\` is not a list of names`);
}

function names(obj: Record<string, unknown>, key: string): string[] {
  return entries(obj, key)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function pathList(obj: Record<string, unknown>, key: string): string[] {
  return entries(obj, key).flatMap((raw) => {
    const normalized = normalizeEntryPath(raw);
    return normalized === null ? [] : [normalized];
  });
}

/**
 * An entry as a repo-relative path with no leading or trailing slash, or null
 * when it names nothing that can be matched (empty, or climbing out).
 */
export function normalizeEntryPath(raw: string): string | null {
  const p = raw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
  if (!p || p.split('/').some((s) => s === '..' || s === '.')) return null;
  return p;
}
