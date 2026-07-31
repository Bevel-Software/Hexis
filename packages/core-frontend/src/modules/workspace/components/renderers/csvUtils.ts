/**
 * Parse CSV text into rows of cells, following the RFC 4180 essentials:
 * comma-separated fields, double-quoted fields that may contain commas,
 * newlines, and escaped quotes (`""`). Tolerates both `\n` and `\r\n` line
 * endings. A trailing newline does not produce a spurious empty row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Whether the current row has begun — set by any field content, a field
  // separator, or an opening quote. Distinguishes a row that holds a single
  // (possibly quoted) empty field (`""` → `[['']]`) from input that simply
  // ended on a row break (`a\n` → no trailing empty row).
  let cellStarted = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
    cellStarted = false;
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"') {
      inQuotes = true;
      cellStarted = true;
      i += 1;
    } else if (ch === ',') {
      pushField();
      cellStarted = true;
      i += 1;
    } else if (ch === '\n') {
      pushRow();
      i += 1;
    } else if (ch === '\r') {
      pushRow();
      if (text[i + 1] === '\n') i += 2;
      else i += 1;
    } else {
      field += ch;
      cellStarted = true;
      i += 1;
    }
  }

  // Flush the final row unless the text ended exactly on a row break with
  // nothing after it (avoids a spurious trailing empty row from a terminating
  // newline). `cellStarted` covers the quoted-empty-field cases (`""`, or a
  // final `a\n""` row) that an `field/row` emptiness check alone would drop.
  if (cellStarted || field !== '' || row.length > 0) {
    pushRow();
  }

  return rows;
}
