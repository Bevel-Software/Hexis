/**
 * The link half of `move_file`: which pages a move edits, and what it reports.
 *
 * A move breaks two sets of links — those inside the moved files that point
 * elsewhere, and those elsewhere that point at the moved files. The plan reads
 * both through the shared grammar (`md-links` in platform-shared) and answers
 * the edits to make plus the report the agent gets, the same for a dry run and
 * for the move itself.
 *
 * Who sees what:
 *   - a file the caller cannot read is never opened; the report then carries
 *     one sentence saying such files may still point at the old path, with no
 *     name and no count;
 *   - a file the caller can read but may not change (a protected branch's
 *     write rules, or the write hook's refusal) is named with its links, and
 *     left;
 *   - a file the read hook refuses counts as one the caller cannot read: not
 *     named, only covered by the same sentence;
 *   - an HTML page is named with its links, and left — and so is a markdown
 *     page for the raw HTML it carries (`<a href>`, `<img src>`), which the
 *     grammar reads but never rewrites.
 */

import {
  htmlLinksAffectedByMove,
  rewriteMdLinks,
  scanMarkdownHtmlLinks,
  type MdLinkEdit,
} from '@bevel-software/platform-shared';

/** More edited files than this and the move is refused. */
export const MOVE_LINK_EDIT_CAP = 200;
/** How many edits the report lists. */
export const MOVE_LINK_REPORT_EDITS = 100;

/** The sentence about files the caller cannot read. */
export const UNSEARCHED_SENTENCE =
  'Links in files you cannot read were not searched, and may still point at the old path.';

/** A folder segment whose files are records of the past, never searched or rewritten. */
const UNSEARCHED_SEGMENTS = new Set(['transcripts', 'probes']);

export interface MoveLinksReport {
  filesEdited: number;
  linksRewritten: number;
  /** The first {@link MOVE_LINK_REPORT_EDITS} edits; `path` is where the file sits after the move. */
  edits: { path: string; from: string; to: string }[];
  notRewritten: { path: string; reason: string; links: string[] }[];
  unsearched?: string;
}

export interface PlannedEdit {
  /** Where the file sits after the move. */
  path: string;
  /** Where it sits now. */
  lockAt: string;
  /** The bytes the edit was computed from — compared again under the lock. */
  original: string;
  content: string;
  links: MdLinkEdit[];
}

export interface MoveLinksPlan {
  edits: PlannedEdit[];
  report: MoveLinksReport;
  /** Set when the move would edit more than the cap; the move is refused with it. */
  overCap?: string;
}

export interface MoveLinksInput {
  src: string;
  dest: string;
  branch: string;
  kbDirName: string;
  /** Every file on the branch inside the clone folder, workspace-relative. */
  allFiles: string[];
  /** Read verdicts for workspace-relative paths. */
  canRead: (paths: string[]) => Promise<Map<string, boolean>>;
  /** The paths among these the caller may not change (protected-branch rules). */
  writeBlocked: (paths: string[]) => Promise<string[]>;
  readText: (path: string) => Promise<string>;
  /**
   * Ask the deployment's read and write hooks about a file the move edits:
   * why it may not be, or null. Only edited files are asked. `read` says the
   * read hook refused: the file is then treated as unreadable and never named.
   */
  hookRefusal: (lockAt: string, path: string) => Promise<{ reason: string; read: boolean } | null>;
}

/** Whether `path` lies in a `transcripts/` or `probes/` folder. */
export function isUnsearchedRecord(path: string): boolean {
  return path.split('/').slice(0, -1).some((s) => UNSEARCHED_SEGMENTS.has(s));
}

const isMarkdown = (p: string) => /\.md$/i.test(p);
const isHtml = (p: string) => /\.html?$/i.test(p);

/**
 * The search's cheap first cut: a file linking at `name` names it — raw, or
 * spelled with markdown escapes or percent-encoding, which are undone here
 * the way the resolver undoes them (any case, any subset of characters).
 */
function mayMention(text: string, name: string): boolean {
  if (text.includes(name)) return true;
  const unescaped = text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
  const decoded = unescaped.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
  return decoded.includes(name);
}

