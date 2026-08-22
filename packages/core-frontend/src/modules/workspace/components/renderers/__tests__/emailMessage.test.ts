import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { attachmentLine, inlineBudgeted, mailboxText, referencedContentIds, type EmailAttachmentView } from '../emailMessage';
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

describe('an HTML body, as the viewer renders it', () => {
  /** The body text of an HTML-only message, through the parser the viewer uses. */
  const bodyOf = async (html: string): Promise<string> => {
    const view = await parseEmlMessage(
      emlBytes(['From: ada@example.com', 'Content-Type: text/html; charset=utf-8', '', html]),
    );
    return view.body;
  };

  it('drops style/script/head whole and keeps paragraph structure', async () => {
    expect(await bodyOf('<style>b{}</style><script>x()</script><p>one</p><p></p><p>two &#8212; three</p>')).toBe(
      'one\n\ntwo — three',
    );
    expect(await bodyOf('<SCRIPT TYPE="text/javascript">evil()</SCRIPT>after')).toBe('after');
    expect(await bodyOf('<Style Media="print">b{}</STYLE>rest')).toBe('rest');
    expect(await bodyOf('<head><TITLE>t</TITLE></head>body')).toBe('body');
  });

  it('never truncates a tag at a > inside a quoted attribute value', async () => {
    expect(await bodyOf('<a title="a > b">x</a>')).toBe('x');
    expect(await bodyOf("<p align='x>y'>para</p>")).toBe('para');
    expect(await bodyOf('<br data-note="1 > 0"/>line')).toBe('line');
    expect(await bodyOf('<div class="a>b">block</div>')).toBe('block');
    expect(await bodyOf('<style media="x>y">b{}</style>rest')).toBe('rest');
  });

  it('turns br and block-tag boundaries into line breaks', async () => {
    expect(await bodyOf('a<br>b<br/>c<BR />d')).toBe('a\nb\nc\nd');
    expect(await bodyOf('<h1>T</h1><div>d</div><li>i</li>')).toBe('T\n\nd\n\ni');
  });

  it('keeps a comparison in the body: `2 < 3` is text, not a tag', async () => {
    expect(await bodyOf('<p>total</p> 2 < 3')).toBe('total\n2 < 3');
  });

  it('CHANGED: reads malformed markup the way a mail client would', async () => {
    // These are htmlparser2's answers, which are a browser's — the useful
    // standard for a mail body, because it is what the sender's recipient saw.
    // The hand-rolled strip had rules of its own and they differed here.
    expect(await bodyOf('<a href="never closed>tail')).toBe('');
    expect(await bodyOf('<script>alert(1)')).toBe('');
    expect(await bodyOf('<script/x>secret</script>tail')).toBe('tail');
    expect(await bodyOf('x </ 2 > y')).toBe('x  y');
  });

  it('survives an adversarial body: 20k < plus an attribute quote that never closes', async () => {
    const bomb = '<'.repeat(20_000) + '<b title="never closed ' + 'x'.repeat(2_000) + '>';
    const t0 = performance.now();
    const out = await bodyOf(bomb);
    const ms = performance.now() - t0;
    expect(out).toBe('<'.repeat(20_000));
    expect(ms).toBeLessThan(5_000);
  });

  it('survives a body nested past any sane depth, keeping what it read', async () => {
    const t0 = performance.now();
    const out = await bodyOf('<p>top</p>' + '<div>'.repeat(200_000));
    const ms = performance.now() - t0;
    expect(out.startsWith('top')).toBe(true);
    expect(ms).toBeLessThan(5_000);
  });

  it('an İ before a container does not shift what gets dropped', async () => {
    // The strip this replaced kept an index-parallel lowercase copy, and
    // `String.toLowerCase` is not length-preserving — `İ` (U+0130) becomes two
    // code units — so after one of these a `<script>` stopped being
    // recognized and its source was shown to the reader.
    expect(await bodyOf('İ<script>alert(1)</script>after')).toBe('İafter');
    expect(await bodyOf('İ<p>one</p><p>two</p>')).toBe('İ\none\n\ntwo');
    expect(await bodyOf('<p>aİb</p><style>c{}</style>tail')).toBe('aİb\ntail');
  });

  it('a &nbsp; lands as an ordinary space, not U+00A0', async () => {
    // It LOOKS like a space and is not one: a reader searching the message for
    // "one two" would miss a line that reads exactly that.
    expect(await bodyOf('<p>one&nbsp;two</p>')).toBe('one two');
  });
});

describe('email helpers', () => {
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
    // It may import a parser; what it must NOT drag in is the presentation code.
    expect(read('../xmlReading.ts')).not.toContain('jszip');
    expect(read('../xmlReading.ts')).not.toContain("'./pptxOutline'");
  });
});

describe('the inline-image budget', () => {
  const part = (id: string, size: number): EmailAttachmentView => ({
    name: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: size,
    contentId: id,
    bytes: new Uint8Array(size),
  });

  it('spends the budget on the images the BODY shows, not on the ones that come first', () => {
    // 10 MB of unreferenced parts ahead of the one the message actually
    // displays: in document order they ate the budget and the shown picture
    // was the one that went undrawn.
    const parts = [part('unused-a', 6_000_000), part('unused-b', 6_000_000), part('shown', 1_000)];
    const out = inlineBudgeted(parts, referencedContentIds('<img src="cid:shown">'));
    expect(out.find((p) => p.contentId === 'shown')?.bytes).toBeDefined();
  });

  it('reads the cid: references an HTML body makes, however they are quoted', () => {
    const ids = referencedContentIds(`<img src="cid:A@x"><img src='cid:b@y'><td background="cid:<C@z>">`);
    expect([...ids].sort()).toEqual(['a@x', 'b@y', 'c@z']);
  });
});
