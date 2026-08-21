import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { attachmentLine, htmlToEmailText, mailboxText } from '../emailMessage';
import { parseEmlMessage } from '../emlMessage';
import { parseMsgMessage } from '../msgMessage';

/**
 * The two client-side email parsers against REAL bytes — hand-written MIME
 * for `.eml`, real CFB containers (built with SheetJS's CFB writer, the same
 * library the parser reads them with) for `.msg`. The rendering of the model
 * is `EmailRenderer.test.tsx`'s job; this suite pins the model itself.
 */

// ── fixture builders ───────────────────────────────────────────────────────

const emlBytes = (lines: string[]): ArrayBuffer =>
  new TextEncoder().encode(lines.join('\r\n')).buffer as ArrayBuffer;

const utf16 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
};

interface CfbUtilsModule {
  utils: { cfb_new(): unknown; cfb_add(cfb: unknown, path: string, bytes: Uint8Array): void };
  write(cfb: unknown, opts: { type: 'array' }): Uint8Array | number[];
}

/** A MAPI properties stream: header zeros + 16-byte [tag, flags, value] records. */
function propertiesStream(headerLen: number, records: Array<[number, Uint8Array]>): Uint8Array {
  const out = new Uint8Array(headerLen + records.length * 16);
  records.forEach(([tag, value], i) => {
    const dv = new DataView(out.buffer, headerLen + i * 16, 16);
    dv.setUint32(0, tag, true);
    out.set(value.subarray(0, 8), headerLen + i * 16 + 8);
  });
  return out;
}

const longValue = (n: number): Uint8Array => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

function filetimeValue(iso: string): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, (BigInt(Date.parse(iso)) + 11644473600000n) * 10000n, true);
  return b;
}

/** REAL `.msg` bytes: a CFB container carrying the MAPI streams Outlook writes. */
function msgBytes(
  streams: Record<string, Uint8Array>, // path under the root → bytes
): ArrayBuffer {
  const CFB = XLSX.CFB as unknown as CfbUtilsModule;
  const cfb = CFB.utils.cfb_new();
  for (const [path, bytes] of Object.entries(streams)) CFB.utils.cfb_add(cfb, `/${path}`, bytes);
  const written = CFB.write(cfb, { type: 'array' });
  const u8 = written instanceof Uint8Array ? written : Uint8Array.from(written);
  return u8.slice().buffer as ArrayBuffer;
}

// ── .eml ───────────────────────────────────────────────────────────────────

describe('parseEmlMessage', () => {
  it('parses headers, prefers the plain-text part, and lists attachments with type and size', async () => {
    const view = await parseEmlMessage(
      emlBytes([
        'From: Ada Lovelace <ada@example.com>',
        'To: Bob <bob@example.com>, carol@example.com',
        'Cc: Dan <dan@example.com>',
        'Subject: Quarterly numbers',
        'Date: Mon, 5 Jan 2026 10:00:00 +0000',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: multipart/alternative; boundary="b2"',
        '',
        '--b2',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Please see attached.',
        '--b2',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Please see <b>attached</b>.</p>',
        '--b2--',
        '--b1',
        'Content-Type: application/pdf; name="report.pdf"',
        'Content-Disposition: attachment; filename="report.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQ=',
        '--b1--',
        '',
      ]),
    );
    expect(view.from).toBe('Ada Lovelace <ada@example.com>');
    expect(view.to).toBe('Bob <bob@example.com>, carol@example.com');
    expect(view.cc).toBe('Dan <dan@example.com>');
    expect(view.subject).toBe('Quarterly numbers');
    expect(view.date).toBe('2026-01-05T10:00:00.000Z');
    expect(view.body).toBe('Please see attached.');
    expect(view.bodySource).toBe('text');
    expect(view.attachments).toEqual([{ name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 8 }]);
  });

  it('strips an HTML-only body to text and says so through bodySource', async () => {
    const view = await parseEmlMessage(
      emlBytes([
        'From: ada@example.com',
        'Subject: styled',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<style>p{color:red}</style><h1>Title</h1><p>Para&nbsp;one &amp; two</p>',
      ]),
    );
    expect(view.body).toBe('Title\n\nPara one & two');
    expect(view.bodySource).toBe('html');
  });

  it('leaves absent headers undefined instead of inventing empty ones', async () => {
    const view = await parseEmlMessage(
      emlBytes(['From: ada@example.com', 'Subject: no recipients on file', '', 'draft body']),
    );
    expect(view.to).toBeUndefined();
    expect(view.cc).toBeUndefined();
    expect(view.date).toBeUndefined();
    expect(view.body).toBe('draft body');
  });

  it('throws the could-not-be-parsed error for bytes with no email headers', async () => {
    await expect(
      parseEmlMessage(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x01, 0x02, 0xff, 0xfe]).buffer as ArrayBuffer),
    ).rejects.toThrow('could not be parsed as a .eml (no email headers found)');
  });

  it('a valid email whose ONLY header is Bcc: is recognized, not rejected as header-less', async () => {
    const view = await parseEmlMessage(emlBytes(['Bcc: Eve <eve@example.com>', '', 'quiet copy']));
    expect(view.bcc).toBe('Eve <eve@example.com>');
    expect(view.body).toBe('quiet copy');
  });
});

