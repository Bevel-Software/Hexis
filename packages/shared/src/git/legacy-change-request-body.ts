/**
 * The grammar change-request bodies carried BEFORE a request's description
 * became the whole of its body — read once, at the first start on the release
 * that makes it so, to move what the body held in hidden markers onto the
 * request's own columns and leave the prose.
 *
 * Three things lived in a body besides what its author wrote:
 *
 * - an `## Affected owners` block `openChangeRequest` appended — the eligible
 *   approvers per changed path at the moment of opening. A snapshot nothing
 *   read back (approvers are resolved live, per file, from the access rules at
 *   the target branch) and that named every changed path to every reader;
 * - an access request's level, as `<!--hexis:access-request-level:owner-->`,
 *   and its note, fenced between `<!--hexis:access-request-note-->` and
 *   `<!--/hexis:access-request-note-->` as quoted lines — both parsed back out
 *   of the prose by the access-request flow;
 * - identity markers (`<!--hexis:…-->`, `<!--bevel:…-->`) from the time a
 *   shared service account opened requests on people's behalf.
 *
 * None is written any more. This module is the one place that still knows the
 * old shape, so the cleanup and its test read the same thing.
 */

import type { AccessRequestLevel } from './pr.types.js';

/** What an old body held, taken apart. */
export interface LegacyChangeRequestBody {
  /** The prose, with every marker and the generated block gone. */
  description: string;
  /** The level an access request recorded in its body, when it did. */
  accessRequestLevel?: AccessRequestLevel;
  /** The requester's note, unescaped, when the body fenced one. */
  accessRequestNote?: string;
  /** Whether the body held anything the new shape stores elsewhere or not at all. */
  changed: boolean;
}

const AFFECTED_OWNERS_HEADING = '## Affected owners';
const LEVEL_MARK = /<!--hexis:access-request-level:(write|owner)-->/;
const NOTE_OPEN = '<!--hexis:access-request-note-->';
const NOTE_CLOSE = '<!--/hexis:access-request-note-->';
/** Hexis's own hidden markers, opener or closer, and no other HTML comment: an author's own comment is prose. */
const HEXIS_MARKER = /[ \t]*<!--\s*\/?(?:hexis|bevel)[:/][\s\S]*?-->[ \t]*/g;

/** The exact inverse of the escaping the access-request flow applied to a note's lines. */
function unescapeMarkdown(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!|<>~])/g, '$1');
}

/** Take an old body apart. A body of the new shape comes back unchanged, `changed: false`. */
export function parseLegacyChangeRequestBody(body: string): LegacyChangeRequestBody {
  let text = body;

  // The generated block starts at the LAST line reading exactly the heading
  // and runs to the end — it was appended after everything the author wrote.
  const lines = text.split('\n');
  const generatedAt = lines.lastIndexOf(AFFECTED_OWNERS_HEADING);
  if (generatedAt !== -1) text = lines.slice(0, generatedAt).join('\n');

  const level = LEVEL_MARK.exec(text);
  const accessRequestLevel = level ? (level[1] as AccessRequestLevel) : undefined;

  let accessRequestNote: string | undefined;
  const noteStart = text.indexOf(NOTE_OPEN);
  const noteEnd = noteStart < 0 ? -1 : text.indexOf(NOTE_CLOSE, noteStart);
  if (noteStart >= 0 && noteEnd >= 0) {
    const note = text
      .slice(noteStart + NOTE_OPEN.length, noteEnd)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('>'))
      .map((line) => unescapeMarkdown(line.replace(/^>\s?/, '')))
      .join('\n')
      .trim();
    accessRequestNote = note || undefined;
  }

  // The markers go; the quoted note lines stay, as the prose they were shown as.
  const description = text
    .replace(HEXIS_MARKER, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    description,
    ...(accessRequestLevel ? { accessRequestLevel } : {}),
    ...(accessRequestNote ? { accessRequestNote } : {}),
    changed: description !== body || accessRequestLevel !== undefined || accessRequestNote !== undefined,
  };
}
