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
 * tag is literal text, not a tag — and so is a `<…>` span that names no
 * element at all, which is how `1 < 2 > 0` survives into the body.
 */
const CONTAINER_TAGS = new Set(['script', 'style', 'head', 'title']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/**
 * A length-preserving lowercase copy of `s`, mapping ASCII `A-Z` and nothing
 * else.
 *
 * `String.prototype.toLowerCase` is NOT length-preserving — `İ` (U+0130)
 * lowercases to `i` plus a combining dot, two code units where there was one
 * — and this copy is used as an INDEX-PARALLEL view of the original: tag
 * names are sliced out of it at offsets computed on `html`, and container
 * close tags are found in it at offsets fed back into `html`. One such
 * character anywhere in a body shifted every later index, so after it a
 * `<script>` was no longer recognized and its code reached the extracted
 * text, block tags stopped breaking lines, and a container's close offset
 * landed a character short and ate part of the body. HTML element names are
 * ASCII, so mapping only `A-Z` loses nothing.
 */
function asciiLowerCase(s: string): string {
  return s.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

/**
 * An element name as this strip is willing to recognize one: an ASCII letter
 * followed by name characters. `:` and `-` are in because email HTML is full
 * of `<o:p>` (Word) and custom elements. Anything else — an EMPTY name most
 * of all — is not a tag; see the call site.
 */
const TAG_NAME = /^[a-z][a-z0-9._:-]*$/;

/**
 * How many `<` positions {@link scanTagEnd}'s memo may hold before the strip
 * gives up on the body. The memo only ever grows on a `<` sitting INSIDE what
 * looks like a tag — malformed markup — so real mail never touches this;
 * bounding it keeps a crafted 50 MB body from turning into a map several
 * times its size. Stopping is the only bounded answer that stays linear:
 * evicting, or memoizing no further, restores the per-`<` rescan the memo
 * exists to prevent.
 */
const MAX_TAG_MEMO = 100_000;

/** {@link scanTagEnd}'s "the memo is full" answer — distinct from -1, "no `>`". */
const MEMO_EXHAUSTED = -2;

/**
 * Index just past the `>` closing the tag that opens at `start`, -1 when the
 * tag never terminates, or {@link MEMO_EXHAUSTED}. Tracks quote state so a
 * quoted `>` never ends the tag.
 *
 * Every `<` passed while OUTSIDE quotes is recorded in `known` with THIS
 * scan's answer, whether that answer is an end or -1: such a `<` was reached
 * in the no-quote state, so a tag starting there resumes the identical walk
 * and can only reach the identical end. Memoizing the SUCCESSES matters as
 * much as the failures now that a span naming no element stays literal text —
 * a wall of `< ` before one far-away `>` leaves every scan succeeding, and a
 * failure-only memo would record nothing and rescan the body per `<`.
 */
function scanTagEnd(html: string, start: number, known: Map<number, number>): number {
  let quote: '"' | "'" | null = null;
  const passedUnquoted: number[] = [];
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '>') {
      for (const p of passedUnquoted) known.set(p, i + 1);
      return i + 1;
    } else if (c === '<') {
      if (known.size + passedUnquoted.length >= MAX_TAG_MEMO) return MEMO_EXHAUSTED;
      passedUnquoted.push(i);
    }
  }
  for (const p of passedUnquoted) known.set(p, -1);
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

/**
 * The rest of a body the quote-aware walk gave up on (see {@link
 * MAX_TAG_MEMO}), read by the SAME rules but with a cheaper idea of where a
 * tag ends: every `<` pairs with the NEXT `>`, whatever quoting says, and a
 * `<` with no `>` after it is literal text. Two cursors that only move
 * forward, so this stays linear on exactly the input the quote-aware walk
 * could not afford.
 *
 * Only the tag BOUNDARY is cruder here — everything the strip means is kept:
 * `<script>`/`<style>` bodies are still dropped rather than displayed as
 * text, block tags and `<br>` still break lines, and a span that names no
 * element is still body text. Stripping tags blindly instead made the tail of
 * such a mail read as one run-on paragraph with the stylesheet in it.
 *
 * Dropping the remainder — what this replaced — was worse still: the message
 * vanished from the first crafted-looking span onward, and a reader cannot
 * tell that from a mail that simply said little.
 */
function looseStripFrom(html: string, lower: string, from: number, noClose: Set<string>): string {
  let out = '';
  let textStart = from;
  let i = from;
  // The `>` this scan is pairing against. It only moves FORWARD, refreshed
  // when the walk passes it — searching afresh from every `<` would rescan the
  // same tail for each one, which is the cost this fallback exists to avoid.
  let gt = -1;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (gt <= lt) gt = html.indexOf('>', lt + 1);
    if (gt === -1) break;
    let p = lt + 1;
    const closing = html[p] === '/';
    if (closing) p++;
    const markup = !closing && (html[p] === '!' || html[p] === '?');
    // A `<` inside the name region means this span is no tag — and it is where
    // the next candidate begins. Noting it keeps the walk MONOTONE: without
    // that, `<<<<…` before one far `>` scanned the whole name region again for
    // every `<`, and the fallback added to bound one quadratic was quadratic
    // itself. Nothing between `lt` and the nested `<` is a candidate, so
    // resuming there sees exactly what a character-by-character walk would.
    let q = p;
    let nested = -1;
    while (q < gt && !/[\s/>]/.test(html[q])) {
      if (html[q] === '<') {
        nested = q;
        break;
      }
      q++;
    }
    const name = nested === -1 ? lower.slice(p, q) : '';
    if (!markup && !TAG_NAME.test(name)) {
      // Names no element, so the `<` is body text — and the scan resumes at
      // the next candidate rather than past the whole span. Consuming to the
      // `>` swallowed whatever the span contained, and `< <script>evil()`
      // ends its span at the script tag's own `>`: the container was never
      // seen and its code was shown to the reader as text.
      i = nested === -1 ? lt + 1 : nested;
      continue;
    }
    out += html.slice(textStart, lt);
    // `<script/x>` names no container: `/` ends a name only as the `/` of a
    // `/>`. Without this the malformed tag opened a container here and hid the
    // message text up to the next `</script>`, which the real scan never does.
    if (!closing && CONTAINER_TAGS.has(name) && (q === gt || /\s/.test(html[q]))) {
      const closeEnd = containerCloseEnd(lower, name, gt + 1, noClose);
      textStart = i = closeEnd !== -1 ? closeEnd : gt + 1;
      continue;
    }
    if ((name === 'br' && !closing) || BLOCK_TAGS.has(name)) out += '\n';
    textStart = i = gt + 1;
  }
  return out + html.slice(textStart);
}

