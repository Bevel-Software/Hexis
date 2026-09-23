import type { AgentEventKind } from './audit.contract.js';

/**
 * Pure classification of one UTCP tool call into what the Audit log records:
 * a hexis capability, a manual's tool, or a skill read. No I/O — the one
 * catalog it may need (the skill folders) is handed in by the caller, which
 * asks {@link skillReadPath} first whether that catalog is worth fetching.
 */

/** What a call is logged as: the kind, the manual (or skill folder), and the bare name. */
export interface ClassifiedCall {
  kind: AgentEventKind;
  manual: string | null;
  name: string;
}

/** A skill as the classifier needs it: its name and its repo-relative folder. */
export interface SkillFolder {
  name: string;
  path: string;
}

export interface ClassifierContext {
  /** The registered name of the platform's own manual (`KNOWLEDGE_BASE`). */
  kbManualName: string;
  /** Registered (rewritten) manual name → catalog name, for pooled MCP manuals. */
  catalogNames: ReadonlyMap<string, string>;
}

/**
 * The platform tools whose `path` argument may point INTO a skill folder — a
 * read of `Plugins/Sales/rfi/SKILL.md` or of a file bundled beside it is the
 * agent reading that skill, and is logged as such rather than as a file read.
 */
const SKILL_FOLDER_READ_TOOLS: ReadonlySet<string> = new Set(['read_file', 'grep', 'list_files']);

/** The platform tool that loads a skill by name. */
const GET_SKILL = 'get_skill';

/** `<manual>.<tool>` → its two halves; a bare name has no manual. */
export function splitUtcpName(utcpName: string): { manual: string; tool: string } {
  const dot = utcpName.indexOf('.');
  return dot < 0
    ? { manual: '', tool: utcpName }
    : { manual: utcpName.slice(0, dot), tool: utcpName.slice(dot + 1) };
}

/**
 * The `path` a platform tool was called with, wherever the caller put it.
 * Bevel-hosted http tools take their arguments inside a `body` envelope
 * (`{ body: { path } }`); a caller that flattened it (`{ path }`) is read too.
 */
function pathArgument(args: Record<string, unknown>): string | null {
  const body = args.body;
  const inner = body && typeof body === 'object' ? (body as Record<string, unknown>).path : undefined;
  const candidate = typeof inner === 'string' ? inner : args.path;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/** The `name` a `get_skill` call asked for, from the envelope or flattened. */
function skillNameArgument(args: Record<string, unknown>): string | null {
  const body = args.body;
  const inner = body && typeof body === 'object' ? (body as Record<string, unknown>).name : undefined;
  const candidate = typeof inner === 'string' ? inner : args.name;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * When a platform read names a path, the path — the signal that the caller
 * should fetch the skill catalog before classifying (a folder match turns
 * the read into a skill event). Null for every other call, so the catalog is
 * never fetched for a `notion.search` or a `write_file`.
 */
export function skillReadPath(utcpName: string, args: Record<string, unknown>, kbManualName: string): string | null {
  const { manual, tool } = splitUtcpName(utcpName);
  if (manual !== kbManualName) return null;
  if (tool === GET_SKILL) return skillNameArgument(args) === null ? null : '';
  if (!SKILL_FOLDER_READ_TOOLS.has(tool)) return null;
  return pathArgument(args);
}

/**
 * The path as segments, resolved: forward slashes, `.` dropped, `..` taken
 * back a segment, no empty segments — so two spellings of one place compare
 * equal, and a path that climbs OUT of a folder is never matched to it. A
 * path that climbs above its own start has no place at all and resolves to
 * the empty string, which matches nothing. (The file tools refuse `..`
 * outright; the log must still not credit a refused read to a skill.)
 */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const segment of p.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return '';
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/**
 * The skill whose folder contains `path`, if any. Matched on a segment
 * boundary anywhere in the path — a caller may spell the path from the
 * repository root (`Plugins/Sales/rfi/SKILL.md`) or from one level above it
 * (`knowledge-base/Plugins/Sales/rfi/SKILL.md`), and both are that skill.
 * The longest folder wins, so a skill nested under another's folder is not
 * mistaken for its parent.
 */
export function skillContaining(path: string, skills: readonly SkillFolder[]): SkillFolder | null {
  const normalized = normalizePath(path);
  if (!normalized) return null;
  const haystack = `/${normalized}/`;
  let best: SkillFolder | null = null;
  for (const skill of skills) {
    const folder = normalizePath(skill.path);
    if (!folder) continue;
    if (haystack.includes(`/${folder}/`) && (!best || folder.length > normalizePath(best.path).length)) {
      best = skill;
    }
  }
  return best;
}

/**
 * Classify one call. `skills` is the catalog when {@link skillReadPath} asked
 * for it and the caller could fetch it; null otherwise (the read is then
 * logged as the capability it is, which is the honest fallback).
 */
export function classifyToolCall(
  utcpName: string,
  args: Record<string, unknown>,
  ctx: ClassifierContext,
  skills: readonly SkillFolder[] | null,
): ClassifiedCall {
  const { manual, tool } = splitUtcpName(utcpName);
  // A meta-tool (`call_tool_chain`, `list_tools`, …) has no manual: the platform's own.
  if (manual === '' || manual === ctx.kbManualName) {
    if (tool === GET_SKILL) {
      const name = skillNameArgument(args);
      if (name) {
        const folder = skills?.find((s) => s.name === name)?.path ?? null;
        return { kind: 'skill', manual: folder, name };
      }
    } else if (SKILL_FOLDER_READ_TOOLS.has(tool) && skills) {
      const path = pathArgument(args);
      const skill = path ? skillContaining(path, skills) : null;
      if (skill) return { kind: 'skill', manual: skill.path, name: skill.name };
    }
    return { kind: 'capability', manual: null, name: tool };
  }
  return { kind: 'tool', manual: ctx.catalogNames.get(manual) ?? manual, name: tool };
}
