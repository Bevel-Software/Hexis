import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocExtractService } from '../doc-extract.service.js';
import { DocumentReader } from '../document-reader.js';
import { EmailReader } from '../email-reader.js';
import { FileReaderRegistry, type FileReader, type ReadResult } from '../file-reader.js';
import { createFileReaderRegistry } from '../file-reader.registry.js';
import { ImageReader } from '../image-reader.js';
import { BinaryReader, LegacyOfficeReader, TextReader } from '../text-reader.js';
import { contentModeOf } from '../content-mode.js';

/**
 * Routing tests for THE file-reader registry: one lookup (`readerFor`) decides
 * how read_file reads, what grep searches, and which files the write tools
 * refuse. Extraction/read behaviour itself is covered by doc-extract.test.ts,
 * image-read.test.ts and workspace.tools.test.ts — this suite pins who OWNS
 * which extension.
 */

const registry = createFileReaderRegistry(
  new DocExtractService(join(tmpdir(), 'bevel-test-file-reader-registry')),
);

describe('file-reader registry routing', () => {
  it('routes the seven document extensions to a DocumentReader that is not text-editable', () => {
    for (const p of ['a.docx', 'b.pptx', 'x/y.xlsx', 'r.pdf', 'n.odt', 'd.odp', 'b/s.ods']) {
      const reader = registry.readerFor(p);
      expect(reader, p).toBeInstanceOf(DocumentReader);
      expect(reader.textEditable, p).toBe(false);
    }
  });

  it('routes the two email extensions to an EmailReader — a DocumentReader with the email write-refusal', () => {
    for (const p of ['Inbox/offer.eml', 'a/b/thread.msg', 'Deals/OFFER.EML', 'old.MSG']) {
      const reader = registry.readerFor(p);
      expect(reader, p).toBeInstanceOf(EmailReader);
      // An EmailReader IS a DocumentReader — grep's cold-extraction budget
      // branch (`instanceof DocumentReader`) must keep covering emails.
      expect(reader, p).toBeInstanceOf(DocumentReader);
      expect(reader.textEditable, p).toBe(false);
      expect(reader.editRefusal?.(p), p).toContain('email file');
      expect(reader.editRefusal?.(p), p).toContain('snapshot');
      expect(reader.editRefusal?.(p), p).toContain('uploading a new version');
    }
  });

  it('routes case-insensitively (the extension is lowercased before lookup)', () => {
    expect(registry.readerFor('Plugins/GTM/Deck.PPTX')).toBeInstanceOf(DocumentReader);
    expect(registry.readerFor('d.ODP')).toBeInstanceOf(DocumentReader);
    expect(registry.readerFor('shot.PNG')).toBeInstanceOf(ImageReader);
    expect(registry.readerFor('old.DOC')).toBeInstanceOf(LegacyOfficeReader);
  });

  it('routes images to the ImageReader (never greppable) and legacy office formats to the LegacyOfficeReader', () => {
    for (const p of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp']) {
      const reader = registry.readerFor(p);
      expect(reader, p).toBeInstanceOf(ImageReader);
      expect(reader.greppableText, p).toBeUndefined();
      // A picture is bytes: the text tools refuse it by name.
      expect(reader.textEditable, p).toBe(false);
      expect(reader.fileKind, p).toBe('image');
    }
    for (const p of ['a.doc', 'b.ppt', 'c.xls']) {
      const reader = registry.readerFor(p);
      expect(reader, p).toBeInstanceOf(LegacyOfficeReader);
      // Not text-editable: read_file can't extract a legacy binary, so an
      // edit_file would destroy it — and the refusal names the way out.
      expect(reader.textEditable, p).toBe(false);
      expect(reader.editRefusal?.(p), p).toContain('Convert the document');
      expect(reader.editRefusal?.(p), p).toContain('uploading a new version');
    }
  });

  it('falls back to the plain TextReader for unknown extensions, no extension and dot-files', () => {
    // `.svg` is markup — the text reader's business; `.docx` as a bare
    // dot-file has no extension.
    for (const p of ['notes.md', 'icon.svg', 'noext', 'dir/.gitignore', '.docx']) {
      const reader = registry.readerFor(p);
      expect(reader, p).toBeInstanceOf(TextReader);
      expect(reader, p).not.toBeInstanceOf(LegacyOfficeReader);
      expect(reader, p).not.toBeInstanceOf(BinaryReader);
      expect(reader.textEditable, p).toBe(true);
      expect(reader.fileKind, p).toBe('text');
    }
  });

  it('routes archives and media to a BinaryReader: read like the text reader, never text-editable', () => {
    for (const [p, kind] of [['bundle.zip', 'archive'], ['a/b.tar', 'archive'], ['song.mp3', 'binary'], ['font.woff2', 'binary'], ['fav.ico', 'image']] as const) {
      const reader = registry.readerFor(p);
      expect(reader, p).toBeInstanceOf(BinaryReader);
      expect(reader.textEditable, p).toBe(false);
      expect(reader.fileKind, p).toBe(kind);
    }
  });

  it('contentModeOf answers text | document | binary from the same registry the write gates use', () => {
    const text = Buffer.from('# hello\n');
    const bytes = Buffer.from([0x00, 0x01, 0xff]);
    expect(contentModeOf(registry.readerFor('notes.md'), text)).toBe('text');
    expect(contentModeOf(registry.readerFor('notes.md'), undefined)).toBe('text');
    // Binary content under a text name is binary: the write gate refuses it.
    expect(contentModeOf(registry.readerFor('blob.dat'), bytes)).toBe('binary');
    for (const p of ['deck.pptx', 'report.pdf', 'Inbox/offer.eml']) {
      expect(contentModeOf(registry.readerFor(p), bytes), p).toBe('document');
    }
    for (const p of ['logo.png', 'bundle.zip', 'old.doc', 'song.mp3']) {
      expect(contentModeOf(registry.readerFor(p), text), p).toBe('binary');
    }
  });

  it('adding a format is ONE registry entry — the new reader owns its extension, everything else keeps working', async () => {
    const fake: FileReader = {
      extensions: ['.foo'],
      textEditable: false,
      fileKind: 'binary',
      read: async (): Promise<ReadResult> => ({ kind: 'text', text: 'from the fake reader' }),
    };
    const custom = new FileReaderRegistry([fake, new ImageReader()], new TextReader());
    expect(custom.readerFor('x.foo')).toBe(fake);
    expect(await custom.readerFor('x.foo').read(Buffer.from(''), 'x.foo')).toEqual({
      kind: 'text',
      text: 'from the fake reader',
    });
    expect(custom.readerFor('x.png')).toBeInstanceOf(ImageReader);
    expect(custom.readerFor('x.md')).toBeInstanceOf(TextReader);
  });
});
