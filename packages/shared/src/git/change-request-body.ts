/**
 * A change request's body, split into what its author wrote and what Hexis
 * generated — the ONE implementation of that cut, for the server (the agent's
 * `body`, an edit's write) and the app (the text its Edit control offers)
 * alike, so the description a person edits is exactly the one a reader is
 * shown and the one the server replaces.
 */

/**
 * The line that opens the generated block `openChangeRequest` appends to a
 * request body. The body's LAST line reading exactly this is where the
 * author's part ends.
 */
export const AFFECTED_OWNERS_HEADING = '## Affected owners';

/**
 * Whether `text` holds a line reading exactly {@link AFFECTED_OWNERS_HEADING}
 * — which an author's text may not, since it would cut the description short
 * the next time it is read.
 */
export function holdsAffectedOwnersHeading(text: string): boolean {
  return text.split('\n').includes(AFFECTED_OWNERS_HEADING);
}

/**
 * The part of a change-request body its AUTHOR wrote.
 *
 * A Hexis body is part human and part machine: `openChangeRequest` appends an
 * `## Affected owners` block — one line per changed path, naming that path and
 * its eligible approvers — to whatever the author typed. Returning the body
 * verbatim NAMED every file of the request, including the ones this caller may
 * not read: Local Testing caught a GTM-team reader being handed
 * `- \`KnowledgeBase/Engineering/…\` — Admin` out of a request whose file list
 * had correctly withheld that very path.
 *
 * So the generated block goes, and NOTHING ELSE does. The first cut at this
 * copied the app's dialog, which drops everything from the first `##` heading
 * on; Razvan's review (2026-10-02) asked for the narrower cut, because an
 * author who writes their description in sections loses it from that heading
 * onwards and is never told. The generated block is appended LAST and begins
 * with a line that is exactly `## Affected owners`, so cutting at the LAST such
 * line removes the machinery and keeps every heading a person wrote. (An author
 * who writes that exact heading themselves loses their text from there — the
 * safe direction, and the only way this can err.)
 *
 * Hexis's OWN hidden markers go too — the `<!--hexis:…-->` / `<!--bevel:…-->`
 * comments older bodies carry identity in, and the `<!--/hexis:…-->` that
 * closes a fenced passage (an access request's note) — and no other comment: an HTML
 * comment the author wrote is the author's prose, like the rest.
 *
 * Who must approve each file is NOT lost by this — it is what
 * `list_change_request_files` answers under `requiredApprovers`, per file and
 * access-filtered, which is where a caller should read it from anyway.
 *
 * Two things this deliberately does not do. It does not vary by caller: one
 * body for everyone is a body nobody has to reason about. And it does not touch
 * the author's own prose, which may mention any path they chose to write about —
 * that is a person's sentence, shown to every viewer in the app, not Hexis
 * naming a file it was asked to withhold.
 */
export function authorsDescription(body: string): string {
  return splitBody(body).authors.replace(HEXIS_MARKER, '').trim();
}

/**
 * Hexis's own hidden markers in a request body — see {@link authorsDescription}.
 * A fenced passage's CLOSING marker (`<!--/hexis:…-->`, as an access request's
 * note ends) is Hexis's too, so the optional `/` is matched as well.
 */
const HEXIS_MARKER = /<!--\s*\/?(?:hexis|bevel)[:/][\s\S]*?-->/g;

/** The author's part of a body, and the generated block after it ('' when none). */
function splitBody(body: string): { authors: string; generated: string } {
  const lines = body.split('\n');
  const at = lines.lastIndexOf(AFFECTED_OWNERS_HEADING);
  return at === -1
    ? { authors: body, generated: '' }
    : { authors: lines.slice(0, at).join('\n'), generated: lines.slice(at).join('\n') };
}

/**
 * The body with the author's part replaced by `description` — the inverse of
 * {@link authorsDescription}, so an edit changes exactly the text a reader is
 * shown as the description and nothing else.
 *
 * Kept: the generated `## Affected owners` block, and Hexis's own hidden
 * markers, which the platform reads back out of the body (an access request's
 * level). They are carried on one line ahead of the new text, where every
 * surface that renders a description hides them. The markers that fenced a
 * passage of the old text (an access request's note, opener and closer) are
 * carried side by side with nothing between them, which reads back as no note —
 * the text they fenced is what the edit replaced.
 */
export function replaceAuthorsDescription(body: string, description: string): string {
  const { authors, generated } = splitBody(body);
  const markers = (authors.match(HEXIS_MARKER) ?? []).join('');
  return [markers, description.trim(), generated.trim()].filter((s) => s.length > 0).join('\n\n');
}
