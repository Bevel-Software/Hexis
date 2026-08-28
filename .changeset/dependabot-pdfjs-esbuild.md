---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Dependabot: `pdfjs-dist` moves to 6.x (GHSA-hq66-cqwq-w95j — arbitrary JavaScript on opening a malicious PDF; the server-side extractor and the in-app viewer both parse user-supplied PDFs), and the `esbuild` that `drizzle-kit` pulled in is overridden past GHSA-67mh-4wv8-2f99. In pdf.js 6 the document proxy no longer has `destroy()`; the extractor now holds the loading task and destroys that, which frees the document with it — the same shape the viewer already used.
