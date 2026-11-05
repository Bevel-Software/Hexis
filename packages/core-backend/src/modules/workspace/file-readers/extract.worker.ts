import { DOCUMENT_EXTRACTORS } from './document-extractors.js';
import { serveExtractions } from './extraction-worker.js';

/** The extraction worker's entry: the document extractors, served one job at a time (see `extract-in-worker.ts`). */
serveExtractions(DOCUMENT_EXTRACTORS);
