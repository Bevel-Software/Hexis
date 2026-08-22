import * as XLSX from 'xlsx';
import {
  MAX_EMAIL_BYTES,
  MAX_INLINE_IMAGE_TOTAL_BYTES,
  htmlToEmailText,
  isInlineImagePart,
  isoDate,
  mailboxText,
  type EmailAttachmentView,
  type EmailBodySource,
  type EmailMessageView,
} from './emailMessage';

/**
 * Client-side `.msg` (Outlook item) → `EmailMessageView`.
 *
 * The backend reads `.msg` through `@kenjiuno/msgreader`; that library does
 * NOT load in the browser (its iconv-lite dependency needs Node's `Buffer`
 * at import time — verified by bundling for a browser target). So this is a
 * hand-rolled twin in the `pptxOutline.ts` tradition: the container is CFB
 * (the OLE compound file), which SheetJS — already in the bundle for the
 * spreadsheet viewer — parses via `XLSX.CFB`, and the handful of MAPI
 * property streams an email viewer needs are read directly:
 *
 *   `__substg1.0_<tag><type>`         string/binary properties
 *   `__recip_version1.0_#NNNNNNNN/`   one storage per recipient
 *   `__attach_version1.0_#NNNNNNNN/`  one storage per attachment
 *   `__properties_version1.0`         fixed 16-byte records (typed values)
 *
 * Type suffixes: `001F` = UTF-16LE string, `001E` = 8-bit string (decoded as
 * windows-1252 — the overwhelmingly common ANSI codepage; an exotic codepage
 * degrades to mojibake, never a crash), `0102` = binary. Body preference
 * mirrors the backend: plain text (1000), then HTML (1013) stripped to text,
 * then the honest RTF-only degradation when only compressed RTF (1009) exists.
 *
 * Throws an `Error` reading "could not be parsed as a .msg (…)" — shown
 * verbatim by the caller — for non-CFB bytes and CFB files with no MAPI
 * streams at all.
 */
/**
 * Drop retained bytes past the aggregate inline budget — one message may carry
 * many small images, and the per-part bound alone does not cap their sum. The
 * parts stay listed; only the bytes go.
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

export function parseMsgMessage(bytes: ArrayBuffer): EmailMessageView {
  if (bytes.byteLength > MAX_EMAIL_BYTES) {
    throw new Error(
      `could not be parsed as a .msg (the file is ${bytes.byteLength} bytes — over the 50 MB limit)`,
    );
  }
  let streams: Map<string, Uint8Array>;
  try {
    streams = cfbStreams(new Uint8Array(bytes));
  } catch (err) {
    throw new Error(`could not be parsed as a .msg (${(err as Error).message})`);
  }
  const hasMapi = [...streams.keys()].some(
    (p) => p.includes('__substg1.0_') || p.endsWith('__properties_version1.0'),
  );
  if (!hasMapi) {
    throw new Error('could not be parsed as a .msg (not an Outlook message file)');
  }

  // A message may carry an EMPTY plain-text property beside a real HTML body.
  // Treating '' as the body hid the HTML and claimed bodySource 'text', so the
  // viewer showed nothing at all. Blank is absent, exactly as extract-msg reads it.
  const text = blankToUndefined(stringProp(streams, '', '1000'));
  const html = blankToUndefined(stringProp(streams, '', '1013') ?? binaryUtf8(streams, '', '1013'));
  const hasRtf = streams.has('__substg1.0_10090102');
  const body = (text ?? (html !== undefined ? htmlToEmailText(html) : '')).replace(/\s+$/, '');
  const bodySource: EmailBodySource =
    text !== undefined ? 'text' : html !== undefined ? 'html' : hasRtf ? 'rtf-only' : 'none';

  const recipients = storageDirs(streams, '__recip_version1.0_#').map((dir) => ({
    text: mailboxText(stringProp(streams, dir, '3001'), stringProp(streams, dir, '39FE') ?? stringProp(streams, dir, '3003')),
    type: recipientType(streams.get(`${dir}__properties_version1.0`)),
  }));
  const listOf = (type: 'to' | 'cc' | 'bcc'): string | undefined => {
    const s = recipients
      .filter((r) => r.type === type)
      .map((r) => r.text)
      .filter((t): t is string => t !== undefined)
      .join(', ');
    return s === '' ? undefined : s;
  };

  return {
    from: mailboxText(
      stringProp(streams, '', '0C1A'),
      stringProp(streams, '', '5D01') ?? stringProp(streams, '', '0C1F'),
    ),
    to: listOf('to'),
    cc: listOf('cc'),
    bcc: listOf('bcc'),
    subject: stringProp(streams, '', '0037'),
    date: messageDate(streams.get('__properties_version1.0')),
    body,
    bodyHtml: html,
    bodySource,
    attachments: inlineBudgeted(
      storageDirs(streams, '__attach_version1.0_#').map((dir): EmailAttachmentView => {
        const content = streams.get(`${dir}__substg1.0_37010102`);
        const mimeType = stringProp(streams, dir, '370E');
        // PidTagAttachContentId (0x3712) — what an HTML body's `cid:` names.
        const contentId = stringProp(streams, dir, '3712')?.replace(/^<|>$/g, '');
        return {
          name:
            stringProp(streams, dir, '3707') ??
            stringProp(streams, dir, '3704') ??
            stringProp(streams, dir, '3001') ??
            'unnamed attachment',
          mimeType,
          sizeBytes: content?.byteLength,
          contentId,
          bytes:
            content && isInlineImagePart(mimeType, contentId, content.byteLength) ? content : undefined,
        };
      }),
    ),
  };
}

// ── CFB access (SheetJS `XLSX.CFB` is typed loosely — shape pinned here) ───

interface CfbEntry {
  content?: Uint8Array | number[] | null;
}
interface CfbContainer {
  FullPaths: string[];
  FileIndex: CfbEntry[];
}
interface CfbModule {
  read(data: Uint8Array, opts: { type: 'array' }): CfbContainer;
}

/** Every stream in the container, keyed by its path RELATIVE to the root storage. */
function cfbStreams(bytes: Uint8Array): Map<string, Uint8Array> {
  const cfb = (XLSX.CFB as unknown as CfbModule).read(bytes, { type: 'array' });
  const out = new Map<string, Uint8Array>();
  cfb.FullPaths.forEach((fullPath, i) => {
    const content = cfb.FileIndex[i]?.content;
    if (content == null || fullPath.endsWith('/')) return; // storage, not a stream
    // 'Root Entry/__substg1.0_0037001F' → '__substg1.0_0037001F'
    const rel = fullPath.slice(fullPath.indexOf('/') + 1);
    out.set(rel, content instanceof Uint8Array ? content : Uint8Array.from(content));
  });
  return out;
}