export function htmlToEmailText(html: string): string {
  const lower = asciiLowerCase(html);
  const lastGt = html.lastIndexOf('>');
  const known = new Map<number, number>();
  const noContainerClose = new Set<string>();
  let commentSearchExhausted = false;
  let memoExhausted = false;
  let s = '';
  let textStart = 0;
  let i = 0;
  while (i < html.length) {
    if (html[i] !== '<') {
      i++;
      continue;
    }
    const memo = known.size > 0 ? known.get(i) : undefined;
    // No `>` remains, or a previous scan proved this `<` unterminated: it is
    // literal text (stays in the pending text run).
    if (i > lastGt || memo === -1) {
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
    const end = memo !== undefined ? memo : scanTagEnd(html, i, known);
    if (end === MEMO_EXHAUSTED) {
      memoExhausted = true; // see MAX_TAG_MEMO: the body is abandoned here
      break;
    }
    if (end === -1) {
      i++; // unterminated tag: the `<` is literal text
      continue;
    }
    let p = i + 1;
    const closing = html[p] === '/';
    if (closing) p++;
    // `<!DOCTYPE …>`, a `<!-- …` whose `-->` never came, `<?xml …?>`: markup
    // that names no element but is still not body text, and is still removed.
    const markup = !closing && (html[p] === '!' || html[p] === '?');
    let q = p;
    while (q < end - 1 && !/[\s/>]/.test(html[q])) q++;
    const name = lower.slice(p, q);
    // A body that says `1 < 2 > 0` parses an EMPTY tag name here. Treating
    // the span as a tag anyway advanced past it, so the whole `< 2 >` was
    // dropped from the visible text; a span that names no element is text.
    if (!markup && !TAG_NAME.test(name)) {
      i++;
      continue;
    }
    s += html.slice(textStart, i);
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
  // The quote-aware walk stopped early only when the memo filled; the body
  // from there on is still the reader's mail, so it comes through the loose
  // strip rather than being dropped.
  s += memoExhausted
    ? looseStripFrom(html, lower, textStart, noContainerClose)
    : html.slice(textStart);
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
