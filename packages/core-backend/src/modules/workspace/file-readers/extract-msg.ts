import MsgReaderImport from '@kenjiuno/msgreader';
import type { ExtractResult } from './doc-extract.types.js';
import { emailExtraction, htmlToEmailText, type EmailAttachment, type EmailModel } from './email-text.js';
import { MAX_DOC_PART_BYTES } from './ooxml-text.js';

/**
 * Extract a `.msg` (Outlook item, CFB container) email into the shared email
 * text shape (see `email-text.ts`).
 *
 * Parsing is `@kenjiuno/msgreader` (HiraokaHyperTools, Apache-2.0) — the
 * maintained MAPI/CFB reader. It never throws for bad content of its own
 * accord: unparseable bytes come back as `{ dataType: null, error }`, which
 * maps onto the typed could-not-be-parsed failure here.
 *
 * Body preference mirrors `.eml`: the plain-text `PidTagBody` first, an HTML
 * body stripped to text second. An Outlook item whose body exists ONLY as
 * compressed RTF is degraded honestly — the extraction says
 * "[body is RTF; no plain-text part]" instead of pretending to decode RTF.
 */
export function extractMsg(bytes: Buffer): ExtractResult {
  if (bytes.length > MAX_DOC_PART_BYTES) {
    return {
      ok: false,
      message: `could not be extracted as a .msg (the file is ${bytes.length} bytes — over the ${MAX_DOC_PART_BYTES}-byte (50 MB) extraction limit)`,
    };
  }
  let fields: FieldsData;
  try {
    // DataView over the Buffer's exact region — no copy, and msgreader never
    // sees bytes outside the file.
    fields = new MsgReader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)).getFileData();
  } catch (err) {
    return { ok: false, message: `could not be parsed as a .msg (${(err as Error).message})` };
  }
  if (fields.dataType !== 'msg') {
    return {
      ok: false,
      message: `could not be parsed as a .msg (${fields.error ?? 'not an Outlook message file'})`,
    };
  }
  return { ok: true, ...emailExtraction(msgModel(fields)) };
}

/** msgreader's field data, shaped into the format-independent email model. */
function msgModel(fields: FieldsData): EmailModel {
  const recipients = fields.recipients ?? [];
  const text = fields.body !== undefined && fields.body.trim() !== '' ? fields.body : undefined;
  const html = htmlBody(fields);
  const body = text ?? (html !== undefined ? htmlToEmailText(html) : '');
  const bodySource: EmailModel['bodySource'] =
    text !== undefined ? 'text' : html !== undefined ? 'html' : fields.compressedRtf !== undefined ? 'rtf-only' : 'none';
  const date = fields.clientSubmitTime ?? fields.messageDeliveryTime;
  return {
    from: mailboxText(fields.senderName, fields.senderSmtpAddress ?? fields.senderEmail),
    to: recipientList(recipients, 'to'),
    cc: recipientList(recipients, 'cc'),
    bcc: recipientList(recipients, 'bcc'),
    subject: fields.subject,
    date: date !== undefined ? isoDate(date) : undefined,
    body: body.replace(/\s+$/, ''),
    bodySource,
    attachments: (fields.attachments ?? []).map(
      (a): EmailAttachment => ({
        name: a.fileName ?? a.fileNameShort ?? a.name ?? 'unnamed attachment',
        mimeType: a.attachMimeTag,
        sizeBytes: a.contentLength,
      }),
    ),
  };
}

/** The HTML body, whichever MAPI property carries it (string, or utf-8 bytes). */
function htmlBody(fields: FieldsData): string | undefined {
  if (fields.bodyHtml !== undefined && fields.bodyHtml.trim() !== '') return fields.bodyHtml;
  if (fields.html instanceof Uint8Array && fields.html.length > 0) {
    return Buffer.from(fields.html).toString('utf8');
  }
  return undefined;
}

/** `Name <addr>` / `Name` / `addr` — whatever the message carries. */
function mailboxText(name: string | undefined, address: string | undefined): string | undefined {
  const n = name?.trim() ?? '';
  const a = address?.trim() ?? '';
  if (n !== '' && a !== '' && n !== a) return `${n} <${a}>`;
  if (a !== '') return a;
  return n !== '' ? n : undefined;
}

/** The comma-joined mailboxes of one recipient type. Untyped recipients count as `to`. */
function recipientList(recipients: readonly FieldsData[], type: 'to' | 'cc' | 'bcc'): string | undefined {
  const s = recipients
    .filter((r) => (r.recipType ?? 'to') === type)
    .map((r) => mailboxText(r.name, r.smtpAddress ?? r.email))
    .filter((t): t is string => t !== undefined)
    .join(', ');
  return s === '' ? undefined : s;
}

/** msgreader emits RFC-1123 GMT strings; normalize to ISO, keep raw when unparseable. */
function isoDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

/**
 * CJS/ESM interop: msgreader is CJS with a transpiled `exports.default`.
 * Vitest's transform hands the class straight through the default import, but
 * NATIVE Node ESM (the built `dist/`) hands the exports OBJECT — so unwrap
 * `.default` when it is there.
 */
type MsgReaderClass = typeof MsgReaderImport;
const MsgReader: MsgReaderClass =
  (MsgReaderImport as unknown as { default?: MsgReaderClass }).default ?? MsgReaderImport;
type FieldsData = ReturnType<InstanceType<MsgReaderClass>['getFileData']>;
