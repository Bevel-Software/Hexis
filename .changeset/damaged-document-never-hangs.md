---
"@bevel-software/platform-core-backend": minor
"@bevel-software/platform-shared": patch
"@bevel-software/platform-core-frontend": patch
---

A damaged document never hangs the server. Every document extraction (PDF, Office, OpenDocument, email) runs in a pooled worker thread — the extraction worker kind of the pool `grep`'s regex matcher uses — with a budget of 10 seconds per file; a parser error or a promise a parser rejects without handing back is answered as the file's one-line notice and never reaches the server's process. A parser failure is remembered under the file's content hash like a successful extraction, and a timeout for one hour, so `read_file`, `file_stat` (new `unreadable` field) and `grep` answer it without extracting again. A fresh failure pushes a `document-unreadable` event, delivered only to sessions whose person may read the file, and the explorer shows it under the file's row with a Dismiss.

Breaking for direct constructors: `DocExtractService` now takes the `IDocumentExtractor` it runs extractions through (`new DocExtractService(cacheRoot, new WorkerDocumentExtractor())`), and `DocumentReader` no longer takes an extract function. `createCoreServices` wires both.
