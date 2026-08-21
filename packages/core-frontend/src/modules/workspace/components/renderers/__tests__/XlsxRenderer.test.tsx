import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import {
  WorkspaceContext,
  type WorkspaceContextValue,
} from '../../../state/workspace.context';

const apiMock = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../../../../lib/api', () => ({ authFetch: apiMock.authFetch }));

import { XlsxRenderer } from '../XlsxRenderer';

/**
 * The truncation contract. The grid caps what it CONVERTS (1,000 rows / 100
 * columns — a bounded `range` handed to `sheet_to_json`, never a full
 * materialization of the declared range) so a million-row export, or a
 * sparse sheet whose `!ref` declares one, cannot lock the tab — and the cap
 * must never be silent: the note under the grid states the REAL dimensions,
 * taken from the declared `!ref` itself.
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

  it('caps a SPARSE sheet by its declared !ref BEFORE conversion — one far-corner cell cannot freeze the tab', async () => {
    // A hand-built xlsx whose worksheet DECLARES a million rows
    // (`<dimension ref="A1:B1048576"/>`) but holds a single real cell. The
    // old code materialized the whole declared range through sheet_to_json
    // before slicing; this fixture would have hung the test.
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    );
    zip.file(
      '_rels/.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    );
    zip.file(
      'xl/workbook.xml',
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Sparse" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<dimension ref="A1:B1048576"/>' +
        '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>lonely cell</t></is></c></row></sheetData></worksheet>',
    );
    const bytes = await zip.generateAsync({ type: 'arraybuffer' });
    apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => bytes });

    renderXlsx();

    expect(await screen.findByText('lonely cell')).toBeInTheDocument();
    const note = screen.getByRole('note');
    // The REAL declared total, straight from the original !ref.
    expect(note.textContent).toMatch(/first 1[,.]?000 of 1[,.]?048[,.]?576 rows/);
  });

  it('says the file could not be parsed as a spreadsheet when SheetJS rejects it', async () => {
    // A zip signature followed by garbage: SheetJS commits to the xlsx
    // container and fails. (Plain text would be sniffed as CSV and "work".)
    const junk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9, 9]).buffer;
    apiMock.authFetch.mockResolvedValue({ ok: true, arrayBuffer: async () => junk });
    // Held and restored: leaking a silenced console.warn into later tests
    // would swallow their real warnings.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      renderXlsx();

      expect(
        await screen.findByText('This file could not be parsed as a spreadsheet.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
    } finally {
      warnSpy.mockRestore();
    }
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
