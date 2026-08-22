import PostalMime from 'postal-mime';
import type { Address, Email } from 'postal-mime';
import {
  MAX_EMAIL_BYTES,
  MAX_INLINE_IMAGE_TOTAL_BYTES,
  htmlToEmailText,
  isInlineImagePart,
  isoDate,
  type EmailAttachmentView,
  type EmailMessageView,
} from './emailMessage';

/**
 * Client-side `.eml` → `EmailMessageView`, on the SAME parser the backend
 * extractor uses (`postal-mime` — pure ESM, dependency-free, runs in the
 * browser unchanged), so viewer and agent read one message the same way.
 *
 * Throws an `Error` whose message reads "could not be parsed as a .eml (…)"
 * — the caller shows it verbatim — for over-bound files and for bytes that
 * yield no email headers at all (postal-mime itself is lenient and would
 * "parse" random bytes to an empty message).
 */
export async function parseEmlMessage(bytes: ArrayBuffer): Promise<EmailMessageView> {
  if (bytes.byteLength > MAX_EMAIL_BYTES) {
    throw new Error(
      `could not be parsed as a .eml (the file is ${bytes.byteLength} bytes — over the 50 MB limit)`,
    );
  }
  let email: Email;
  try {
    email = await PostalMime.parse(new Uint8Array(bytes));
  } catch (err) {
    throw new Error(`could not be parsed as a .eml (${(err as Error).message})`);
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
    throw new Error('could not be parsed as a .eml (no email headers found)');
  }
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
    bodyHtml: html,
    bodySource: text !== undefined ? 'text' : html !== undefined ? 'html' : 'none',
    attachments: inlineBudgeted(
      email.attachments.map((a): EmailAttachmentView => {
        const bytes =
          typeof a.content === 'string' ? new TextEncoder().encode(a.content) : new Uint8Array(a.content);
        // postal-mime keeps the angle brackets: `<abc@host>`.
        const contentId = a.contentId?.replace(/^<|>$/g, '');
        return {
          name: a.filename ?? 'unnamed attachment',
          mimeType: a.mimeType,
          sizeBytes: bytes.byteLength,
          contentId,
          bytes: isInlineImagePart(a.mimeType, contentId, bytes.byteLength) ? bytes : undefined,
        };
      }),
    ),
  };
}

/**
 * Drop retained bytes past the aggregate inline budget: one message may carry
 * many small images, and the per-part bound alone does not cap their sum. The
 * parts stay listed — only the bytes go, and the picture simply does not draw.
 */
function inlineBudgeted(parts: EmailAttachmentView[]): EmailAttachmentView[] {
  let held = 0;
  return parts.map((part) => {
    if (part.bytes === undefined) return part;
    if (held + part.bytes.byteLength > MAX_INLINE_IMAGE_TOTAL_BYTES) return { ...part, bytes: undefined };
    held += part.bytes.byteLength;
    return part;
  });
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
