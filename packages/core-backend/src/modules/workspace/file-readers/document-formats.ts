/**
 * The document formats whose text is EXTRACTED rather than read: the one list
 * both sides of the extraction worker agree on. The file-reader registry
 * builds a reader for each, on the request thread, without loading a single
 * parser; the worker's table (`document-extractors.ts`) is typed by these
 * lists, so a format added here and not there fails to compile.
 */
export const OFFICE_DOCUMENT_EXTENSIONS = ['.docx', '.pptx', '.xlsx', '.pdf', '.odt', '.odp', '.ods'] as const;

/** Email files: extracted the same way, refused for writing with an email-honest message (see `EmailReader`). */
export const EMAIL_EXTENSIONS = ['.eml', '.msg'] as const;

export type DocumentExtension = (typeof OFFICE_DOCUMENT_EXTENSIONS)[number] | (typeof EMAIL_EXTENSIONS)[number];
