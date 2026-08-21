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
