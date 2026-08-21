/**
 * Shared shaping for the email extractors (`extract-eml.ts` / `extract-msg.ts`).
 *
 * Both formats extract to the SAME text shape, so an agent greps a mailbox
 * without caring which client saved the file:
 *
 *   [from] Ada Lovelace <ada@example.com>
 *   [to] Bob <bob@example.com>, carol@example.com
 *   [subject] Quarterly numbers
 *   [date] 2026-01-05T10:00:00.000Z
 *
 *   the body…
 *
 *   [attachments]
 *   report.pdf (application/pdf, 48211 bytes)
 *
 * Header lines are omitted when the message lacks the field (never printed
 * empty). The body prefers the plain-text part; an HTML-only body is stripped
 * to text (block tags become newlines so paragraphs survive) and the marker
 * summary says so. Attachments are LISTED by name only — v1 does not extract
 * inside them, and the summary says that too.
 */
import type { ExtractedDoc } from './doc-extract.types.js';
import { Parser } from 'htmlparser2';
import { MAX_ELEMENT_DEPTH, TOO_DEEP } from './ooxml-text.js';

/** One listed attachment. Size/type are printed only when known. */
export interface EmailAttachment {
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** Where the body text came from — drives the honest summary + body notes. */
export type EmailBodySource = 'text' | 'html' | 'rtf-only' | 'none';

/** The format-independent email, as far as the extraction cares. */
export interface EmailModel {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** ISO timestamp when the date parsed, the raw header value otherwise. */
  date?: string;
  /** Body as plain text ('' when there is none or it is RTF-only). */
  body: string;
  bodySource: EmailBodySource;
  attachments: EmailAttachment[];
}

/** The line a body that exists only as RTF gets INSTEAD of body text. */
export const RTF_ONLY_BODY_LINE = '[body is RTF; no plain-text part]';

/**
 * Strip an HTML email body to plain text. Deliberately simple (the same
 * stance as `ooxml-text.ts`): comments and `<style>`/`<script>`/`<head>`/
 * `<title>` containers are dropped whole, `<br>` and block-level tag
 * boundaries become newlines so paragraphs survive, every other tag is
 * removed, and entities are decoded through the module's shared
 * `decodeXmlEntities` (plus `&nbsp;`, which HTML has and XML does not). Runs
 * of blank lines collapse to one.
 *
 * Implemented as a SINGLE-PASS linear scanner, not regexes: the earlier
 * quote-aware tag regexes re-scanned the remaining body from every `<` when a
 * quoted attribute never closed — malformed input with many `<` characters
 * plus one unterminated quote pinned the server quadratically. The scanner is
 * quote-aware the same way (a `>` INSIDE a quoted attribute value, as in
 * `<a title="a > b">`, never ends the tag early) but amortizes the failures:
 * a scan that reaches end-of-input marks every `<` it passed OUTSIDE quotes
 * as known-literal (their scans would be identical tails), so no position is
 * rescanned from more than the three possible quote states. An unterminated
 * tag is literal text, not a tag — and so is a `<…>` span that names no
 * element at all, which is how `1 < 2 > 0` survives into the body.
 */
/** Elements whose CONTENT is not body text and is dropped with the element. */
const CONTAINER_TAGS = new Set(['script', 'style', 'head', 'title']);

/** Elements whose boundaries end a line, so paragraphs survive as paragraphs. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

// Depth bound shared with the OOXML/ODF extractors (`ooxml-text.ts`): mail
// nests a few dozen levels even at its most table-happy; a crafted body can
// nest as deep as it has bytes. What was read before the bound is kept.

export function htmlToEmailText(html: string): string {
  let s = '';
  let depth = 0;
  let skipping = 0; // inside a container whose content is not body text
  const parser = new Parser(
    {
      onopentag(name) {
        depth++;
        if (CONTAINER_TAGS.has(name)) skipping++;
        else if (name === 'br' || BLOCK_TAGS.has(name)) s += '\n';
        if (depth > MAX_ELEMENT_DEPTH) throw TOO_DEEP;
      },
      ontext(text) {
        if (skipping === 0) s += text;
      },
      onclosetag(name) {
        if (CONTAINER_TAGS.has(name)) {
          if (skipping > 0) skipping--;
        } else if (BLOCK_TAGS.has(name)) s += '\n';
        depth--;
      },
    },
    // HTML mode, not XML: an email body is HTML, with its void elements, its
    // implied closes, its raw-text `<script>`, and its named entities.
    { decodeEntities: true },
  );
  try {
    parser.write(html);
    parser.end();
  } catch (err) {
    if (err !== TOO_DEEP) throw err;
    parser.reset();
  }

  // `&nbsp;` decodes to U+00A0, which LOOKS like a space and is not one: an
  // agent grepping the extraction for "Para one" would miss a line that reads
  // exactly that. Extracted text is for reading and searching, so the
  // non-breaking space becomes an ordinary one.
  const out: string[] = [];
  for (const raw of s.replace(/ /g, ' ').split('\n')) {
    const line = raw.trim();
    if (line !== '') out.push(line);
    else if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** `name (mimeType, N bytes)` with the parenthesis dropped when nothing is known.
 * CR/LF in the metadata are shown as escapes rather than obeyed, so each
 * attachment stays on ONE line and grep line numbers hold. */
function attachmentLine(a: EmailAttachment): string {
  const details = [a.mimeType, a.sizeBytes !== undefined ? `${a.sizeBytes} bytes` : undefined]
    .filter((d): d is string => d !== undefined && d !== '')
    .join(', ');
  const line = details === '' ? a.name : `${a.name} (${details})`;
  return line.replace(/[\r\n]/g, (c) => (c === '\r' ? '\\r' : '\\n'));
}

/** A header value with its line breaks made visible instead of obeyed. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]/g, (c) => (c === '\r' ? '\\r' : '\\n'));
}

/** Render the model into the marker summary + extraction text (see module doc). */
export function emailExtraction(model: EmailModel): ExtractedDoc {
  const header: string[] = [];
  // Absent OR blank fields are omitted — a header marker is never printed empty.
  const pushHeader = (label: string, value: string | undefined): void => {
    if (value === undefined || value.trim() === '') return;
    // A header marker is ONE line. A From or Subject carrying CR/LF would
    // otherwise forge further lines into the extraction — including lines that
    // read like other markers — so the breaks are shown as escapes.
    header.push(`[${label}] ${oneLine(value)}`);
  };
  pushHeader('from', model.from);
  pushHeader('to', model.to);
  pushHeader('cc', model.cc);
  pushHeader('bcc', model.bcc);
  pushHeader('subject', model.subject);
  pushHeader('date', model.date);

  const sections: string[] = [];
  if (header.length > 0) sections.push(header.join('\n'));
  if (model.bodySource === 'rtf-only') sections.push(RTF_ONLY_BODY_LINE);
  else if (model.body !== '') sections.push(model.body);
  if (model.attachments.length > 0) {
    sections.push(`[attachments]\n${model.attachments.map(attachmentLine).join('\n')}`);
  }

  const n = model.attachments.length;
  const parts = ['email message'];
  if (n > 0) parts.push(`${n} attachment${n === 1 ? '' : 's'} listed (names only; not extracted)`);
  if (model.bodySource === 'html') parts.push('HTML body rendered as plain text');
  if (model.bodySource === 'rtf-only') parts.push('body is RTF; no plain-text part');
  parts.push('formatting and full headers omitted');

  return { summary: parts.join('; '), text: sections.join('\n\n') };
}
