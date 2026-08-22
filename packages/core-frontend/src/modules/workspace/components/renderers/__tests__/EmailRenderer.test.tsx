import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as XLSX from 'xlsx';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

import { EmailRenderer } from '../EmailRenderer';
import { MAX_EMAIL_BYTES } from '../emailMessage';

/**
 * The viewer over real message bytes (hand-written MIME; a real CFB container
 * for `.msg`): parsing is `emailMessage.test.ts`'s job; this proves the model
 * reaches the screen in the promised shape — labelled header fields, the body
 * as plain text (never HTML), attachments listed with the names-only note,
 * the up-front honesty strip, and Download on the happy and the failed path.
 */

const EML_BYTES = new TextEncoder().encode(
  [
    'From: Ada Lovelace <ada@example.com>',
    'To: bob@example.com',
    'Subject: Quarterly numbers',
    'Date: Mon, 5 Jan 2026 10:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>Please see <b>attached</b>.</p><script>alert(1)</script>',
    '--b1',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    'JVBERi0xLjQ=',
    '--b1--',
    '',
  ].join('\r\n'),
).buffer as ArrayBuffer;

interface CfbUtilsModule {
  utils: { cfb_new(): unknown; cfb_add(cfb: unknown, path: string, bytes: Uint8Array): void };
  write(cfb: unknown, opts: { type: 'array' }): Uint8Array | number[];
}

function utf16(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff;
    out[i * 2 + 1] = c >> 8;
  }
  return out;
}

/** A real (minimal) `.msg`: subject + plain body in a CFB container. */
function msgFixture(): ArrayBuffer {
  const CFB = XLSX.CFB as unknown as CfbUtilsModule;
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, '/__substg1.0_0037001F', utf16('From Outlook'));
  CFB.utils.cfb_add(cfb, '/__substg1.0_1000001F', utf16('Body from the item.'));
  const written = CFB.write(cfb, { type: 'array' });
  const u8 = written instanceof Uint8Array ? written : Uint8Array.from(written);
  return u8.slice().buffer as ArrayBuffer;
}

function renderEmail(filePath: string) {
  return render(
    <WorkspaceContext.Provider
      value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
    >
      <EmailRenderer filePath={filePath} content="" onSave={async () => {}} />
    </WorkspaceContext.Provider>,
  );
}

beforeEach(() => {
  apiMock.authFetch.mockReset();
});

describe('EmailRenderer', () => {
  it('renders a .eml: labelled headers, HTML body stripped to text, attachments with the names-only note', async () => {
    apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => EML_BYTES });

    renderEmail('Inbox/offer.eml');

    expect(await screen.findByText('Ada Lovelace <ada@example.com>')).toBeInTheDocument();
    expect(screen.getByText('From')).toBeInTheDocument();
    expect(screen.getByText('To')).toBeInTheDocument();
    expect(screen.getByText('Subject')).toBeInTheDocument();
    expect(screen.getByText('Quarterly numbers')).toBeInTheDocument();
    expect(screen.getByText('2026-01-05T10:00:00.000Z')).toBeInTheDocument();
    // CHANGED: a message carrying an HTML alternative now RENDERS it, the way a
    // mail client does — in a frame that cannot run scripts or fetch anything.
    const frame = screen.getByTitle('Message body') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.srcdoc).toContain('Please see');
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).toContain('img-src data:');
    expect(document.querySelector('b')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    // Attachments: named, and honestly not downloadable one by one.
    expect(screen.getByText('report.pdf (application/pdf, 8 bytes)')).toBeInTheDocument();
    expect(screen.getByText(/listed by name only/)).toBeInTheDocument();
    // The honest strip + the way to the real thing.
    expect(screen.getByText(/shown without remote content/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('renders a .msg (real CFB bytes) through the same view', async () => {
    apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => msgFixture() });

    renderEmail('Inbox/thread.msg');

    expect(await screen.findByText('From Outlook')).toBeInTheDocument();
    expect(screen.getByText('Subject')).toBeInTheDocument();
    expect(screen.getByText('Body from the item.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('says the file could not be parsed as a .msg and still offers Download', async () => {
    const bytes = new TextEncoder().encode('renamed file that is not a CFB').buffer as ArrayBuffer;
    apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });

    renderEmail('Inbox/broken.msg');

    expect(
      await screen.findByText(/This file could not be parsed as a \.msg/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('says the file could not be parsed as a .eml for headerless bytes', async () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0x01, 0xff, 0xfe]).buffer as ArrayBuffer;
    apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });

    renderEmail('Inbox/broken.eml');

    expect(
      await screen.findByText(/This file could not be parsed as a \.eml \(no email headers found\)/),
    ).toBeInTheDocument();
  });

  it('reports a transport failure as a load error', async () => {
    apiMock.authFetch.mockResolvedValue({ ok: false, status: 403 });

    renderEmail('Inbox/offer.eml');

    expect(await screen.findByText(/Failed to load email \(HTTP 403\)/)).toBeInTheDocument();
  });

  it('rejects an oversized declared Content-Length and ABORTS the transfer', async () => {
    // Returning without aborting would leave the connection streaming a body
    // nobody will read for as long as the view stays mounted.
    let signal: AbortSignal | undefined;
    apiMock.authFetch.mockImplementation(async (_url: string, init?: { signal?: AbortSignal }) => {
      signal = init?.signal;
      return {
        ok: true,
        headers: { get: (name: string) => (name === 'content-length' ? String(MAX_EMAIL_BYTES + 1) : null) },
        arrayBuffer: async () => EML_BYTES,
      };
    });

    renderEmail('Inbox/huge.eml');

    expect(await screen.findByText('This email is too large to display.')).toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
  });
});
