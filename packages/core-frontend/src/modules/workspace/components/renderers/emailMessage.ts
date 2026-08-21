import { TAG_ATTRS, decodeXmlEntities } from './xmlEntities';

/**
 * The shared view model + text helpers for the email viewer (`EmailRenderer`),
 * the browser twin of the backend's `email-text.ts` — the same honest story
 * agents get through `read_file`: headers as labelled fields, the body as
 * PLAIN TEXT (the text part preferred, an HTML-only body stripped to text —
 * nothing from an email is ever rendered as HTML), attachments listed by
 * name. Parsers: `emlMessage.ts` (postal-mime) and `msgMessage.ts` (CFB via
 * SheetJS) fill this model; the renderer never sees a format.
 */

export interface EmailAttachmentView {
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

/** Where the body text came from — drives the honest notes in the viewer. */
export type EmailBodySource = 'text' | 'html' | 'rtf-only' | 'none';

export interface EmailMessageView {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** ISO timestamp when the date parsed, the raw header value otherwise. */
  date?: string;
  /** Plain-text body ('' when there is none, or it exists only as RTF). */
  body: string;
  bodySource: EmailBodySource;
  attachments: EmailAttachmentView[];
}

/** The 50 MB raw-size bound the backend extractors apply — mirrored client-side. */
export const MAX_EMAIL_BYTES = 50 * 1024 * 1024;

/**
 * Strip an HTML email body to plain text — the same deliberately simple pass
 * as the backend's `email-text.ts`: `<style>`/`<script>`/`<head>` containers
 * and comments dropped whole, `<br>` and block-tag boundaries become
 * newlines so paragraphs survive, every other tag removed, entities decoded
 * (the shared XML five + numeric via `decodeXmlEntities`, plus `&nbsp;`).
 * Runs of blank lines collapse to one.
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

/** `Name <addr>` / `Name` / `addr` — whatever the message carries. */
export function mailboxText(name: string | undefined, address: string | undefined): string | undefined {
  const n = name?.trim() ?? '';
  const a = address?.trim() ?? '';
  if (n !== '' && a !== '' && n !== a) return `${n} <${a}>`;
  if (a !== '') return a;
  return n !== '' ? n : undefined;
}

/** `name (mimeType, N bytes)` with the parenthesis dropped when nothing is known. */
export function attachmentLine(a: EmailAttachmentView): string {
  const details = [a.mimeType, a.sizeBytes !== undefined ? `${a.sizeBytes} bytes` : undefined]
    .filter((d): d is string => d !== undefined && d !== '')
    .join(', ');
  return details === '' ? a.name : `${a.name} (${details})`;
}

/** Normalize a date header/property to ISO; keep the raw value when unparseable. */
export function isoDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}