// ── .msg ───────────────────────────────────────────────────────────────────

describe('parseMsgMessage', () => {
  it('parses sender, typed recipients, subject, date, body and attachments from real CFB bytes', () => {
    const view = parseMsgMessage(
      msgBytes({
        '__substg1.0_0037001F': utf16('Quarterly numbers'),
        '__substg1.0_0C1A001F': utf16('Ada Lovelace'),
        '__substg1.0_0C1F001F': utf16('ada@example.com'),
        '__substg1.0_1000001F': utf16('Please see attached.'),
        '__recip_version1.0_#00000000/__substg1.0_3001001F': utf16('Bob'),
        '__recip_version1.0_#00000000/__substg1.0_3003001F': utf16('bob@example.com'),
        '__recip_version1.0_#00000000/__properties_version1.0': propertiesStream(8, [[0x0c150003, longValue(1)]]),
        '__recip_version1.0_#00000001/__substg1.0_3001001F': utf16('Dan'),
        '__recip_version1.0_#00000001/__substg1.0_3003001F': utf16('dan@example.com'),
        '__recip_version1.0_#00000001/__properties_version1.0': propertiesStream(8, [[0x0c150003, longValue(2)]]),
        '__attach_version1.0_#00000000/__substg1.0_3707001F': utf16('report.pdf'),
        '__attach_version1.0_#00000000/__substg1.0_370E001F': utf16('application/pdf'),
        '__attach_version1.0_#00000000/__substg1.0_37010102': new TextEncoder().encode('PDFDATA'),
        '__properties_version1.0': propertiesStream(32, [[0x00390040, filetimeValue('2026-01-05T10:00:00Z')]]),
      }),
    );
    expect(view.from).toBe('Ada Lovelace <ada@example.com>');
    expect(view.to).toBe('Bob <bob@example.com>');
    expect(view.cc).toBe('Dan <dan@example.com>');
    expect(view.subject).toBe('Quarterly numbers');
    expect(view.date).toBe('2026-01-05T10:00:00.000Z');
    expect(view.body).toBe('Please see attached.');
    expect(view.bodySource).toBe('text');
    expect(view.attachments).toEqual([{ name: 'report.pdf', mimeType: 'application/pdf', sizeBytes: 7 }]);
  });

  it('strips an HTML-only body, and reports an RTF-only body honestly', () => {
    const html = parseMsgMessage(
      msgBytes({ '__substg1.0_1013001F': utf16('<p>Hello <b>there</b></p><div>bye</div>') }),
    );
    expect(html.body).toBe('Hello there\n\nbye');
    expect(html.bodySource).toBe('html');

    const rtf = parseMsgMessage(
      msgBytes({
        '__substg1.0_0037001F': utf16('compressed'),
        '__substg1.0_10090102': new Uint8Array([1, 2, 3, 4]),
      }),
    );
    expect(rtf.body).toBe('');
    expect(rtf.bodySource).toBe('rtf-only');
  });

  it('keeps a recipient whose PidTagRecipientType carries MAPI flag bits', () => {
    // The raw PT_LONG may be MAPI_P1 (0x10000000) | the base type on a
    // resubmitted message. Masking the flag bits off is what the backend's
    // `extract-msg.ts` `recipientBucket` does, so the viewer and an agent's
    // `read_file` file the same recipient under the same header.
    const view = parseMsgMessage(
      msgBytes({
        '__substg1.0_0037001F': utf16('resubmitted'),
        '__recip_version1.0_#00000000/__substg1.0_3001001F': utf16('Bob'),
        '__recip_version1.0_#00000000/__substg1.0_3003001F': utf16('bob@example.com'),
        '__recip_version1.0_#00000000/__properties_version1.0': propertiesStream(8, [
          [0x0c150003, longValue(0x10000001)],
        ]),
        '__recip_version1.0_#00000001/__substg1.0_3001001F': utf16('Dan'),
        '__recip_version1.0_#00000001/__substg1.0_3003001F': utf16('dan@example.com'),
        '__recip_version1.0_#00000001/__properties_version1.0': propertiesStream(8, [
          [0x0c150003, longValue(0x10000002)],
        ]),
        '__recip_version1.0_#00000002/__substg1.0_3001001F': utf16('Eve'),
        '__recip_version1.0_#00000002/__substg1.0_3003001F': utf16('eve@example.com'),
        '__recip_version1.0_#00000002/__properties_version1.0': propertiesStream(8, [
          [0x0c150003, longValue(0x10000003)],
        ]),
      }),
    );
    expect(view.to).toBe('Bob <bob@example.com>');
    expect(view.cc).toBe('Dan <dan@example.com>');
    expect(view.bcc).toBe('Eve <eve@example.com>');
  });

  it('decodes ANSI (001E) string properties when the unicode variant is absent', () => {
    const view = parseMsgMessage(
      msgBytes({ '__substg1.0_0037001E': new TextEncoder().encode('plain ansi subject') }),
    );
    expect(view.subject).toBe('plain ansi subject');
  });

  it('throws the could-not-be-parsed error for garbage bytes and for a CFB with no MAPI streams', () => {
    expect(() =>
      parseMsgMessage(new TextEncoder().encode('total garbage, not a CFB container').buffer as ArrayBuffer),
    ).toThrow('could not be parsed as a .msg');
    expect(() => parseMsgMessage(msgBytes({ SomeStream: utf16('x') }))).toThrow(
      'could not be parsed as a .msg (not an Outlook message file)',
    );
  });
});