export async function planMoveLinks(input: MoveLinksInput): Promise<MoveLinksPlan> {
  const { src, dest, branch, kbDirName } = input;
  const mapPath = (p: string): string | null =>
    p === src ? dest : p.startsWith(`${src}/`) ? dest + p.slice(src.length) : null;
  const srcName = src.slice(src.lastIndexOf('/') + 1);

  const candidates = input.allFiles.filter((p) => (isMarkdown(p) || isHtml(p)) && !isUnsearchedRecord(p)).sort();
  const readable = await input.canRead(candidates);
  let unsearched = candidates.some((p) => readable.get(p) !== true);

  const edits: PlannedEdit[] = [];
  const notRewritten: MoveLinksReport['notRewritten'] = [];
  for (const oldPath of candidates) {
    if (readable.get(oldPath) !== true) continue;
    const newPath = mapPath(oldPath) ?? oldPath;
    // The sidebar moves and deletes without this tool's locks, so a page can
    // go between the listing and this read. A page gone has no links to fix;
    // one that cannot be opened is one more the search did not cover.
    let text: string;
    try {
      text = await input.readText(oldPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') unsearched = true;
      continue;
    }
    // A file that stays put is only touched by a link that names the moved
    // path, so a page that does not mention it is skipped unparsed.
    if (newPath === oldPath && !mayMention(text, srcName)) continue;
    const opts = { oldPath, newPath, mapPath, kbDirName, branch };
    if (isHtml(oldPath)) {
      const links = htmlLinksAffectedByMove(text, opts);
      if (links.length > 0) notRewritten.push({ path: newPath, reason: 'html page', links });
      continue;
    }
    // Raw HTML inside a markdown page (`<img src>`, `<a href>`) renders like
    // a link but is not one the grammar rewrites: named with those links and
    // left, as an HTML page is, so a stale target is never silent. Only a
    // live tag: one inside code or behind a `\<` escape is an example.
    const html = htmlLinksAffectedByMove(text, opts, scanMarkdownHtmlLinks(text));
    if (html.length > 0) notRewritten.push({ path: newPath, reason: 'html in markdown', links: html });
    const rewritten = rewriteMdLinks(text, opts);
    if (rewritten.edits.length === 0) continue;
    edits.push({ path: newPath, lockAt: oldPath, original: text, content: rewritten.text, links: rewritten.edits });
  }

  // Only a file that stays put can be one the caller may not change: every
  // moved file was already judged writable at both ends by the move itself.
  const blocked = new Set(await input.writeBlocked(edits.filter((e) => e.path === e.lockAt).map((e) => e.path)));
  let kept = edits.filter((e) => {
    if (!blocked.has(e.path)) return true;
    notRewritten.push({ path: e.path, reason: 'no write access', links: e.links.map((l) => l.from) });
    return false;
  });

  if (kept.length > MOVE_LINK_EDIT_CAP) {
    return {
      edits: [],
      report: reportOf([], notRewritten, unsearched),
      overCap:
        `This move would edit links in ${kept.length} files, more than the ${MOVE_LINK_EDIT_CAP} one move may edit, so nothing was moved. ` +
        'Move fewer files at a time (a subfolder, then the rest), or pass `rewriteLinks: false` to move without rewriting links.',
    };
  }

  // The hooks hear about edited files only — never a file merely searched.
  const allowed: PlannedEdit[] = [];
  for (const e of kept) {
    const refusal = await input.hookRefusal(e.lockAt, e.path);
    if (refusal === null) allowed.push(e);
    else if (refusal.read) unsearched = true;
    else notRewritten.push({ path: e.path, reason: refusal.reason, links: e.links.map((l) => l.from) });
  }
  kept = allowed;
  return { edits: kept, report: reportOf(kept, notRewritten, unsearched) };
}

function reportOf(
  edits: PlannedEdit[],
  notRewritten: MoveLinksReport['notRewritten'],
  unsearched: boolean,
): MoveLinksReport {
  const flat = edits.flatMap((e) => e.links.map((l) => ({ path: e.path, from: l.from, to: l.to })));
  return {
    filesEdited: edits.length,
    linksRewritten: flat.length,
    edits: flat.slice(0, MOVE_LINK_REPORT_EDITS),
    notRewritten,
    ...(unsearched ? { unsearched: UNSEARCHED_SENTENCE } : {}),
  };
}
