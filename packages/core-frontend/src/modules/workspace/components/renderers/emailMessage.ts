import { Parser } from 'htmlparser2';

/**
 * The shared view model + text helpers for the email viewer (`EmailRenderer`),
 * the browser twin of the backend's `email-text.ts` — the same honest story
 * agents get through `read_file`: headers as labelled fields, the body as
 * text (`body` — the text part preferred, an HTML body stripped to text) plus
 * the sender's own HTML when there is one (`bodyHtml`), attachments listed by
 * name. `body` is what an agent reads through `read_file`; the viewer renders
 * `bodyHtml` in a sandbox that can neither run a script nor fetch a byte (see
 * `emailBody.ts`), so a human sees the message and an agent reads the same
 * message, without either being handed live markup. Parsers: `emlMessage.ts` (postal-mime) and `msgMessage.ts` (CFB via
 * SheetJS) fill this model; the renderer never sees a format.
 */

export interface EmailAttachmentView {
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  /**
   * The attachment's Content-ID with its angle brackets removed, when the
   * message gave it one. An HTML body references such a part as `cid:<id>`,
   * which is how a sender embeds a picture IN the message rather than linking
   * to one on their server.
   */
  contentId?: string;
  /**
   * Raw bytes — retained ONLY for a part small enough to inline and referenced
   * by Content-ID, because that is the only thing the viewer renders from
   * bytes. An ordinary 40 MB attachment is described, never held.
   */
  bytes?: Uint8Array;
}

/** Bounds on what may be held in memory for inline rendering. */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_INLINE_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;

/**
 * Should this part's bytes be kept for inline rendering? Only a Content-ID'd
 * image within bounds: everything else is listed by name and nothing more.
 */
export function isInlineImagePart(mimeType: string | undefined, contentId: string | undefined, size: number): boolean {
  return (
    contentId !== undefined &&
    contentId !== '' &&
    (mimeType ?? '').toLowerCase().startsWith('image/') &&
    size > 0 &&
    size <= MAX_INLINE_IMAGE_BYTES
  );
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
  /**
   * The HTML body as the sender wrote it, when there is one. The viewer
   * renders this in a sandbox; `body` remains the text an agent reads, so the
   * two surfaces never disagree about what the message SAYS.
   */
  bodyHtml?: string;
  bodySource: EmailBodySource;
  attachments: EmailAttachmentView[];
}

/** The 50 MB raw-size bound the backend extractors apply — mirrored client-side. */
export const MAX_EMAIL_BYTES = 50 * 1024 * 1024;

/**
 * Strip an HTML email body to plain text — the same pass as the backend's
 * `email-text.ts`, so the viewer and `read_file` agree about what a message
 * says: `<style>`/`<script>`/`<head>`/`<title>` dropped whole, `<br>` and
 * block-tag boundaries become newlines, entities decoded, runs of blank lines
 * collapsed to one.
 *
 * Parsing is `htmlparser2` in HTML mode, because an email body IS html — with
 * its void elements, its implied closes, its raw-text `<script>` and its named
 * entities — and because the hand-rolled strip this replaced had to be taught
 * those rules one crafted message at a time, in a tab the reader cannot close
 * while its main thread is pinned.
 */
const CONTAINER_TAGS = new Set(['script', 'style', 'head', 'title']);
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]);

/**
 * How deep the element stack may go before the strip gives up on the rest of
 * the body. Mail nests a few dozen levels even at its most table-happy; a
 * crafted body can nest as deep as it has bytes, and the parser holds a stack
 * entry per open element. What was read before the bound is kept.
 */
const MAX_ELEMENT_DEPTH = 1_000;

/** Thrown to stop the parse at {@link MAX_ELEMENT_DEPTH}; never leaves this module. */
const TOO_DEEP = Symbol('too deep');

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
    { decodeEntities: true },
  );
  try {
    parser.write(html);
    parser.end();
  } catch (err) {
    if (err !== TOO_DEEP) throw err;
    parser.reset();
  }

  // `&nbsp;` decodes to U+00A0, which LOOKS like a space and is not one — a
  // reader searching the message for "one two" would miss a line that reads
  // exactly that.
  const out: string[] = [];
  const NBSP = /\u00a0/g;
  for (const raw of s.replace(NBSP, ' ').split('\n')) {
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