// ── shared helpers ─────────────────────────────────────────────────────────

describe('email text helpers', () => {
  it('htmlToEmailText drops style/script whole, keeps paragraph structure, collapses blank runs', () => {
    expect(
      htmlToEmailText('<style>b{}</style><script>x()</script><p>one</p><p></p><p>two &#8212; three</p>'),
    ).toBe('one\n\ntwo — three');
  });

  it('htmlToEmailText never truncates a tag at a > inside a quoted attribute value', () => {
    expect(htmlToEmailText('<a title="a > b">x</a>')).toBe('x');
    expect(htmlToEmailText("<p align='x>y'>para</p>")).toBe('para');
    expect(htmlToEmailText('<br data-note="1 > 0"/>line')).toBe('line');
    expect(htmlToEmailText('<div class="a>b">block</div>')).toBe('block');
    expect(htmlToEmailText('<style media="x>y">b{}</style>rest')).toBe('rest');
  });

  it('htmlToEmailText treats an UNTERMINATED tag as literal text', () => {
    expect(htmlToEmailText('<p>total</p> 2 < 3')).toBe('total\n2 < 3');
    expect(htmlToEmailText('<a href="never closed>tail')).toBe('<a href="never closed>tail');
  });

  it('htmlToEmailText drops script/style/head/title whole — attributes and mixed case included', () => {
    expect(htmlToEmailText('<SCRIPT TYPE="text/javascript">evil()</SCRIPT>after')).toBe('after');
    expect(htmlToEmailText('<Style Media="print">b{}</STYLE>rest')).toBe('rest');
    expect(htmlToEmailText('<head><TITLE>t</TITLE></head>body')).toBe('body');
    expect(htmlToEmailText('<script>alert(1)')).toBe('alert(1)');
  });

  it('htmlToEmailText still turns br and block-tag boundaries into line breaks', () => {
    expect(htmlToEmailText('a<br>b<br/>c<BR />d')).toBe('a\nb\nc\nd');
    expect(htmlToEmailText('<h1>T</h1><div>d</div><li>i</li>')).toBe('T\n\nd\n\ni');
  });

  it('htmlToEmailText survives an adversarial body: 20k < plus an attribute quote that never closes', () => {
    // The shape the old quote-aware tag regexes died on — each `<` restarted a
    // lazy expansion that could never pass the unclosed quote, freezing the
    // tab on a message an attacker could simply send. The bound is loose on
    // purpose: it catches a return of the blow-up, not CI's scheduler.
    const bomb = '<'.repeat(20_000) + '<b title="never closed ' + 'x'.repeat(2_000) + '>';
    const t0 = performance.now();
    const out = htmlToEmailText(bomb);
    const ms = performance.now() - t0;
    expect(out).toBe(bomb); // no tag ever terminates: it is all body text
    expect(ms).toBeLessThan(5_000);
  });

  it('htmlToEmailText keeps its offsets when the body holds an İ (U+0130)', () => {
    // The lowercase copy is INDEX-PARALLEL with the original: tag names are
    // sliced out of it at offsets computed on `html`, and container-close
    // offsets found in it are fed back into `html`. `String.toLowerCase` is
    // not length-preserving — `İ` becomes `i` plus a combining dot — so after
    // one of these every later index was off by one: the `<script>` stopped
    // being recognized and its code was rendered as body text.
    expect(htmlToEmailText('İ<script>alert(1)</script>after')).toBe('İafter');
    expect(htmlToEmailText('İ<p>one</p><p>two</p>')).toBe('İ\none\n\ntwo');
    expect(htmlToEmailText('<p>aİb</p><style>c{}</style>tail')).toBe('aİb\ntail');
  });

  it('htmlToEmailText keeps a comparison as text: `1 < 2 > 0` is not a tag', () => {
    // The span parses an EMPTY tag name. Advancing past it anyway discarded
    // `< 2 >` from the visible body — this used to read `1  0`.
    expect(htmlToEmailText('<p>1 < 2 > 0</p>')).toBe('1 < 2 > 0');
    expect(htmlToEmailText('a <, b > c and <1>d')).toBe('a <, b > c and <1>d');
    expect(htmlToEmailText('x </ 2 > y')).toBe('x </ 2 > y');
  });

  it('htmlToEmailText still removes real tags, markup declarations and quoted `>`', () => {
    expect(htmlToEmailText('<!DOCTYPE html><p>doc</p>')).toBe('doc');
    expect(htmlToEmailText('<?xml version="1.0"?><p>pi</p>')).toBe('pi');
    expect(htmlToEmailText('<a title="a > b">x</a>')).toBe('x');
    expect(htmlToEmailText('<o:p>word</o:p><my-widget>custom</my-widget>')).toBe('wordcustom');
  });

  it('htmlToEmailText stays linear on a wall of comparison spans before one far `>`', () => {
    // Leaving a nameless span as text means the scanner no longer consumes it,
    // so the next `<` starts a fresh tag scan — and a failure-only memo would
    // record nothing here, because every one of these scans SUCCEEDS at the
    // single `>` past the wall. Memoizing successes as well keeps it to one
    // traversal; without it this is 50k x 100k characters, in the user's tab.
    const bomb = '< '.repeat(50_000) + '<p>end</p>';
    const t0 = performance.now();
    const out = htmlToEmailText(bomb);
    const ms = performance.now() - t0;
    expect(out.endsWith('end')).toBe(true);
    expect(out).toContain('< <');
    expect(ms).toBeLessThan(5_000);
  });

  it('mailboxText renders whichever of name/address exists', () => {
    expect(mailboxText('Ada', 'ada@example.com')).toBe('Ada <ada@example.com>');
    expect(mailboxText(undefined, 'ada@example.com')).toBe('ada@example.com');
    expect(mailboxText('Ada', undefined)).toBe('Ada');
    expect(mailboxText(undefined, undefined)).toBeUndefined();
  });

  it('attachmentLine prints only what is known', () => {
    expect(attachmentLine({ name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 8 })).toBe(
      'a.pdf (application/pdf, 8 bytes)',
    );
    expect(attachmentLine({ name: 'a.pdf' })).toBe('a.pdf');
  });

  it('emailMessage never imports pptxOutline — jszip must not be evaluated (or bundled) by the email chunk', () => {
    const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(read('../emailMessage.ts')).not.toContain("'./pptxOutline'");
    // The shared module both sides lean on must stay dependency-free.
    expect(read('../xmlEntities.ts')).not.toMatch(/^import /m);
  });
});
