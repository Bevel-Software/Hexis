import { describe, it, expect } from 'vitest';
import { parseCsv } from '../csvUtils';

describe('parseCsv', () => {
  it('parses a simple comma-separated grid', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('does not emit a trailing empty row for a terminating newline', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    expect(parseCsv('"Smith, John",42')).toEqual([['Smith, John', '42']]);
  });

  it('unescapes doubled quotes inside a quoted field', () => {
    expect(parseCsv('"She said ""hi""",ok')).toEqual([['She said "hi"', 'ok']]);
  });

  it('preserves newlines embedded in quoted fields', () => {
    expect(parseCsv('"line1\nline2",b')).toEqual([['line1\nline2', 'b']]);
  });

  it('preserves empty fields', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });

  it('returns no rows for empty input', () => {
    expect(parseCsv('')).toEqual([]);
  });

  it('keeps a single quoted empty field at EOF', () => {
    expect(parseCsv('""')).toEqual([['']]);
  });

  it('keeps a trailing row that is a single quoted empty field', () => {
    expect(parseCsv('a\n""')).toEqual([['a'], ['']]);
  });

  it('keeps a trailing empty field after a comma at EOF', () => {
    expect(parseCsv('a,')).toEqual([['a', '']]);
  });
});
