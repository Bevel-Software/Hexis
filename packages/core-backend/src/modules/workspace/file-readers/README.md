# File readers

`read_file` and `grep` dispatch through `FileReaderRegistry`; each document
format pairs one pure extract function (`extract-*.ts`) with the shared
content-hash extraction cache (`DocExtractService`). An extraction is returned
under an `[extracted text of …]` marker whose summary states what was left out.

When an extractor's OUTPUT changes, bump `EXTRACTION_SCHEMA` in
`doc-extract.service.ts` so cached extractions of unchanged bytes refresh.

## Word (`.docx`)

- Paragraphs become lines; table rows become lines of tab-separated cells.
- Runs inside a paragraph join with NO separator — Word splits runs mid-word on
  formatting boundaries.
- A soft line break (`<w:br/>`, `<w:cr/>`) becomes one space and a tab element
  (`<w:tab/>`) one tab, between the surrounding run text. Tab STOPS in paragraph
  properties and breaks inside tracked deletions add nothing.
- Body only: headers and footers are skipped.

## Known limitations

These are accepted limitations of the document parsers, deliberately left as
they are:

- **PDF ligatures split words.** The PDF reader joins every text item on a
  visual line with one space. When pdf.js emits a ligature glyph (`fi`, `fl`, …)
  as its own item, a space lands inside the word ("fi le"). Merging items by
  position would also merge real words, so it is not attempted.
- **Headings are not marked.** Word heading styles (and paragraph styles in
  general) are not read: a heading extracts as a plain line. The marker summary
  says formatting is omitted.
