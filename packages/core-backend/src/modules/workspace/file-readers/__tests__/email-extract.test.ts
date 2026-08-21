import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { RTF_ONLY_BODY_LINE } from '../email-text.js';
import { extractEml } from '../extract-eml.js';
import { extractMsg } from '../extract-msg.js';
import { MAX_DOC_PART_BYTES } from '../ooxml-text.js';

/**
 * REAL fixtures, no mocks — the same stance as doc-extract.test.ts:
 *
 *  - `.eml` fixtures are hand-written MIME, byte for byte.
 *  - `.msg` fixtures are REAL CFB containers built in-test with SheetJS's CFB
 *    writer (`XLSX.CFB`), carrying the actual MAPI streams
 *    (`__substg1.0_<tag><type>`, `__recip_…`, `__attach_…`,
 *    `__properties_version1.0`) an Outlook save produces — msgreader parses
 *    them exactly as it parses Outlook's output. (A smoke-check against a
 *    file saved by a real Outlook remains worthwhile; the container layout is
 *    identical but Outlook stamps many more properties.)
 */

// ── .eml fixture builders ──────────────────────────────────────────────────

const CRLF = '\r\n';

function emlBytes(lines: string[]): Buffer {
  return Buffer.from(lines.join(CRLF), 'utf8');
}

const MIXED_EML = emlBytes([
  'From: Ada Lovelace <ada@example.com>',
  'To: Bob <bob@example.com>, carol@example.com',
  'Cc: Dan <dan@example.com>',
  'Subject: Quarterly numbers',
  'Date: Mon, 5 Jan 2026 10:00:00 +0000',
  'Message-ID: <m1@example.com>',
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
  'Second line.',
  '--b2',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Please see <b>attached</b>.</p><p>Second line.</p>',
  '--b2--',
  '--b1',
  'Content-Type: application/pdf; name="report.pdf"',
  'Content-Disposition: attachment; filename="report.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  'JVBERi0xLjQ=', // "%PDF-1.4" — 8 bytes decoded
  '--b1',
  'Content-Type: text/csv; name="data.csv"',
  'Content-Disposition: attachment; filename="data.csv"',
  '',
  'a,b',
  '--b1--',
  '',
]);

// ── .msg fixture builders (real CFB bytes via SheetJS) ─────────────────────

const utf16 = (s: string): Buffer => Buffer.from(s, 'utf16le');

/**
 * A MAPI `__properties_version1.0` stream: `headerLen` zero bytes, then
 * 16-byte records — tag (u32 LE: id<<16 | type), flags, 8 value bytes.
 */
function propertiesStream(headerLen: number, records: Array<[number, Buffer]>): Buffer {
  const rows = records.map(([tag, value]) => {
    const b = Buffer.alloc(16);
    b.writeUInt32LE(tag >>> 0, 0);
    value.copy(b, 8);
    return b;
  });
  return Buffer.concat([Buffer.alloc(headerLen), ...rows]);
}

const longValue = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(n, 0);
  return b;
};

/** PT_SYSTIME value: FILETIME (100ns ticks since 1601) for the given ISO instant. */
function filetimeValue(iso: string): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE((BigInt(Date.parse(iso)) + 11644473600000n) * 10000n);
  return b;
}

interface MsgSpec {
  strings?: Record<string, string>; // '0037' → subject, unicode substg streams
  recipients?: Array<{ name?: string; email?: string; type?: number }>; // 1 to / 2 cc / 3 bcc
  attachments?: Array<{ name?: string; mime?: string; content?: Buffer }>;
  rtf?: boolean;
  submitTimeIso?: string;
}

