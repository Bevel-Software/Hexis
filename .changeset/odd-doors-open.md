---
"@bevel-software/platform-core-backend": minor
---

OpenDocument files — `.odt`, `.odp`, `.ods` — read as extracted text. `read_file` returns their text under the same honest `[extracted text of …]` header the office formats get (`.odt` paragraphs and headings as lines with real tabs/line-breaks/spaces, `.odp` slides in document order under `[slide N]` markers with notes, `.ods` sheets as tab-separated rows under `[sheet: Name]` with the same 200-column/10k-row bounds — trailing empty grid padding trimmed before repeat expansion), `grep` searches inside them via the same cached extraction, and the agent text-editing tools refuse them like the other extracted formats.
