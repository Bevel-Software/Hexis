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
import { TAG_ATTRS, decodeXmlEntities } from './ooxml-text.js';

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
 * stance as `ooxml-text.ts`): comments and `<style>`/`<script>`/`<head>`
 * containers are dropped whole, `<br>` and block-level tag boundaries become
 * newlines so paragraphs survive, every other tag is removed, and entities
 * are decoded through the module's shared `decodeXmlEntities` (plus `&nbsp;`,
 * which HTML has and XML does not). Runs of blank lines collapse to one.
 */
// Every attribute region below is the quote-aware `TAG_ATTRS` fragment, never
// `[^>]*`: a `>` INSIDE a quoted attribute value (`<a title="a > b">`) must not
// end the tag early and leak the attribute tail into the visible body text.
const CONTAINER_TAG_RE = new RegExp(
  String.raw`<(script|style|head|title)(?:\s${TAG_ATTRS})?>[\s\S]*?</\1\s*>`,
  'gi',
);
const BR_TAG_RE = new RegExp(String.raw`<br(?:\s${TAG_ATTRS})?/?>`, 'gi');
const BLOCK_TAG_RE = new RegExp(
  String.raw`</?(?:p|div|section|article|header|footer|main|table|thead|tbody|tfoot|tr|td|th|li|ul|ol|dl|dt|dd|blockquote|pre|hr|h[1-6])(?:\s${TAG_ATTRS})?/?>`,
  'gi',
);
const ANY_TAG_RE = new RegExp(String.raw`<${TAG_ATTRS}>`, 'g');

export function htmlToEmailText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(CONTAINER_TAG_RE, '');
  s = s.replace(BR_TAG_RE, '\n');
  s = s.replace(BLOCK_TAG_RE, '\n');
  s = s.replace(ANY_TAG_RE, '');
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
