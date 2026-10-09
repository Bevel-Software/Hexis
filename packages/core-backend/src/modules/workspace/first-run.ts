/**
 * The "first run" note `start_session` adds on a knowledge base nobody has
 * written in yet.
 *
 * Someone who has just set up Hexis and connected their agent has an empty
 * knowledge base and an agent that could fill it. The agent cannot know the
 * first from a static instruction — the same text reaches a knowledge base of
 * ten thousand pages — so the signal is computed when the session starts:
 * while the knowledge folder of the default branch holds nothing but the
 * starter guide the template seeds, `start_session` answers with a short note
 * telling the agent to offer to draft the first pages, and the guide's
 * {@link FIRST_RUN_SECTION_ID} section says how. Once a page of anyone's
 * exists, the note stops on its own: there is no flag to clear.
 *
 * The question is asked AS THE CALLER, gated like a read. The note goes only
 * to someone who may read the knowledge folder, and it judges the folder as
 * they may see it: a page or a folder they may not read is passed over as if
 * it were not there (`mayRead` in {@link knowledgeFolderIsNew}), so a note
 * that does or does not come tells them nothing about pages beyond them. The
 * answer names no file but the starter guide, which every knowledge base is
 * seeded with, and a chosen starter pack's pages — and when one of those is
 * beyond the caller, no note at all, since a list with a gap would say where
 * the gap is.
 *
 * A STARTER PACK does not end it. The pages a pack adds are tasks with a
 * heading and a line or two — "ask your agent to draft this" — so while one
 * still holds exactly what the pack wrote it is not a page anyone wrote, and
 * the note goes on, naming the pages the pack suggests drafting first. The
 * first edit to any of them makes the knowledge base established.
 */

import nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import { NEW_KNOWLEDGE_BASE_SECTION_ID } from '../agent-guide/agent-guide.js';

/**
 * The starter guide the template seeds at the top of the knowledge folder
 * (`kb-template/KnowledgeBase/How to get started.md`). The one page that does
 * not make a knowledge base established. A test holds this to the template, so
 * renaming one without the other fails there.
 */
export const STARTER_GUIDE_FILE = 'How to get started.md';

/**
 * The guide section the note points at (`agent-guide/new-knowledge-base.md`):
 * the guide's own id, so the note cannot name a section the guide renamed.
 */
export const FIRST_RUN_SECTION_ID = NEW_KNOWLEDGE_BASE_SECTION_ID;

/**
 * The starter pack a knowledge base was filled from, as far as the first-run
 * check cares: what the team chose, the pages it suggests drafting, and the
 * pages it wrote — by path below the knowledge folder, with the text each was
 * written with.
 */
export interface FirstRunStarter {
  name: string;
  suggestedPages: readonly string[];
  pages: ReadonlyMap<string, string>;
}

/** Where `start_session` asks which starter pack was chosen (see `modules/onboarding`). */
export interface FirstRunStarterSource {
  firstRunStarter(): Promise<FirstRunStarter | null>;
}

/**
 * Files that are configuration, not content, wherever they sit: a folder's
 * access rules. Dot-files (the folder placeholder `.gitkeep`, `.bevelignore`,
 * an OS's `.DS_Store`) are passed over by name.
 */
const NOT_CONTENT = new Set(['access.md']);

/**
 * How many folders the check opens, and how many entries it reads across
 * them, before it calls the knowledge base established. A knowledge base with
 * this many folders or entries and no page among them is not one an agent
 * should greet as new, and `start_session` must stay cheap whatever the tree
 * looks like: the entries are streamed, so a folder of a hundred thousand
 * costs no more than the budget.
 */
const FOLDER_BUDGET = 200;
export const ENTRY_BUDGET = 1000;

/**
 * Which of some pages (paths below the knowledge folder) the caller may
 * read — `canReadBatch` for them, with the folder's prefix put on and taken
 * off again.
 */
export type MayRead = (relPaths: string[]) => Promise<ReadonlyMap<string, boolean>>;

/**
 * Whether the knowledge folder at `dir` (absolute) holds nothing but the
 * starter guide: no file in it or below it other than that guide at its top,
 * folder placeholders, dot-files and access rules. A folder that is not
 * there answers false: that is a knowledge base in a shape the template
 * never made, and greeting it as new would be a guess.
 *
 * `starterPages` are a starter pack's pages (path below `dir` → the text the
 * pack wrote): one still holding exactly that text is not a page either.
 *
 * Only regular files are pages and only folders are entered. A link, a
 * socket, anything else is passed over by kind, the way a dot-file is by
 * name: it is not a page, and nothing is ever read through it — a link in a
 * checkout can point anywhere, and neither this walk nor the read check it
 * asks is to follow it.
 *
 * With `mayRead`, the answer is the CALLER'S, and nothing they may not read
 * takes part in it: a folder they may not read is not entered — not walked,
 * not counted, not judged — and a file they may not read is not theirs to
 * know of, so it does not make the folder old for them. The files of a
 * folder are judged in chunks as they are listed (the first the caller may
 * read ends the walk: not new), and its subfolders once, after its handle
 * is closed. The budgets then count only what is entered on the caller's
 * behalf: the folders they may read. The entry budget is the other mode's:
 * without `mayRead` the first page found ends the walk, and a tree too large
 * to walk answers "not new" — which, with nobody to answer for, names
 * nothing.
 */
