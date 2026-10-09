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
 * they may see it: a page they may not read is passed over as if it were not
 * there (`mayRead` in {@link knowledgeFolderIsNew}), so a note that does or
 * does not come tells them nothing about pages beyond them. The answer names
 * no file but the starter guide, which every knowledge base is seeded with,
 * and a chosen starter pack's pages — and when one of those is beyond the
 * caller, no note at all, since a list with a gap would say where the gap is.
 *
 * A STARTER PACK does not end it. The pages a pack adds are tasks with a
 * heading and a line or two — "ask your agent to draft this" — so while one
 * still holds exactly what the pack wrote it is not a page anyone wrote, and
 * the note goes on, naming the pages the pack suggests drafting first. The
 * first edit to any of them makes the knowledge base established.
 */

import nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import type { ITreeWalker } from '../../shared/fs.contract.js';
import { NEW_KNOWLEDGE_BASE_SECTION_ID } from '../agent-guide/agent-guide.js';
import { BevelIgnoreStack } from '../kb-fs/bevel-ignore.js';

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
 * access rules. Dot-entries (the folder placeholder `.gitkeep`, `.bevelignore`,
 * an OS's `.DS_Store`) the knowledge-base walk never shows at all.
 */
const NOT_CONTENT = new Set(['access.md']);

/**
 * How many folders the check lists, the knowledge folder included, before it
 * calls the knowledge base established. A knowledge base with this many
 * folders and no page among them is not one an agent should greet as new, and
 * `start_session` must stay cheap whatever the tree looks like.
 */
export const FOLDER_BUDGET = 200;

/**
 * Which of some pages (paths below the knowledge folder) the caller may
 * read — `canReadBatch` for them, with the folder's prefix put on and taken
 * off again.
 */
export type MayRead = (relPaths: string[]) => Promise<ReadonlyMap<string, boolean>>;

/**
 * Whether the knowledge folder `knowledgeDir` of the checkout at `repoRoot`
 * holds nothing but the starter guide: no file in it or below it other than
 * that guide at its top, folder placeholders, dot-files and access rules. A
 * folder that is not there answers false: that is a knowledge base in a shape
 * the template never made, and greeting it as new would be a guess.
 *
 * `starterPages` are a starter pack's pages (path below the folder → the text
 * the pack wrote): one still holding exactly that text is not a page either.
 *
 * THE knowledge-base walk does the walking ({@link ITreeWalker.walkKb}, see
 * `shared/fs.contract.ts`), the way the explorer's does: dot-entries never
 * shown, a link or a socket never entered nor counted as a file, and
 * `.bevelignore` honoured — the repository root's rules and every folder's on
 * the way down — so what the explorer hides this check does not see either,
 * and a knowledge folder those rules hide is not greeted. A folder that
 * cannot be listed is the answer: not new, since it cannot say.
 *
 * With `mayRead`, the answer is the CALLER'S: a file they may not read is not
 * theirs to know of, so it does not make the folder old for them. Every
 * folder is entered, as the agent's own listing shows every folder and
 * filters its files — a deeper rule may open a page below a folder its
 * parent's rules close — and a folder's pages are judged in chunks of
 * {@link JUDGE_CHUNK}; the first the caller may read ends the walk: not new.
 * Without `mayRead` the first page ends it. Either way {@link FOLDER_BUDGET}
 * folders end it too: that many and no page is not a new knowledge base.
 */
export async function knowledgeFolderIsNew(
  disk: ITreeWalker,
  repoRoot: string,
  knowledgeDir: string,
  starterPages?: ReadonlyMap<string, string>,
  mayRead?: MayRead,
): Promise<boolean> {
  let sawRoot = false;
  let established = false;
  let listed = 0;
  /** Whether any of `pages` (paths below the knowledge folder) is one the caller may read. */
  const anyReadable = async (pages: string[]): Promise<boolean> => {
    const verdicts = await mayRead!(pages);
    return pages.some((p) => verdicts.get(p) === true);
  };
  try {
    // The rules in force above the knowledge folder — the repository root's
    // file — which a walk starting below it would not see on its own.
    const above = await BevelIgnoreStack.empty().extendedWith(repoRoot);
    const dir = join(repoRoot, knowledgeDir);
    if (above.isIgnored(dir, true)) return false;
    await disk.walkKb(
      dir,
      [
        {
          async onDir(rel, entries, folder) {
            if (rel === '') sawRoot = true;
            if (++listed > FOLDER_BUDGET) {
              established = true;
              return;
            }
            let pages: string[] = [];
            for (const entry of entries) {
              if (!entry.isFile() || NOT_CONTENT.has(entry.name)) continue;
              if (rel === '' && entry.name === STARTER_GUIDE_FILE) continue;
              const childRel = rel ? `${rel}/${entry.name}` : entry.name;
              if (await isUntouchedStarterPage(join(folder.abs, entry.name), starterPages?.get(childRel))) continue;
              // A page, with nobody to ask: something someone put there.
              if (!mayRead) {
                established = true;
                return;
              }
              pages.push(childRel);
              if (pages.length >= JUDGE_CHUNK) {
                if (await anyReadable(pages)) {
                  established = true;
                  return;
                }
                pages = [];
              }
            }
            if (pages.length > 0 && (await anyReadable(pages))) established = true;
          },
        },
      ],
      { ignore: above, until: () => established, unreadable: 'throw' },
    );
  } catch {
    return false;
  }
  return sawRoot && !established;
}

/** How many of a folder's pages are judged in one ask of `mayRead`. */
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
