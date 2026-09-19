import type { AccessResponse } from '../../access/api';

/**
 * WHY a copy of a file could not be read.
 *
 * The change-request view used to keep one `unreadable` flag per file and
 * render one sentence for every failure, so a permission denial and a broken
 * read looked the same. They are not the same fact and they do not have the
 * same answer: a denial is settled by asking a person for access, a failure by
 * trying the read again. A tester who was simply not allowed to see a file
 * went looking for an outage that did not exist.
 */
export type ReadFailure =
  /** The server refused on access grounds. `folder` is the nearest folder
   *  whose access rules govern the path, or `null` when none can be named. */
  | { kind: 'denied'; folder: string | null }
  /** Anything else — said with the reason, and retryable. */
  | { kind: 'error'; reason: string };

/**
 * The HTTP status an API error carries, when it carries one. Both
 * `WorkspaceApiError` and `GitApiError` expose `status`; a network drop and a
 * plain `Error` expose nothing, which is not a denial.
 */
export function statusOf(err: unknown): number | null {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : null;
}

/** A read the server refused because the caller may not see the path. */
export function isDenial(err: unknown): boolean {
  return statusOf(err) === 403;
}

/**
 * The parenthesised `<reason>` of the retryable sentence: the server's own
 * words when it sent any (both API error classes carry the `{ error }` body as
 * their message, falling back to `HTTP <status>`), and a plain statement for a
 * read that never reached the server at all.
 */
export function failureReason(err: unknown): string {
  const message = err instanceof Error ? err.message.trim() : '';
  return message === '' ? 'the request never completed' : message;
}

/** How deep a repo-relative folder sits; the root (`''`) is depth 0. */
const depthOf = (folder: string): number => (folder === '' ? 0 : folder.split('/').length);

/**
 * The nearest folder with an access rule for the path, read off the resolved
 * access view's `sources` map.
 *
 * Every `ancestor` source names the `access.md` that grants a principal a
 * verb — which is exactly "a folder with an access rule for this path".
 * Resolution is closeness-first, so the DEEPEST of them is the one the reader
 * should be asking about. A path whose only rules are its own frontmatter has
 * no ancestor source and therefore no folder to name: `null`, and the sentence
 * says "this file" instead of inventing a directory.
 */
export function nearestRuleFolder(sources: AccessResponse['sources'] | undefined): string | null {
  const folders = Object.values(sources ?? {})
    .flatMap((verbs) => Object.values(verbs ?? {}))
    .flatMap((list) => list ?? [])
    .filter((source) => source.kind === 'ancestor')
    .map((source) => (source as { path: string }).path.replace(/(^|\/)access\.md$/, ''));
  if (folders.length === 0) return null;
  return folders.reduce((best, folder) => (depthOf(folder) > depthOf(best) ? folder : best));
}

/**
 * What the repository root is called when it is the folder to ask about — a
 * rule written there reaches everything, and "" is not a name. The same words
 * the Manage access dialog uses for it.
 */
const WHOLE_WORKSPACE = 'the whole workspace';

/** How the folder reads inside the sentence; `null` falls back to the file. */
export function askAboutLabel(folder: string | null): string {
  if (folder === null) return 'this file';
  return folder === '' ? WHOLE_WORKSPACE : folder;
}

/** The denial, said as the reason it is: not an outage, an access decision. */
export function deniedSentence(folder: string | null): string {
  return (
    "You don't have access to read this file, so its content can't be shown here. " +
    `Ask an owner of ${askAboutLabel(folder)} for read access if you need to review it.`
  );
}

/**
 * The retryable sentence up to the Retry link, which the pane renders as a
 * control (and so cannot live in a string): the caller appends "Try again."
 */
export function readErrorLead(reason: string): string {
  return `This file couldn't be read right now (${reason}).`;
}
