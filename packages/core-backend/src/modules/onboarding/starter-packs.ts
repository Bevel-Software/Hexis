/**
 * Starter packs: the pages and the plugin a new knowledge base can be filled
 * with in one click, chosen by what the team does.
 *
 * A pack is a folder under the packs root (`starter-packs/` in this package,
 * or a distribution's `STARTER_PACKS_DIR`):
 *
 *   <id>/pack.yaml          id, name, description, order, firstPagePrompt, suggestedPages
 *   <id>/KnowledgeBase/…    pages, under the DEFAULT layout's folder names
 *   <id>/Plugins/<name>/…   a team plugin in the normal plugin layout
 *   <id>/Skills/…           shared skills, if a pack carries any
 *
 * The three folders are written under the deployment's OWN names for them
 * (`KnowledgeBase/` lands in whatever `knowledgeBaseDir` is), so a pack is
 * authored once and fits every layout. Anything else in a pack folder (a
 * README, notes for whoever maintains it) is the pack's, not the knowledge
 * base's, and is never copied.
 *
 * A pack that does not read as one — no `pack.yaml`, a field missing or of
 * the wrong kind, an id that is not its folder's name — is passed over with
 * a warning: one broken folder must not take the choice away from everyone.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { renderKbLayoutPlaceholders, type KbLayout } from '@bevel-software/platform-shared';
import { logger } from '../../shared/logging.js';

const log = logger('starter-packs');

/** The file that makes a folder a pack. */
export const PACK_MANIFEST = 'pack.yaml';

/** The answer that chooses no pack: "Skip, I'll start from scratch". Never a pack's id. */
export const NO_STARTER_PACK = 'none';

/** A pack id: the folder's name, kebab-case, so it is safe in a URL, a setting and a path. */
const PACK_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The pack's own folders, by their default-layout names, and the layout key each one is written under. */
export const PACK_ROOTS: ReadonlyArray<readonly [string, keyof Pick<KbLayout, 'knowledgeBaseDir' | 'pluginsDir' | 'skillsDir'>]> = [
  ['KnowledgeBase', 'knowledgeBaseDir'],
  ['Plugins', 'pluginsDir'],
  ['Skills', 'skillsDir'],
];

/** What a chip shows, and the order the chips come in. */
export interface StarterPackSummary {
  id: string;
  name: string;
  description: string;
  order: number;
}

export interface StarterPack extends StarterPackSummary {
  /** Replaces the generic "write your first page" request for a team that chose this pack. */
  firstPagePrompt: string;
  /** The pages the agent's first-run note offers to draft. */
  suggestedPages: string[];
  /** The pack's folder, absolute. */
  dir: string;
}

/** One file a pack would add, at the path it would have in the knowledge base. */
export interface StarterPackFile {
  /** Repository-relative, under the deployment's layout: `KnowledgeBase/About us.md`, `Plugins/x/skills/y/SKILL.md`. */
  repoPath: string;
  /** Which of the pack's folders it came from, by its default name. */
  root: (typeof PACK_ROOTS)[number][0];
  /** The bytes to write: text with the layout placeholders filled, or the file as it is. */
  content: string | Buffer;
}

/**
 * Every valid pack under `root`, chip order first (then name). A root that
 * is not there offers no packs; it is not an error, since a distribution may
 * ship none.
 */
export async function loadStarterPacks(root: string): Promise<StarterPack[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`could not read the starter packs folder "${root}" — no packs offered:`, { err });
    }
    return [];
  }
  const packs: StarterPack[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const pack = await readStarterPack(path.join(root, entry.name));
    if (pack) packs.push(pack);
  }
  return packs.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** The pack in `dir`, or null (with a warning saying why) when it does not read as one. */
export async function readStarterPack(dir: string): Promise<StarterPack | null> {
  const folder = path.basename(dir);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, PACK_MANIFEST), 'utf8');
  } catch {
    log.warn(`starter pack "${folder}" has no readable ${PACK_MANIFEST} — skipped.`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    log.warn(`starter pack "${folder}": ${PACK_MANIFEST} is not valid YAML — skipped.`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const problem = packProblem(parsed, folder);
  if (problem) {
    log.warn(`starter pack "${folder}": ${problem} — skipped.`);
    return null;
  }
  const m = parsed as Record<string, unknown>;
  return {
    id: m.id as string,
    name: (m.name as string).trim(),
    description: (m.description as string).trim(),
    order: m.order as number,
    firstPagePrompt: (m.firstPagePrompt as string).trim(),
    suggestedPages: (m.suggestedPages as string[]).map((p) => p.trim()),
    dir,
  };
}

/** Why a parsed `pack.yaml` is not a pack, or null when it is one. */
export function packProblem(manifest: unknown, folder: string): string | null {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return `${PACK_MANIFEST} is not a mapping`;
  }
  const m = manifest as Record<string, unknown>;
  if (typeof m.id !== 'string' || !PACK_ID_RE.test(m.id)) return '`id` must be lowercase letters, digits and hyphens';
  if (m.id !== folder) return `\`id\` ("${m.id}") must be the folder's name`;
  if (m.id === NO_STARTER_PACK) return `"${NO_STARTER_PACK}" is reserved for skipping`;
  for (const key of ['name', 'description', 'firstPagePrompt'] as const) {
    if (typeof m[key] !== 'string' || !(m[key] as string).trim()) return `\`${key}\` must be a non-empty string`;
  }
  if (typeof m.order !== 'number' || !Number.isFinite(m.order)) return '`order` must be a number';
  if (!Array.isArray(m.suggestedPages) || m.suggestedPages.some((p) => typeof p !== 'string' || !p.trim())) {
    return '`suggestedPages` must be a list of page names';
  }
  return null;
}

/**
 * Every file the pack would add, at its path under `layout`, in a stable
 * order. Dot-files are left behind (an editor's or an OS's droppings, never
 * content), and so is anything that is not a regular file: a pack is files.
 */
export async function starterPackFiles(pack: StarterPack, layout: Required<KbLayout>): Promise<StarterPackFile[]> {
  const out: StarterPackFile[] = [];
  for (const [root, layoutKey] of PACK_ROOTS) {
    const base = path.join(pack.dir, root);
    for (const rel of await filesUnder(base)) {
      const bytes = await fs.readFile(path.join(base, ...rel.split('/')));
      const text = asText(bytes);
      out.push({
        repoPath: `${layout[layoutKey]}/${rel}`,
        root,
        content: text === null ? bytes : renderKbLayoutPlaceholders(text, layout),
      });
    }
  }
  return out;
}

/** The files below `dir` as POSIX paths relative to it, sorted; none when it is not there. */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' && rel === '') return;
      throw err;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(abs, entry.name), childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/** The bytes as text when they ARE text — strict UTF-8, no NUL — else null. */
function asText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}