/** REAL `.msg` bytes: a CFB container with the MAPI streams Outlook writes. */
function msgBytes(spec: MsgSpec): Buffer {
  const cfb = XLSX.CFB.utils.cfb_new();
  const add = (path: string, bytes: Buffer): void => {
    XLSX.CFB.utils.cfb_add(cfb, path, bytes);
  };
  for (const [id, value] of Object.entries(spec.strings ?? {})) add(`/__substg1.0_${id}001F`, utf16(value));
  (spec.recipients ?? []).forEach((r, i) => {
    const dir = `/__recip_version1.0_#${i.toString(16).toUpperCase().padStart(8, '0')}`;
    if (r.name !== undefined) add(`${dir}/__substg1.0_3001001F`, utf16(r.name));
    if (r.email !== undefined) add(`${dir}/__substg1.0_3003001F`, utf16(r.email));
    if (r.type !== undefined) add(`${dir}/__properties_version1.0`, propertiesStream(8, [[0x0c150003, longValue(r.type)]]));
  });
  (spec.attachments ?? []).forEach((a, i) => {
    const dir = `/__attach_version1.0_#${i.toString(16).toUpperCase().padStart(8, '0')}`;
    if (a.name !== undefined) add(`${dir}/__substg1.0_3707001F`, utf16(a.name));
    if (a.mime !== undefined) add(`${dir}/__substg1.0_370E001F`, utf16(a.mime));
    if (a.content !== undefined) add(`${dir}/__substg1.0_37010102`, a.content);
  });
  if (spec.rtf) add('/__substg1.0_10090102', Buffer.from([1, 2, 3, 4]));
  if (spec.submitTimeIso !== undefined) {
    add('/__properties_version1.0', propertiesStream(32, [[0x00390040, filetimeValue(spec.submitTimeIso)]]));
  }
  return XLSX.CFB.write(cfb, { type: 'buffer' }) as Buffer;
}

// ── .eml extraction ────────────────────────────────────────────────────────