/** The numbered `__recip_…`/`__attach_…` storage prefixes present, in index order. */
function storageDirs(streams: Map<string, Uint8Array>, prefix: string): string[] {
  const dirs = new Set<string>();
  for (const path of streams.keys()) {
    if (path.startsWith(prefix)) dirs.add(path.slice(0, prefix.length + 8) + '/');
  }
  return [...dirs].sort();
}

/** A string property: the UTF-16LE variant (`001F`) preferred, the 8-bit one (`001E`) as fallback. */
function stringProp(streams: Map<string, Uint8Array>, dir: string, id: string): string | undefined {
  const unicode = streams.get(`${dir}__substg1.0_${id}001F`);
  if (unicode !== undefined) return decodeText(unicode, 'utf-16le');
  const ansi = streams.get(`${dir}__substg1.0_${id}001E`);
  return ansi !== undefined ? decodeText(ansi, 'windows-1252') : undefined;
}

/** A binary (`0102`) property decoded as UTF-8 — how the HTML body is usually stored. */
function binaryUtf8(streams: Map<string, Uint8Array>, dir: string, id: string): string | undefined {
  const raw = streams.get(`${dir}__substg1.0_${id}0102`);
  return raw !== undefined && raw.byteLength > 0 ? decodeText(raw, 'utf-8') : undefined;
}

function decodeText(bytes: Uint8Array, encoding: string): string {
  const s = new TextDecoder(encoding).decode(bytes);
  // MAPI string streams may carry a trailing NUL terminator.
  return s.replace(/\0+$/, '');
}

/**
 * One typed value out of a `__properties_version1.0` stream: `headerLen`
 * bytes of header, then 16-byte records — property tag (u32 LE), flags,
 * 8 value bytes.
 */
function propertyValue(stream: Uint8Array | undefined, headerLen: number, tag: number): DataView | undefined {
  if (stream === undefined) return undefined;
  const dv = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  for (let i = headerLen; i + 16 <= stream.byteLength; i += 16) {
    if (dv.getUint32(i, true) === tag) return new DataView(stream.buffer, stream.byteOffset + i + 8, 8);
  }
  return undefined;
}

/**
 * `PidTagRecipientType` (0x0C15, PT_LONG): 1 = to, 2 = cc, 3 = bcc. Untyped
 * counts as `to`. The raw value may carry MAPI flag bits — `MAPI_SUBMITTED`
 * (0x80000000) or `MAPI_P1` (0x10000000) on a resubmitted message — so the
 * base type is masked out first (e.g. 0x10000002 is still `cc`), matching the
 * backend's `extract-msg.ts` `recipientBucket`.
 */
function recipientType(props: Uint8Array | undefined): 'to' | 'cc' | 'bcc' {
  const value = propertyValue(props, 8, 0x0c150003)?.getUint32(0, true);
  if (value === undefined) return 'to';
  const base = value & 0x0fffffff; // strip MAPI_SUBMITTED (0x80000000) / MAPI_P1 (0x10000000)
  return base === 2 ? 'cc' : base === 3 ? 'bcc' : 'to';
}

/** The sent (0x0039) or delivered (0x0E06) PT_SYSTIME from the root properties stream, as ISO. */
function messageDate(props: Uint8Array | undefined): string | undefined {
  // The root storage's properties stream has a 32-byte header.
  const value = propertyValue(props, 32, 0x00390040) ?? propertyValue(props, 32, 0x0e060040);
  if (value === undefined) return undefined;
  // FILETIME: 100ns ticks since 1601-01-01, little-endian u64.
  const ticks = value.getUint32(4, true) * 2 ** 32 + value.getUint32(0, true);
  const ms = ticks / 10000 - 11644473600000;
  return Number.isFinite(ms) ? isoDate(new Date(ms).toISOString()) : undefined;
}


/** '' and whitespace-only property values mean the property is not there. */
function blankToUndefined(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined;
}