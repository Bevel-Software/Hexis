---
"@bevel-software/platform-core-backend": minor
---

Agents read office documents and PDFs as extracted text. `read_file` on a `.docx`/`.pptx`/`.xlsx`/`.pdf` now returns the document's text under an honest `[extracted text of …]` header (with `[slide N]`/`[sheet: Name]`/`[page N]` markers) instead of megabytes of undecodable bytes, and `grep` searches inside those documents via the same cached extraction. Extractions are cached by content hash beside the workspaces root. The agent text-editing tools (`write_file`/`write_files`/`edit_file`) refuse document extensions — extracted reads cannot round-trip, so documents are changed by uploading a new version. Other binary files answer `read_file` with a one-line description (legacy `.doc`/`.ppt`/`.xls` get a convert-to-modern-format hint, `.zip` points at the unzip tool).
