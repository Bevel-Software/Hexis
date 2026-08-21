/**
 * Server-side document text extraction — shared types.
 *
 * The extractors turn an office document (`.docx` / `.pptx` / `.xlsx`), an
 * OpenDocument file (`.odt` / `.odp` / `.ods`) or a PDF into plain text an
 * agent can read and grep. They are HONEST about being
 * lossy: every successful extraction carries a one-line `summary` the consumer
 * turns into a marker header (`[extracted text of <path> — <summary>]`) so the
 * reader knows it is looking at extracted text, not the file's bytes.
 *
 * The `summary` (not a full marker) is what extractors return and what the
 * cache stores, because the cache is keyed by CONTENT (git blob sha): the same
 * document at two workspace paths shares one cache entry, and baking a path
 * into the cached value would surface the wrong path on the second read.
 */

/** A successful extraction: the marker-summary line + the extracted text. */
export interface ExtractedDoc {
  /**
   * One-line description for the marker header, e.g.
   * `14 slides + notes; layout, images and formatting omitted`.
   */
  summary: string;
  /** The extracted text: paragraphs/rows as lines, with `[slide N]` / `[sheet: Name]` / `[page N]` structure markers. */
  text: string;
}

/**
 * Extraction outcome. `ok: false` is a TYPED failure (corrupt/unparseable
 * file) the consumers turn into an honest message — extraction never throws
 * for bad file content, so a broken upload cannot 500 a read.
 */
export type ExtractResult =
  | ({ ok: true } & ExtractedDoc)
  | { ok: false; message: string };

/**
 * A format's PURE extract function — bytes in, `ExtractResult` out (async for
 * pdf.js). One per supported format (extract-docx.ts and friends); each is
 * paired with its extension by a `DocumentReader` entry in the file-reader
 * registry, and cache-wrapped by `DocExtractService`.
 */
export type ExtractFn = (bytes: Buffer) => ExtractResult | Promise<ExtractResult>;

/** Build the honest one-line header consumers prepend to extracted text. */
export function extractionMarker(path: string, summary: string): string {
  return `[extracted text of ${path} — ${summary}]`;
}

/** Lowercased extension of `path` including the dot, or '' when there is none. */
export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}
