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
 * The question is about the knowledge base, not about the caller: it is asked
 * of the disk, under no access gate, and the answer names no file but the
 * starter guide, which every knowledge base is seeded with. A knowledge base
 * holding pages the caller may not read is not new, and the caller learns no
 * more from the missing note than that.
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
 * Whether the knowledge folder at `dir` (absolute) holds nothing but the
 * starter guide: no file in it or below it other than that guide at its top,
 * folder placeholders, dot-files and access rules. Stops at the first page it
 * finds. A folder that is not there answers false: that is a knowledge base in
 * a shape the template never made, and greeting it as new would be a guess.
 *
 * `starterPages` are a starter pack's pages (path below `dir` → the text the
 * pack wrote): one still holding exactly that text is not a page either.
 */
export async function knowledgeFolderIsNew(
  dir: string,
  starterPages?: ReadonlyMap<string, string>,
): Promise<boolean> {
  let opened = 0;
  let read = 0;
  const holdsNothing = async (folder: string, rel: string): Promise<boolean> => {
    if (++opened > FOLDER_BUDGET) return false;
    // `for await` closes the handle however the loop ends, an early return included.
    for await (const entry of await nodeFs.opendir(folder)) {
      if (++read > ENTRY_BUDGET) return false;
      const name = entry.name;
      if (name.startsWith('.') || NOT_CONTENT.has(name)) continue;
      if (rel === '' && name === STARTER_GUIDE_FILE && entry.isFile()) continue;
      const childRel = rel ? `${rel}/${name}` : name;
      if (entry.isDirectory()) {
        if (!(await holdsNothing(join(folder, name), childRel))) return false;
        continue;
      }
      if (entry.isFile() && (await isUntouchedStarterPage(join(folder, name), starterPages?.get(childRel)))) continue;
      // A file, a link, anything else: something someone put there.
      return false;
    }
    return true;
  };
  try {
    return await holdsNothing(dir, '');
  } catch {
    return false;
  }
}

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
