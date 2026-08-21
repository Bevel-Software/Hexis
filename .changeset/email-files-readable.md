---
"@bevel-software/platform-core-backend": minor
"@bevel-software/platform-core-frontend": minor
---

Email files — `.eml` (MIME) and `.msg` (Outlook) — join the document family. `read_file` returns the message as extracted text under the honest `[extracted text of …]` header: a `[from]`/`[to]`/`[cc]`/`[subject]`/`[date]` header block (absent fields omitted), the body preferring the plain-text part (an HTML-only body is stripped to text; a `.msg` whose body exists only as RTF says so instead of pretending to decode it), and an `[attachments]` list of names with type and size — attachments are listed, never extracted. `grep` searches inside emails via the same cached extraction, and the text-editing tools refuse them with an email-honest message (a message snapshot cannot be text-edited — replace the file). The file viewer renders both formats with labelled header fields, the body as plain text (never HTML, even for HTML emails), the attachment names, and the Download affordance; parsing is client-side (postal-mime for `.eml`; the `.msg` CFB container is read through the SheetJS CFB parser already in the bundle) and stays out of the eager chunk.
