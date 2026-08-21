import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as XLSX from 'xlsx';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

import { XlsxRenderer } from '../XlsxRenderer';

/**
 * The truncation contract. The grid caps what it renders (1,000 rows / 100
 * columns) so a million-row export cannot lock the tab — and the cap must
 * never be silent: the note under the grid states the REAL dimensions, which
 * is why the renderer parses in full and slices, rather than letting SheetJS
 * cap the parse and lose the true count.
 */

function workbookBytes(rows: unknown[][], sheetName = 'Data'): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

function renderXlsx() {
  return render(
    <WorkspaceContext.Provider
      value={{ workspaceId: 'ws-1' } as unknown as WorkspaceContextValue}
    >
      <XlsxRenderer filePath="Data/book.xlsx" content="" onSave={async () => {}} />
    </WorkspaceContext.Provider>,
  );
}

beforeEach(() => {
  apiMock.authFetch.mockReset();
});

describe('XlsxRenderer truncation', () => {
  it('caps a long sheet at 1,000 rows and says exactly what was cut', async () => {
    const rows: unknown[][] = [['id', 'name']];
    for (let i = 1; i <= 1004; i++) rows.push([`r${i}`, `value ${i}`]);
    apiMock.authFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => workbookBytes(rows),
    });

    renderXlsx();

    const note = await screen.findByRole('note');
    // Locale-tolerant: toLocaleString may group with ',' or '.'.
    expect(note.textContent).toMatch(/first 1[,.]?000 of 1[,.]?005 rows/);
    expect(note.textContent).toMatch(/Download the file/);
    // The 999th data row is the last one on screen (1 header + 999 = 1,000)…
    expect(screen.getByText('r999')).toBeInTheDocument();
    // …and the 1,000th is not.
    expect(screen.queryByText('r1000')).not.toBeInTheDocument();
  });

  it('caps runaway columns too, and reports the real column count', async () => {
    const wide = Array.from({ length: 120 }, (_, i) => `c${i + 1}`);
    apiMock.authFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => workbookBytes([wide, wide]),
    });

    renderXlsx();

    const note = await screen.findByRole('note');
    expect(note.textContent).toMatch(/first 100 of 120 columns/);
    expect(screen.queryByText('c101')).not.toBeInTheDocument();
  });

  it('shows no truncation note on a sheet that fits', async () => {
    apiMock.authFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () =>
        workbookBytes([
          ['id', 'name'],
          ['1', 'small'],
        ]),
    });

    renderXlsx();

    expect(await screen.findByText('small')).toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('says the file could not be parsed as a spreadsheet when SheetJS rejects it', async () => {
    // A zip signature followed by garbage: SheetJS commits to the xlsx
    // container and fails. (Plain text would be sniffed as CSV and "work".)
    const junk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9, 9]).buffer;
    apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => junk });
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderXlsx();

    expect(
      await screen.findByText('This file could not be parsed as a spreadsheet.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });

  it('offers Download beside the grid', async () => {
    apiMock.authFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => workbookBytes([['only cell']]),
    });

    renderXlsx();

    expect(await screen.findByText('only cell')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });
});
