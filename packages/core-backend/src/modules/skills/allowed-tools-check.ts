import { PLUGINS_DIR, SKILLS_DIR } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';
import type { IToolRegistry } from '../tool-registry/tool.contract.js';
import { EXTERNAL_KB_MANUAL_NAME, type IToolManualService } from '../tool-manuals/tool-manuals.contract.js';
import { MAX_CAPABILITIES } from '../tool-manuals/tool-manuals.service.js';
import { parseSkillFrontmatter } from './skills.service.js';

const log = logger('skills');

/**
 * Checks a skill's `allowed-tools` against the tools the platform actually
 * serves, and says so when an entry names one that does not exist.
 *
 * A WARNING, never a refusal. The list is shared with the client: a skill
 * names the agent's own tools there too (`Bash`, `Read`, `Bash(git:*)`), and
 * the platform cannot know those. So an entry is only checked when it LOOKS
 * like a platform tool:
 *
 *  - a manual-qualified name, `hubspot.search` (the UTCP namespace);
 *  - an MCP-style name for this server, `mcp__hexis__<tool>` — `<tool>` being
 *    a core tool (`read_file`) or a manual's tool as the proxy names it
 *    (`hubspot_search`);
 *  - a bare lowercase name: a manual (`hubspot`), a core tool, or `<manual>_<tool>`.
 *
 * Everything else is the client's: names starting with a capital (Claude
 * Code's `Bash`, `WebFetch`, …), permission-rule syntax (`Bash(git:*)`),
 * wildcards, another MCP server's `mcp__<server>__…`, and the lowercase
 * client tools listed in {@link CLIENT_TOOL_NAMES}.
 */

/** One entry the platform could not resolve. */
export interface AllowedToolWarning {
  /**
   * The `allowed-tools` entry as written, with surrounding whitespace
   * removed — the only normalization applied. A YAML list may quote an entry
   * with padding (`- " hubspot.search "`); the padding is not part of the
   * name, and echoing it back would name an entry the author cannot find.
   */
  entry: string;
  /** A sentence naming the entry, and the suggestion when there is one. */
  message: string;
  /** The closest tool name the caller can see, in the entry's own spelling. */
  suggestion?: string;
}

/**
 * The tools a caller can see. `tools: null` for a manual whose tools are only
 * discovered at call time (`http`/`mcp`) — any tool under it is accepted,
 * because nothing here can prove it absent without a network round-trip.
 */
export interface VisibleTools {
  core: string[];
  manuals: { name: string; tools: string[] | null }[];
}

/** The MCP server prefix this platform's tools carry in a client's tool list. */
export const MCP_PREFIX = 'mcp__hexis__';

/**
 * Lowercase tool names that belong to agent CLIENTS, not the platform —
 * capitalised ones (every Claude Code tool) are exempt by shape already.
 * Explicit rather than clever: a name added here is never flagged.
 */
export const CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Codex / OpenAI agents
  'shell',
  'apply_patch',
  'update_plan',
  'view_image',
  'web_search',
  'local_shell',
  // Gemini CLI
  'run_shell_command',
  'read_many_files',
  'google_web_search',
  'web_fetch',
  'save_memory',
  'glob',
  'replace',
]);

/** Classify and resolve every entry; only unresolved platform-looking ones come back. */
export function checkAllowedTools(entries: readonly string[], visible: VisibleTools): AllowedToolWarning[] {
  const core = new Set(visible.core.map((n) => n.toLowerCase()));
  const manuals = new Map(
    visible.manuals.map((m) => [m.name.toLowerCase(), m.tools?.map((t) => t.toLowerCase()) ?? null]),
  );
  const warnings: AllowedToolWarning[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    const warning = checkEntry(entry, core, manuals, visible);
    if (warning) warnings.push(warning);
  }
  return warnings;
}

function checkEntry(
  entry: string,
  core: Set<string>,
  manuals: Map<string, string[] | null>,
  visible: VisibleTools,
): AllowedToolWarning | null {
  if (/[()*\s]/.test(entry)) return null; // permission-rule syntax or a wildcard
  const lower = entry.toLowerCase();

  if (lower.startsWith('mcp__')) {
    if (!lower.startsWith(MCP_PREFIX)) return null; // another MCP server's tool
    const name = lower.slice(MCP_PREFIX.length);
    if (core.has(name) || resolvesUnderscored(name, manuals)) return null;
    return warn(entry, `mcp__hexis__${name}`, [
      ...visible.core.map((c) => MCP_PREFIX + c),
      ...underscoredCandidates(visible).map((c) => MCP_PREFIX + c),
    ]);
  }

  const dot = entry.indexOf('.');
  if (dot > 0) {
    const manual = lower.slice(0, dot);
    const tool = lower.slice(dot + 1);
    if (!/^\w+$/.test(manual)) return null; // not a manual name — a file, a URL, …
    // The core toolset's own namespace, as `call_tool_chain` spells it.
    if (manual === EXTERNAL_KB_MANUAL_NAME.toLowerCase() && core.has(tool)) return null;
    const tools = manuals.get(manual);
    if (tools === null) return null;
    if (tools !== undefined && tools.includes(tool)) return null;
    return warn(entry, lower, [
      ...visible.manuals.flatMap((m) => (m.tools ? m.tools.map((t) => `${m.name}.${t}`) : [`${m.name}.${entry.slice(dot + 1)}`])),
    ]);
  }

  // Bare names: a capital first letter is a client tool's shape.
  if (!/^[a-z][\w-]*$/.test(entry) || CLIENT_TOOL_NAMES.has(entry)) return null;
  if (core.has(lower) || manuals.has(lower) || resolvesUnderscored(lower, manuals)) return null;
  return warn(entry, lower, [...visible.core, ...visible.manuals.map((m) => m.name), ...underscoredCandidates(visible)]);
}