export async function knowledgeFolderIsNew(
  dir: string,
  starterPages?: ReadonlyMap<string, string>,
  mayRead?: MayRead,
): Promise<boolean> {
  let opened = 0;
  let read = 0;
  const holdsNothing = async (folder: string, rel: string): Promise<boolean> => {
    if (++opened > FOLDER_BUDGET) return false;
    const folders: { abs: string; rel: string }[] = [];
    /** This folder's pages not yet judged (`mayRead` mode only). */
    let pages: string[] = [];
    /** Whether any of the pages waiting is one the caller may read. */
    const anyReadable = async (): Promise<boolean> => {
      if (pages.length === 0) return false;
      const verdicts = await mayRead!(pages);
      const found = pages.some((p) => verdicts.get(p) === true);
      pages = [];
      return found;
    };
    // `for await` closes the handle however the loop ends, an early return
    // included — and it is closed before any subfolder is opened, since those
    // are entered after the loop.
    for await (const entry of await nodeFs.opendir(folder)) {
      if (!mayRead && ++read > ENTRY_BUDGET) return false;
      const name = entry.name;
      if (name.startsWith('.') || NOT_CONTENT.has(name)) continue;
      if (rel === '' && name === STARTER_GUIDE_FILE && entry.isFile()) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) {
        folders.push({ abs: join(folder, name), rel: childRel });
        continue;
      }
      // Not a regular file: not a page, and never read through (see above).
      if (!entry.isFile()) continue;
      if (await isUntouchedStarterPage(join(folder, name), starterPages?.get(childRel))) continue;
      // A page, with nobody to ask: something someone put there.
      if (!mayRead) return false;
      pages.push(childRel);
      if (pages.length >= JUDGE_CHUNK && (await anyReadable())) return false;
    }
    if (await anyReadable()) return false;
    // The subfolders, asked about a chunk at a time — a root holding a great
    // many of them is still one bounded ask after another — and entered only
    // as the caller may.
    for (let at = 0; at < folders.length; at += JUDGE_CHUNK) {
      const chunk = folders.slice(at, at + JUDGE_CHUNK);
      const enter = mayRead ? await mayRead(chunk.map((f) => f.rel)) : null;
      for (const child of chunk) {
        if (enter && enter.get(child.rel) !== true) continue;
        if (!(await holdsNothing(child.abs, child.rel))) return false;
      }
    }
    return true;
  };
  try {
    return await holdsNothing(dir, '');
  } catch {
    return false;
  }
}

/** How many of a folder's pages, or subfolders, are judged in one ask of `mayRead`. */
const JUDGE_CHUNK = 200;

/**
 * Whether the file at `file` still holds exactly `written`, the text a starter
 * pack put there (line endings aside: a CRLF checkout of the same text is the
 * same page). No `written` means no pack wrote it.
 */
export async function isUntouchedStarterPage(file: string, written: string | undefined): Promise<boolean> {
  if (written === undefined) return false;
  const norm = (text: string) => text.replace(/\r\n?/g, '\n');
  try {
    return norm(await nodeFs.readFile(file, 'utf8')) === norm(written);
  } catch {
    return false;
  }
}

/**
 * The note itself, as `start_session` returns it under `firstRun`. Complete on
 * its own, for the agent that reads no further: what the state is, what to
 * offer, and that the person's own request comes first.
 */
export function firstRunNote(
  knowledgeFolder: string,
  starter?: Pick<FirstRunStarter, 'name' | 'suggestedPages'>,
): string {
  if (starter) {
    const pages = starter.suggestedPages.length > 0 ? ` (${starter.suggestedPages.join(', ')})` : '';
    return (
      `This knowledge base is new: \`${knowledgeFolder}/\` holds the starter guide and the ${starter.name} starter pages, which are short placeholders to fill in. ` +
      `Once in this conversation, offer to draft its first pages${pages} from the person's website, repository or a few sentences of theirs, for them to review. ` +
      'If they asked for something else, answer that first and make the offer in one line. ' +
      `The guide's \`${FIRST_RUN_SECTION_ID}\` section says how.`
    );
  }
  return (
    `This knowledge base is new: \`${knowledgeFolder}/\` has no pages yet, the starter guide aside. ` +
    "Once in this conversation, offer to draft its first pages (what the organisation does, its customers, its products, a glossary, how it works) from the person's website or a few sentences of theirs, for them to review. " +
    'If they asked for something else, answer that first and make the offer in one line. ' +
    `The guide's \`${FIRST_RUN_SECTION_ID}\` section says how.`
  );
}
