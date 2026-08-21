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
import { decodeXmlEntities } from './ooxml-text.js';

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
 * tag is literal text, not a tag.
 */
const CONTAINER_TAGS = new Set(['script', 'style', 'head', 'title']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/**
 * Index just past the `>` closing the tag that opens at `start`, or -1 when
 * the tag never terminates. Tracks quote state so a quoted `>` never ends the
 * tag. On failure, every `<` passed while OUTSIDE quotes is recorded in
 * `knownLiteral` — a scan from such a position is exactly this scan's tail,
 * so it too would fail; recording it keeps the whole pass linear.
 */
function scanTagEnd(html: string, start: number, knownLiteral: Set<number>): number {
  let quote: '"' | "'" | null = null;
  const passedUnquoted: number[] = [];
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i + 1;
    else if (c === '<') passedUnquoted.push(i);
  }
  for (const p of passedUnquoted) knownLiteral.add(p);
  return -1;
}

/**
 * Index just past the `</name␣*>` that closes a container opened before
 * `from`, or -1. `noClose` memoizes a search that reached end-of-input — every
 * later search starts further right, so it would fail too.
 */
function containerCloseEnd(lower: string, name: string, from: number, noClose: Set<string>): number {
  if (noClose.has(name)) return -1;
  const needle = '</' + name;
  let idx = lower.indexOf(needle, from);
  while (idx !== -1) {
    let k = idx + needle.length;
    while (k < lower.length && /\s/.test(lower[k])) k++;
    if (lower[k] === '>') return k + 1;
    idx = lower.indexOf(needle, idx + 1);
  }
  noClose.add(name);
  return -1;
}

export function htmlToEmailText(html: string): string {
  const lower = html.toLowerCase();
  const lastGt = html.lastIndexOf('>');
  const knownLiteral = new Set<number>();
  const noContainerClose = new Set<string>();
  let commentSearchExhausted = false;
  let s = '';
  let textStart = 0;
  let i = 0;
  while (i < html.length) {
    if (html[i] !== '<') {
      i++;
      continue;
    }
    // No `>` remains, or a previous failing scan proved this `<` unterminated:
    // it is literal text (stays in the pending text run).
    if (i > lastGt || knownLiteral.has(i)) {
      i++;
      continue;
    }
    if (!commentSearchExhausted && html.startsWith('<!--', i)) {
      const close = html.indexOf('-->', i + 4);
      if (close !== -1) {
        s += html.slice(textStart, i);
        textStart = i = close + 3;
        continue;
      }
      commentSearchExhausted = true; // no `-->` this far right, nor further — generic tag scan below
    }
    const end = scanTagEnd(html, i, knownLiteral);
    if (end === -1) {
      i++; // unterminated tag: the `<` is literal text
      continue;
    }
    s += html.slice(textStart, i);
    let p = i + 1;
    const closing = html[p] === '/';
    if (closing) p++;
    let q = p;
    while (q < end - 1 && !/[\s/>]/.test(html[q])) q++;
    const name = lower.slice(p, q);
    if (!closing && CONTAINER_TAGS.has(name) && (q === end - 1 || /\s/.test(html[q]))) {
      // `<style>` / `<style attrs>`: drop the whole container through the
      // matching `</style␣*>`; with no close, only the open tag is removed.
      const closeEnd = containerCloseEnd(lower, name, end, noContainerClose);
      textStart = i = closeEnd !== -1 ? closeEnd : end;
      continue;
    }
    if ((name === 'br' && !closing) || BLOCK_TAGS.has(name)) s += '\n';
    textStart = i = end;
  }
  s += html.slice(textStart);
  s = decodeXmlEntities(s.replace(/&nbsp;/gi, ' '));
  const out: string[] = [];
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (line !== '') out.push(line);
    else if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** `name (mimeType, N bytes)` with the parenthesis dropped when nothing is known. */
function attachmentLine(a: EmailAttachment): string {
  const details = [a.mimeType, a.sizeBytes !== undefined ? `${a.sizeBytes} bytes` : undefined]
    .filter((d): d is string => d !== undefined && d !== '')
    .join(', ');
  return details === '' ? a.name : `${a.name} (${details})`;
}

/** Render the model into the marker summary + extraction text (see module doc). */
export function emailExtraction(model: EmailModel): ExtractedDoc {
  const header: string[] = [];
  if (model.from !== undefined) header.push(`[from] ${model.from}`);
  if (model.to !== undefined) header.push(`[to] ${model.to}`);
  if (model.cc !== undefined) header.push(`[cc] ${model.cc}`);
  if (model.bcc !== undefined) header.push(`[bcc] ${model.bcc}`);
  if (model.subject !== undefined) header.push(`[subject] ${model.subject}`);
  if (model.date !== undefined) header.push(`[date] ${model.date}`);

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
