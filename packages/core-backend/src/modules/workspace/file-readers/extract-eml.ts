import PostalMime, { type Address, type Email } from 'postal-mime';
import type { ExtractResult } from './doc-extract.types.js';
import { emailExtraction, htmlToEmailText, type EmailAttachment, type EmailModel } from './email-text.js';
import { MAX_DOC_PART_BYTES } from './ooxml-text.js';

/**
 * Extract a `.eml` (RFC 822 / MIME) email into the shared email text shape
 * (see `email-text.ts`).
 *
 * Parsing is `postal-mime` (postalsys, MIT-0): small, dependency-free, ESM,
 * and the same code runs in the browser — which keeps the frontend viewer's
 * story identical to the agent's. It normalizes encoded-word headers and
 * multipart bodies, and hands the `Date:` header over as ISO when it parses.
 *
 * postal-mime is LENIENT — random bytes "parse" to an empty message rather
 * than throwing — so recognizability is checked here: a file yielding NO
 * email headers at all (no From/To/Cc/Bcc/Subject/Date/Message-ID) and no
 * attachments is not an email, and gets the typed could-not-be-parsed
 * failure instead of an empty extraction.
 */
export async function extractEml(bytes: Buffer): Promise<ExtractResult> {
  // The same raw-size bound the PDF extractor applies: no container to
  // pre-scan, so the bound is the file's size, checked before parsing.
  if (bytes.length > MAX_DOC_PART_BYTES) {
    return {
      ok: false,
      message: `could not be extracted as a .eml (the file is ${bytes.length} bytes — over the ${MAX_DOC_PART_BYTES}-byte (50 MB) extraction limit)`,
    };
  }
  let email: Email;
  try {
    email = await PostalMime.parse(bytes);
  } catch (err) {
    return { ok: false, message: `could not be parsed as a .eml (${(err as Error).message})` };
  }
  if (
    email.from === undefined &&
    email.to === undefined &&
    email.cc === undefined &&
    email.bcc === undefined &&
    email.subject === undefined &&
    email.date === undefined &&
    email.messageId === undefined &&
    email.attachments.length === 0
  ) {
    return { ok: false, message: 'could not be parsed as a .eml (no email headers found)' };
  }
  return { ok: true, ...emailExtraction(emlModel(email)) };
}

/** postal-mime's parse, shaped into the format-independent email model. */
function emlModel(email: Email): EmailModel {
  const text = email.text !== undefined && email.text.trim() !== '' ? email.text : undefined;
  const html = email.html !== undefined && email.html.trim() !== '' ? email.html : undefined;
  const body = text ?? (html !== undefined ? htmlToEmailText(html) : '');
  return {
    from: email.from && addressListText([email.from]),
    to: email.to && addressListText(email.to),
    cc: email.cc && addressListText(email.cc),
    bcc: email.bcc && addressListText(email.bcc),
    subject: email.subject,
    date: email.date !== undefined ? isoDate(email.date) : undefined,
    body: body.replace(/\s+$/, ''),
    bodySource: text !== undefined ? 'text' : html !== undefined ? 'html' : 'none',
    attachments: email.attachments.map(
      (a): EmailAttachment => ({
        name: a.filename ?? 'unnamed attachment',
        mimeType: a.mimeType,
        sizeBytes: typeof a.content === 'string' ? Buffer.byteLength(a.content) : a.content.byteLength,
      }),
    ),
  };
}

/** `Name <addr>, addr2, Group: member, member` — groups flattened inline. */
function addressListText(list: Address[]): string | undefined {
  const s = list
    .map(function one(a: Address): string {
      if (a.group !== undefined) return `${a.name}: ${a.group.map(one).join(', ')}`;
      if (a.address === undefined || a.address === '') return a.name;
      return a.name !== '' && a.name !== a.address ? `${a.name} <${a.address}>` : a.address;
    })
    .filter((t) => t !== '')
    .join(', ');
  return s === '' ? undefined : s;
}

/** postal-mime already normalizes parseable dates to ISO; keep the raw value when it could not. */
function isoDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}
