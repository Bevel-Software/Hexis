import type { FileReaderRegistry } from '../modules/workspace/index.js';
import { createFileReaderRegistry } from '../modules/workspace/file-readers/file-reader.registry.js';
import type { DocExtractOutcome, DocExtractService } from '../modules/workspace/file-readers/doc-extract.service.js';

/**
 * The file readers, composed the way the composition root composes them
 * (`core/create-core-services.ts`) over a document extractor. A module's suite
 * that reads real files through them takes them from HERE rather than
 * composing another module's internals itself: the registry factory is on no
 * module entry, by design (a module receives the registry by injection), and
 * this fixture stands in for the root, as `real-disk.ts` does for the disk.
 */
export function realFileReaders(docExtract: DocExtractService = noDocExtract()): FileReaderRegistry {
  return createFileReaderRegistry(docExtract);
}

/**
 * A document extractor that extracts nothing: a suite that reads no
 * document-format file gets this typed refusal, not a silent empty text.
 */
export function noDocExtract(): DocExtractService {
  const extract = async (): Promise<DocExtractOutcome> => ({
    ok: false,
    message: 'this suite reads no document-format file',
  });
  return { extract } satisfies Pick<DocExtractService, 'extract'> as DocExtractService;
}
