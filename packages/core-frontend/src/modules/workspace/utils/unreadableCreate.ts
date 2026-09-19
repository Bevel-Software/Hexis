import type { UploadInput } from '../state/workspace.context';
import { isUploadNoise } from './readDroppedEntries';

/**
 * What the tree asks before it adds a file the user will never see.
 *
 * When something is created at a spot the creator cannot read, the platform
 * keeps it visible to them by writing a creator `read:` grant — into the
 * topmost NEW directory's `access.md`, or, for a loose file dropped into a
 * folder that already exists, into the file's own frontmatter. Only markdown
 * carries frontmatter, so a non-markdown file landing directly in an existing
 * unreadable folder gets no grant at all: the backend logs it and carries on
 * (`creator-access.ts`), and the file disappears the moment it is added —
 * from the very person who just proposed it.
 *
 * That is a legitimate thing to want (the request still reaches the folder's
 * owners), so the platform does not refuse it. It says so first.
 *
 * The two conditions below mirror `CreatorAccessService.planForCreate`
 * exactly, and must keep mirroring it — a dialog that warns where a grant is
 * actually coming, or stays quiet where none is, is worse than no dialog:
 *  - markdown is exempt (it carries the grant), and
 *  - only files landing DIRECTLY in the target folder count. Anything under a
 *    subfolder of the drop brings a new directory into existence, and the
 *    grant is seeded on that directory's `access.md`, covering the subtree
 *    whatever the file extensions are.
 *
 * THE ONE CASE THIS CANNOT SEE: a dropped subfolder whose name already exists
 * inside the unreadable target. The backend seeds on the topmost segment that
 * is NOT on disk, so a colliding name means no new directory and no grant,
 * and the files under it go quiet without being asked about. The client
 * cannot tell the two apart — existence inside a folder the caller may not
 * read is exactly what the access model declines to answer, and guessing
 * either way is worse than this gap: warning on every folder drop would warn
 * about files that WILL be visible, which is the same broken promise pointed
 * the other way. The server still logs the ungranted create
 * (`creator-access.ts`), and the file still reaches the folder's owners.
 */

/**
 * Carries frontmatter, so the creator grant can ride along inside it.
 *
 * EXACT CASE, because the grant it mirrors is exact case: `planForCreate`
 * splices the per-file grant for `rel.endsWith('.md')` only, and the access
 * resolver registers `.md` the same way. `NOTES.MD` is governed by its folder
 * like any other file, gets no grant, and therefore has to be asked about.
 */
export function isMarkdownName(name: string): boolean {
  return /\.md$/.test(name);
}

/**
 * The names an upload puts DIRECTLY into its target folder — the only ones a
 * missing creator grant can hide (see the module docstring). OS noise is
 * dropped here for the same reason `dispatchUpload` drops it: it is never
 * uploaded, so it must never be warned about either.
 */
export function directChildNames(input: UploadInput): string[] {
  switch (input.kind) {
    case 'files':
      return input.files.map((f) => f.name).filter((n) => !isUploadNoise(n));
    case 'paths':
      return input.items
        .filter((it) => !isUploadNoise(it.relativePath) && !it.relativePath.includes('/'))
        .map((it) => it.relativePath);
    case 'items':
      // A directory entry is taken to be a NEW folder: its subtree gets the
      // seeded `access.md` grant, so nothing under it needs warning about.
      // See the module docstring for the one drop where that is not true and
      // why the client cannot know it.
      return input.entries
        .filter((e) => e.isFile && !isUploadNoise(e.name))
        .map((e) => e.name);
  }
}

/**
 * Of names landing directly in the folder, the ones a missing creator grant
 * would hide — every non-markdown one. Empty means nothing to ask about.
 */
export function unreadableAmong(names: string[]): string[] {
  return names.filter((n) => !isMarkdownName(n));
}

/** The names of `input` that would land invisible — empty when none would. */
export function unreadableNames(input: UploadInput): string[] {
  return unreadableAmong(directChildNames(input));
}

/**
 * How a repo-relative folder reads in the sentence. The KB root is `''` on
 * the wire and "the top level" in prose — the same words the move
 * confirmation uses for it.
 */
export function folderLabel(repoRelativeFolder: string): string {
  return repoRelativeFolder === '' ? 'the top level' : repoRelativeFolder;
}

/**
 * The sentence itself. One name reads as the ticket writes it; several read
 * as a count, with the names listed beside it by the dialog — a batch of
 * fifty in one sentence is not a sentence.
 */
export function unreadableCreateSentence(names: string[], folder: string): string {
  const where = `you don't have read access to ${folderLabel(folder)}.`;
  if (names.length === 1) {
    return `You won't be able to see ${names[0]} after it is added: ${where}`;
  }
  return `You won't be able to see these ${names.length} files after they are added: ${where}`;
}
