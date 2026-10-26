import { extractPdf } from '../../extract-pdf.js';
import { serveExtractions } from '../../extraction-worker.js';

/**
 * The real PDF extractor, except for a PDF whose bytes say otherwise: `HANG`
 * spins forever, `SLOW` spins for 1.5 s before extracting — both on the
 * worker's thread, as a parser stuck on crafted input would. For the tool
 * suites that time `/api/health` while a document is being extracted.
 */
serveExtractions({
  '.pdf': (bytes) => {
    const text = bytes.toString('latin1');
    if (text.includes('HANG')) for (;;) { /* stuck */ }
    if (text.includes('SLOW')) {
      const until = Date.now() + 1_500;
      while (Date.now() < until) { /* busy */ }
    }
    return extractPdf(bytes);
  },
});
