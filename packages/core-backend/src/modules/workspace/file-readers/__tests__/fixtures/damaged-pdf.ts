/**
 * A SYNTHETIC PDF whose cross-reference table is damaged — never a tenant's
 * file. One page, one content stream; the xref entry for the content stream
 * (object 4) points two bytes past where the object starts, and the object's
 * own header is defaced so pdf.js's recovery scan cannot find it either.
 * pdf.js answers it with the exception of the 2026-10-15 incident:
 * `Bad (uncompressed) XRef entry: 4R`.
 *
 * `damage: false` builds the same file intact, which reads as `text`.
 */
export function xrefPdf(text: string, { damage }: { damage: boolean }): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    const header = damage && i === 3 ? `${i + 1} 0 xbj` : `${i + 1} 0 obj`;
    pdf += `${header}\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off, i) => {
    pdf += `${String(damage && i === 3 ? off + 2 : off).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
