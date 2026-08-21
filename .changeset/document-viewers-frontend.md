---
"@bevel-software/platform-core-frontend": minor
---

The file viewer displays PDF, Word, Excel and PowerPoint files. PDFs render page by page (pdf.js) with a Prev/Next pager and fit-to-width scaling; `.xlsx` workbooks render as a per-sheet grid capped at 1,000 rows / 100 columns with an honest truncation note; `.docx` continues to render through mammoth (sanitized); `.pptx` shows a text outline — slides as sections with speaker notes, matching what agents read through `read_file` — with the original deck one download away. Legacy `.doc`/`.ppt`/`.xls` get a convert-to-modern-format note instead of the raw-bytes text fallback, and every document viewer carries a Download affordance. All document parsers stay out of the eager bundle (code-split per viewer).
