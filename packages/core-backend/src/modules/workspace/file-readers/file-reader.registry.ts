import type { DocExtractService } from './doc-extract.service.js';
import { DocumentReader } from './document-reader.js';
import { EmailReader } from './email-reader.js';
import { extractDocx } from './extract-docx.js';
import { extractEml } from './extract-eml.js';
import { extractMsg } from './extract-msg.js';
import { extractOdp } from './extract-odp.js';
import { extractOds } from './extract-ods.js';
import { extractOdt } from './extract-odt.js';
import { extractPdf } from './extract-pdf.js';
import { extractPptx } from './extract-pptx.js';
import { extractXlsx } from './extract-xlsx.js';
import { FileReaderRegistry } from './file-reader.js';
import { ImageReader } from './image-reader.js';
import { LegacyOfficeReader, TextReader } from './text-reader.js';

/**
 * THE registry of file readers — the one place that says which reader owns
 * which extension. Adding a format is one entry here (plus its reader/extract
 * function); read_file, grep and the write-refusal all follow automatically.
 *
 * `docExtract` is the shared content-hash extraction cache the document
 * readers wrap their pure extract functions with (see DocumentReader).
 * Everything not claimed below falls back to the TextReader.
 */
export function createFileReaderRegistry(docExtract: DocExtractService): FileReaderRegistry {
  return new FileReaderRegistry(
    [
      new DocumentReader('.docx', extractDocx, docExtract),
      new DocumentReader('.pptx', extractPptx, docExtract),
      new DocumentReader('.xlsx', extractXlsx, docExtract),
      new DocumentReader('.pdf', extractPdf, docExtract),
      new DocumentReader('.odt', extractOdt, docExtract),
      new DocumentReader('.odp', extractOdp, docExtract),
      new DocumentReader('.ods', extractOds, docExtract),
      // Email files ride the same document machinery (cached extraction,
      // greppable, not text-editable) with an email-honest write refusal.
      new EmailReader('.eml', extractEml, docExtract),
      new EmailReader('.msg', extractMsg, docExtract),
      new ImageReader(),
      new LegacyOfficeReader(),
    ],
    new TextReader(),
  );
}