/** `<manual>_<tool>` — how the MCP proxy names a manual's tool. */
function resolvesUnderscored(name: string, manuals: Map<string, string[] | null>): boolean {
  for (const [manual, tools] of manuals) {
    if (!name.startsWith(`${manual}_`)) continue;
    const tool = name.slice(manual.length + 1);
    // Manual names may hold underscores themselves, so keep looking on a miss.
    if (tools === null || tools.includes(tool)) return true;
  }
  return false;
}

function underscoredCandidates(visible: VisibleTools): string[] {
  return visible.manuals.flatMap((m) => (m.tools ?? []).map((t) => `${m.name}_${t}`));
}

function warn(entry: string, normalized: string, candidates: string[]): AllowedToolWarning {
  const suggestion = closest(normalized, candidates);
  return {
    entry,
    message: suggestion
      ? `"${entry}" in allowed-tools is not a tool you can use here. Did you mean "${suggestion}"?`
      : `"${entry}" in allowed-tools is not a tool you can use here.`,
    ...(suggestion ? { suggestion } : {}),
  };
}

/** The nearest candidate by edit distance, when it is near enough to be a typo. */
export function closest(name: string, candidates: readonly string[]): string | undefined {
  const limit = Math.max(1, Math.floor(name.length / 3));
  let best: string | undefined;
  let bestDistance = limit + 1;
  for (const candidate of candidates) {
    const d = editDistance(name, candidate.toLowerCase());
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The repo-relative path of a skill file (`Plugins/…/SKILL.md` or
 * `Skills/…/SKILL.md`) when `workspacePath` names one, else `null`.
 * Accepts the workspace spelling (`<kbDirName>/Plugins/…`) the save
 * surfaces receive.
 */
export function skillFileRepoPath(kbDirName: string, workspacePath: string): string | null {
  const parts = workspacePath.split('/').filter((p) => p && p !== '.');
  if (parts[0] === kbDirName) parts.shift();
  if (parts.length < 3 || parts[parts.length - 1] !== 'SKILL.md') return null;
  return parts[0] === PLUGINS_DIR || parts[0] === SKILLS_DIR ? parts.join('/') : null;
}

/** What the save surfaces and `get_skill` depend on. */
export interface IAllowedToolsChecker {
  /** Warnings for a declared list, resolved against what `userEmail` can see. Never throws. */
  check(userEmail: string, allowedTools: readonly string[] | undefined): Promise<AllowedToolWarning[]>;
  /**
   * Warnings for a file being saved: `[]` unless `workspacePath` is a skill
   * file. Never throws — a save must not fail because a check could not run.
   */
  checkSave(userEmail: string, workspacePath: string, content: string): Promise<AllowedToolWarning[]>;
}

/** Resolves "the tools a user can see" from the tool catalog and the manuals they may read. */
export class AllowedToolsChecker implements IAllowedToolsChecker {
  constructor(
    private readonly registry: Pick<IToolRegistry, 'listExternal'>,
    private readonly manuals: Pick<IToolManualService, 'listAccessible' | 'getDetail'>,
    private readonly kbDirName: string,
    /**
     * The cap `getDetail` applies to a manual's capabilities. Taken from the
     * projection itself: a copy of the number here would silently start
     * reporting real tools missing the day the projection's cap grew.
     */
    private readonly maxCapabilities = MAX_CAPABILITIES,
  ) {}

  async check(userEmail: string, allowedTools: readonly string[] | undefined): Promise<AllowedToolWarning[]> {
    if (!allowedTools || allowedTools.length === 0) return [];
    try {
      return checkAllowedTools(allowedTools, await this.visibleTools(userEmail));
    } catch (err) {
      log.warn('allowed-tools check skipped', { err });
      return [];
    }
  }

  async checkSave(userEmail: string, workspacePath: string, content: string): Promise<AllowedToolWarning[]> {
    if (skillFileRepoPath(this.kbDirName, workspacePath) === null) return [];
    try {
      return await this.check(userEmail, parseSkillFrontmatter(content).allowedTools);
    } catch (err) {
      log.warn('allowed-tools check skipped', { err });
      return [];
    }
  }

  private async visibleTools(userEmail: string): Promise<VisibleTools> {
    const [coreTools, summaries] = await Promise.all([
      this.registry.listExternal({ userEmail }),
      this.manuals.listAccessible(userEmail),
    ]);
    const manuals = await Promise.all(
      summaries.map(async (m) => {
        if (m.type !== 'inline') return { name: m.name, tools: null };
        const detail = await this.manuals.getDetail(userEmail, m.slug);
        const caps = detail?.capabilities ?? [];
        // A capped list may be missing the very tool asked about.
        if (!detail || caps.length >= this.maxCapabilities) return { name: m.name, tools: null };
        return {
          name: m.name,
          tools: caps.map((c) => (c.name.startsWith(`${m.name}.`) ? c.name.slice(m.name.length + 1) : c.name)),
        };
      }),
    );
    return { core: coreTools.map((t) => t.name), manuals };
  }
}
