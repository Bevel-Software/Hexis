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
 */

import nodeFs from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The starter guide the template seeds at the top of the knowledge folder
 * (`kb-template/KnowledgeBase/How to get started.md`). The one page that does
 * not make a knowledge base established. A test holds this to the template, so
 * renaming one without the other fails there.
 */
export const STARTER_GUIDE_FILE = 'How to get started.md';

/** The guide section the note points at (`agent-guide/new-knowledge-base.md`). */
export const FIRST_RUN_SECTION_ID = 'new-knowledge-base';

/**
 * Files that are configuration, not content, wherever they sit: a folder's
 * access rules. Dot-files (the folder placeholder `.gitkeep`, `.bevelignore`,
 * an OS's `.DS_Store`) are passed over by name.
 */
const NOT_CONTENT = new Set(['access.md']);

/**
 * How many folders the check opens before it calls the knowledge base
 * established. A knowledge base with this many folders and no page in any of
 * them is not one an agent should greet as new, and `start_session` must stay
 * cheap whatever the tree looks like.
 */
const FOLDER_BUDGET = 200;

/**
 * Whether the knowledge folder at `dir` (absolute) holds nothing but the
 * starter guide: no file in it or below it other than that guide at its top,
 * folder placeholders, dot-files and access rules. Stops at the first page it
 * finds. A folder that is not there answers false: that is a knowledge base in
 * a shape the template never made, and greeting it as new would be a guess.
 */
export async function knowledgeFolderIsNew(dir: string): Promise<boolean> {
  let opened = 0;
  const holdsNothing = async (folder: string, top: boolean): Promise<boolean> => {
    if (++opened > FOLDER_BUDGET) return false;
    const entries = await nodeFs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith('.') || NOT_CONTENT.has(name)) continue;
      if (top && name === STARTER_GUIDE_FILE && entry.isFile()) continue;
      if (entry.isDirectory()) {
        if (!(await holdsNothing(join(folder, name), false))) return false;
        continue;
      }
      // A file, a link, anything else: something someone put there.
      return false;
    }
    return true;
  };
  try {
    return await holdsNothing(dir, true);
  } catch {
    return false;
  }
}

/**
 * The note itself, as `start_session` returns it under `firstRun`. Complete on
 * its own, for the agent that reads no further: what the state is, what to
 * offer, and that the person's own request comes first.
 */
export function firstRunNote(knowledgeFolder: string): string {
  return (
    `This knowledge base is new: \`${knowledgeFolder}/\` holds nothing yet but the starter guide. ` +
    "Once in this conversation, offer to draft its first pages (what the organisation does, its customers, its products, a glossary, how it works) from the person's website or a few sentences of theirs, for them to review. " +
    'If they asked for something else, answer that first and make the offer in one line. ' +
    `The guide's \`${FIRST_RUN_SECTION_ID}\` section says how.`
  );
}
