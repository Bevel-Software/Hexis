import type { DocumentExtension } from './document-formats.js';
import type { ExtractFn } from './doc-extract.types.js';
import { extractDocx } from './extract-docx.js';
import { extractEml } from './extract-eml.js';
import { extractMsg } from './extract-msg.js';
import { extractOdp } from './extract-odp.js';
import { extractOds } from './extract-ods.js';
import { extractOdt } from './extract-odt.js';
import { extractPdf } from './extract-pdf.js';
import { extractPptx } from './extract-pptx.js';
import { extractXlsx } from './extract-xlsx.js';

/**
 * Which pure extract function owns which document format. Loaded by the
 * extraction worker only (`extract.worker.ts`): no parser runs on the
 * server's request thread.
 */
export const DOCUMENT_EXTRACTORS: Readonly<Record<DocumentExtension, ExtractFn>> = {
  '.docx': extractDocx,
  '.pptx': extractPptx,
  '.xlsx': extractXlsx,
  '.pdf': extractPdf,
  '.odt': extractOdt,
  '.odp': extractOdp,
  '.ods': extractOds,
  '.eml': extractEml,
  '.msg': extractMsg,
};