describe('extractEml', () => {
  it('extracts the header block, prefers the plain-text part, and lists attachments with type and size', async () => {
    const res = await extractEml(MIXED_EML);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(
      [
        '[from] Ada Lovelace <ada@example.com>',
        '[to] Bob <bob@example.com>, carol@example.com',
        '[cc] Dan <dan@example.com>',
        '[subject] Quarterly numbers',
        '[date] 2026-01-05T10:00:00.000Z',
        '',
        // The text/plain alternative, NOT the stripped HTML.
        'Please see attached.',
        'Second line.',
        '',
        '[attachments]',
        'report.pdf (application/pdf, 8 bytes)',
        'data.csv (text/csv, 4 bytes)', // 'a,b' + the newline before the closing boundary
      ].join('\n'),
    );
    expect(res.summary).toBe(
      'email message; 2 attachments listed (names only; not extracted); formatting and full headers omitted',
    );
  });

  it('a text-only email has no [attachments] section and omits absent header lines (no cc)', async () => {
    const res = await extractEml(
      emlBytes([
        'From: ada@example.com',
        'To: bob@example.com',
        'Subject: ping',
        'Date: Mon, 5 Jan 2026 10:00:00 +0000',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'Just checking in.',
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(
      [
        '[from] ada@example.com',
        '[to] bob@example.com',
        '[subject] ping',
        '[date] 2026-01-05T10:00:00.000Z',
        '',
        'Just checking in.',
      ].join('\n'),
    );
    expect(res.text).not.toContain('[cc]');
    expect(res.text).not.toContain('[attachments]');
    expect(res.summary).toBe('email message; formatting and full headers omitted');
  });

  it('an HTML-only email is stripped to text — block tags become line breaks, entities decode — and the summary says so', async () => {
    const res = await extractEml(
      emlBytes([
        'From: ada@example.com',
        'Subject: styled',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<html><head><style>p{color:red}</style></head><body>' +
          '<h1>Title</h1><p>Para&nbsp;one &amp; two</p><div>second<br>third</div></body></html>',
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Blocks separate as paragraphs (blank line); <br> is a plain line break.
    expect(res.text).toContain('Title\n\nPara one & two\n\nsecond\nthird');
    expect(res.text).not.toContain('color:red');
    expect(res.text).not.toContain('<p>');
    expect(res.summary).toContain('HTML body rendered as plain text');
  });

  it('omits every header line the message lacks — a body-only draft with just a Message-ID still extracts', async () => {
    const res = await extractEml(emlBytes(['Message-ID: <draft-1@local>', '', 'only a body']));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe('only a body');
  });

  it('answers bytes with no email headers at all with the typed could-not-be-parsed failure', async () => {
    const res = await extractEml(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0x01, 0x02, 0x00, 0xff, 0xfe]));
    expect(res).toEqual({ ok: false, message: 'could not be parsed as a .eml (no email headers found)' });
  });

  it('a valid email whose ONLY header is Bcc: is recognized, not rejected as header-less', async () => {
    const res = await extractEml(emlBytes(['Bcc: Eve <eve@example.com>', '', 'quiet copy']));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe('[bcc] Eve <eve@example.com>\n\nquiet copy');
  });

  it('refuses a file over the 50 MB extraction bound before parsing anything', async () => {
    const res = await extractEml(Buffer.alloc(MAX_DOC_PART_BYTES + 1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be extracted as a .eml');
    expect(res.message).toContain('50 MB');
  });
});

// ── .msg extraction ────────────────────────────────────────────────────────

describe('extractMsg', () => {
  it('extracts headers (sender, typed recipients, ISO date), body and attachments from real CFB bytes', () => {
    const res = extractMsg(
      msgBytes({
        strings: {
          '0037': 'Quarterly numbers',
          '0C1A': 'Ada Lovelace',
          '0C1F': 'ada@example.com',
          '1000': 'Please see attached.',
        },
        recipients: [
          { name: 'Bob', email: 'bob@example.com', type: 1 },
          { name: 'Dan', email: 'dan@example.com', type: 2 },
        ],
        attachments: [{ name: 'report.pdf', mime: 'application/pdf', content: Buffer.from('PDFDATA') }],
        submitTimeIso: '2026-01-05T10:00:00Z',
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(
      [
        '[from] Ada Lovelace <ada@example.com>',
        '[to] Bob <bob@example.com>',
        '[cc] Dan <dan@example.com>',
        '[subject] Quarterly numbers',
        '[date] 2026-01-05T10:00:00.000Z',
        '',
        'Please see attached.',
        '',
        '[attachments]',
        'report.pdf (application/pdf, 7 bytes)',
      ].join('\n'),
    );
    expect(res.summary).toBe(
      'email message; 1 attachment listed (names only; not extracted); formatting and full headers omitted',
    );
  });

  it('strips an HTML-only body to text, like .eml', () => {
    const res = extractMsg(
      msgBytes({ strings: { '0037': 'styled', '1013': '<p>Hello <b>there</b>&nbsp;!</p><div>bye</div>' } }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Hello there !\n\nbye');
    expect(res.summary).toContain('HTML body rendered as plain text');
  });

  it('degrades an RTF-only body honestly: the text says so instead of pretending to decode RTF', () => {
    const res = extractMsg(msgBytes({ strings: { '0037': 'compressed' }, rtf: true }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(['[subject] compressed', '', RTF_ONLY_BODY_LINE].join('\n'));
    expect(res.summary).toContain('body is RTF; no plain-text part');
  });

  it('keeps a recipient whose PidTagRecipientType carries flag bits — msgreader leaks the raw number', () => {
    // msgreader maps only the bare MAPI values 1/2/3 to 'to'/'cc'/'bcc'; a
    // resubmit-flagged value like MAPI_TO | MAPI_P1 (0x10000001) comes through
    // as a NUMBER, and a string-only comparison silently dropped the line.
    const res = extractMsg(
      msgBytes({
        strings: { '0037': 'resubmitted' },
        recipients: [
          { name: 'Bob', email: 'bob@example.com', type: 0x10000001 },
          { name: 'Dan', email: 'dan@example.com', type: 0x10000002 },
          { name: 'Eve', email: 'eve@example.com', type: 0x10000003 },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('[to] Bob <bob@example.com>');
    expect(res.text).toContain('[cc] Dan <dan@example.com>');
    expect(res.text).toContain('[bcc] Eve <eve@example.com>');
  });

  it('answers garbage bytes with the typed could-not-be-parsed failure (msgreader reports, never throws)', () => {
    const res = extractMsg(Buffer.from('total garbage, not a CFB container'));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be parsed as a .msg');
  });

  it('refuses a file over the 50 MB extraction bound before parsing anything', () => {
    const res = extractMsg(Buffer.alloc(MAX_DOC_PART_BYTES + 1));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('could not be extracted as a .msg');
    expect(res.message).toContain('50 MB');
  });
});

// ── the shared HTML strip ──────────────────────────────────────────────────

describe('an HTML body, stripped to text', () => {
  /** The body of an HTML-only email, as the extraction renders it. */
  const bodyOf = async (html: string): Promise<string> => {
    const res = await extractEml(
      emlBytes([
        'From: ada@example.com',
        'Content-Type: text/html; charset=utf-8',
        '',
        html,
      ]),
    );
    if (!res.ok) throw new Error(res.message);
    const marker = '[from] ada@example.com';
    const at = res.text.indexOf(marker);
    return res.text.slice(at + marker.length).replace(/^\n+/, '');
  };

  it('drops style/script/head whole and keeps paragraph structure', async () => {
    expect(await bodyOf('<html><head><style>b{color:red}</style><title>T</title></head><body><p>one</p><p>two</p></body></html>'),
    ).toBe('one\n\ntwo');
    expect(await bodyOf('<SCRIPT TYPE="text/javascript">evil()</SCRIPT>after')).toBe('after');
    expect(await bodyOf('<Style Media="print">b{}</STYLE>rest')).toBe('rest');
  });

  it('never truncates a tag at a > inside a quoted attribute value', async () => {
    expect(await bodyOf('<a title="a > b">x</a>')).toBe('x');
    expect(await bodyOf("<p align='x>y'>para</p>")).toBe('para');
    expect(await bodyOf('<div class="a>b">block</div>')).toBe('block');
    expect(await bodyOf('<style media="x>y">b{}</style>rest')).toBe('rest');
  });

  it('turns br and block-tag boundaries into line breaks', async () => {
    expect(await bodyOf('a<br>b<br/>c<BR />d')).toBe('a\nb\nc\nd');
    expect(await bodyOf('<h1>T</h1><div>d</div><li>i</li>')).toBe('T\n\nd\n\ni');
  });

  it('decodes entities, and a &nbsp; lands as an ordinary space', async () => {
    // U+00A0 looks like a space and is not one — an agent grepping the
    // extraction for "one two" must not miss a line that reads exactly that.
    expect(await bodyOf('<p>one&nbsp;two &amp; three &mdash; four</p>')).toBe('one two & three — four');
  });

  it('keeps a comparison in the body: `2 < 3` is text, not a tag', async () => {
    // `<` followed by whitespace cannot open a tag, so the comparison survives.
    expect(await bodyOf('<p>total</p> 2 < 3')).toBe('total\n2 < 3');
  });

  it('CHANGED: reads malformed markup the way a mail client would', async () => {
    // These four all used to be answered by a hand-rolled strip with rules of
    // its own. They are now htmlparser2's answers, which are a browser's — the
    // useful standard here, because it is what the recipient of the mail saw.
    //
    // An unterminated tag swallows the rest of the body (the reader saw
    // nothing either), where the strip used to emit it as literal text…
    expect(await bodyOf('<a href="never closed>tail')).toBe('');
    // …an unclosed <script> hides its content instead of showing the source…
    expect(await bodyOf('<script>alert(1)')).toBe('');
    // …a `/` in the tag name is ignored, so `<script/x>` IS a script…
    expect(await bodyOf('<script/x>secret</script>tail')).toBe('tail');
    // …and `</ 2 >` is a bogus end tag, dropped rather than shown.
    expect(await bodyOf('x </ 2 > y')).toBe('x  y');
  });

  it('completes on an adversarial body: 20k < characters and a quote that never closes', async () => {
    // The shape the old quote-aware tag regexes died on — each `<` restarted a
    // lazy expansion that could never pass the unclosed quote, so the strip was
    // quadratic in the body length. The bound is deliberately loose: it exists
    // to catch a return of the blow-up, not to police CI's scheduler.
    const bomb = '<'.repeat(20_000) + '<b title="never closed ' + 'x'.repeat(2_000) + '>';
    const t0 = performance.now();
    const out = await bodyOf(bomb);
    const ms = performance.now() - t0;
    // Every bare `<` is text; the trailing tag is a tag and goes.
    expect(out).toBe('<'.repeat(20_000));
    expect(ms).toBeLessThan(5_000);
  });

  it('completes on a wall of comparison spans before one far-away `>`', async () => {
    const bomb = '< '.repeat(50_000) + '<p>end</p>';
    const t0 = performance.now();
    const out = await bodyOf(bomb);
    const ms = performance.now() - t0;
    expect(out.endsWith('end')).toBe(true);
    expect(ms).toBeLessThan(5_000);
  });

  it('completes on a body nested past any sane depth, keeping what it read', async () => {
    // The parser holds a stack entry per open element, so MAX_ELEMENT_DEPTH
    // stops a body that nests as deep as it has bytes.
    const t0 = performance.now();
    const out = await bodyOf('<p>top</p>' + '<div>'.repeat(200_000));
    const ms = performance.now() - t0;
    expect(out.startsWith('top')).toBe(true);
    expect(ms).toBeLessThan(5_000);
  });

  it('an İ before a container does not shift what gets dropped', async () => {
    // The strip this replaced kept an index-parallel lowercase copy of the
    // body, and `String.toLowerCase` is not length-preserving — `İ` (U+0130)
    // becomes `i` plus a combining dot — so after one of these every later
    // offset was wrong and a `<script>` stopped being recognized. A parser has
    // no such copy to get out of step.
    expect(await bodyOf('İ<script>alert(1)</script>after')).toBe('İafter');
    expect(await bodyOf('İ<p>one</p><p>two</p>')).toBe('İ\none\n\ntwo');
    expect(await bodyOf('<p>aİb</p><style>c{}</style>tail')).toBe('aİb\ntail');
  });
});
