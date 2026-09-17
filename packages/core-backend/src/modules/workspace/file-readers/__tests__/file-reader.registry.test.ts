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
import { OCTET_STREAM_FALLBACK_NOTE, contentModeOf, fileTypeOf, needsContent } from '../content-mode.js';
import { FRONTMATTER_CARRIER_EXTENSIONS, canCarryFrontmatter } from '@bevel-software/platform-shared';
import { accessFrontmatterExtensionList } from '../../../access-model/access-grammar.js';

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

  it('fileTypeOf gives the four kinds, a mime and its source from the reader that owns the file', () => {
    const text = Buffer.from('hello text\n');
    const bytes = Buffer.from([0x00, 0x01, 0xff]);
    const typeOf = (p: string, b: Buffer) => {
      const reader = registry.readerFor(p);
      return fileTypeOf(reader, p, needsContent(reader) ? b : undefined);
    };
    // Extensionless UTF-8: text, as read_file and grep treat it.
    expect(typeOf('Sample file', text)).toEqual({ contentMode: 'text', kind: 'text', mime: 'text/plain', mimeSource: 'sniff', textEditable: true });
    expect(typeOf('notes.md', text)).toMatchObject({ kind: 'text', mime: 'text/plain', textEditable: true });
    // Documents answer from the extension; the content is not consulted.
    expect(typeOf('plata.pdf', text)).toEqual({ contentMode: 'document', kind: 'document', mime: 'application/pdf', mimeSource: 'extension', textEditable: false });
    expect(typeOf('memo.docx', bytes)).toMatchObject({
      kind: 'document',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      mimeSource: 'extension',
      textEditable: false,
    });
    expect(typeOf('old.doc', bytes)).toMatchObject({ kind: 'document', mime: 'application/msword', textEditable: false });
    expect(typeOf('logo.png', bytes)).toEqual({ contentMode: 'binary', kind: 'image', mime: 'image/png', mimeSource: 'extension', textEditable: false });
    expect(typeOf('scan.tiff', bytes)).toMatchObject({ kind: 'image', textEditable: false });
    expect(typeOf('bundle.zip', bytes)).toMatchObject({ kind: 'binary', mime: 'application/zip', mimeSource: 'extension' });
    // Real binary bytes, no known extension: octet-stream, flagged as a fallback.
    for (const p of ['Sample blob', 'blob.dat']) {
      expect(typeOf(p, bytes), p).toEqual({
        contentMode: 'binary',
        kind: 'binary',
        mime: 'application/octet-stream',
        mimeSource: 'fallback',
        textEditable: false,
        mimeNote: OCTET_STREAM_FALLBACK_NOTE,
      });
    }
    // Invalid UTF-8 without a NUL is binary too — the write gate would refuse it.
    expect(typeOf('latin1', Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toMatchObject({ kind: 'binary', mimeSource: 'fallback' });
    // A named mime never carries the fallback note.
    expect(typeOf('logo.png', bytes)).not.toHaveProperty('mimeNote');
  });

  it('every extension a reader claims names its mime — only the fallback reader falls back to octet-stream', () => {
    const owned = registry.ownedExtensions();
    expect(owned).toEqual(expect.arrayContaining(['.pdf', '.png', '.doc', '.tiff', '.tgz', '.ogg']));
    for (const ext of owned) {
      const p = `file${ext}`;
      const reader = registry.readerFor(p);
      const type = fileTypeOf(reader, p, needsContent(reader) ? Buffer.from([0x00, 0xff]) : undefined);
      expect(type.mimeSource, ext).toBe('extension');
      expect(type, ext).not.toHaveProperty('mimeNote');
    }
    expect(fileTypeOf(registry.readerFor('scan.tiff'), 'scan.tiff', undefined)).toMatchObject({ kind: 'image', mime: 'image/tiff' });
    expect(fileTypeOf(registry.readerFor('a.tgz'), 'a.tgz', undefined)).toMatchObject({ kind: 'binary', mime: 'application/gzip' });
    expect(fileTypeOf(registry.readerFor('song.ogg'), 'song.ogg', undefined)).toMatchObject({ kind: 'binary', mime: 'audio/ogg' });
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

/**
 * `canCarryFrontmatter` (platform-shared) is the one predicate that decides
 * which files may hold their own access rules; it is derived from this
 * registry. Pinned here so the two cannot drift: a carrier extension must be
 * served by a text-editable text reader, and no extension a non-text reader
 * claims may ever count as a carrier.
 */
describe('frontmatter carriers follow the registry', () => {
  it('the carriers are exactly the resolver’s core access-frontmatter set', () => {
    // Pinned exactly, so an emptied or widened list fails here rather than
    // letting the loop below pass vacuously. `accessFrontmatterExtensionList`
    // may hold overlay registrations from other suites; core's are a subset.
    expect([...FRONTMATTER_CARRIER_EXTENSIONS].sort()).toEqual(['.md', '.tool']);
    for (const ext of FRONTMATTER_CARRIER_EXTENSIONS) {
      expect(accessFrontmatterExtensionList(), ext).toContain(ext);
    }
  });

  it('every carrier extension is claimed by no specialised reader and reads as editable text', () => {
    const owned = new Set(registry.ownedExtensions());
    expect(FRONTMATTER_CARRIER_EXTENSIONS.length).toBeGreaterThan(0);
    for (const ext of FRONTMATTER_CARRIER_EXTENSIONS) {
      expect(owned.has(ext), ext).toBe(false);
      const reader = registry.readerFor(`Notes/note${ext}`);
      expect(reader.textEditable, ext).toBe(true);
      expect(reader.fileKind, ext).toBe('text');
      expect(canCarryFrontmatter(`Notes/note${ext}`), ext).toBe(true);
      // Case-sensitive, as the resolver is: `NOTE.MD` carries no enforced rule.
      expect(canCarryFrontmatter(`Notes/NOTE${ext.toUpperCase()}`), ext).toBe(false);
    }
  });

  it('no extension a reader claims is a carrier, and neither is an extensionless file', () => {
    for (const ext of registry.ownedExtensions()) {
      expect(canCarryFrontmatter(`Sales/file${ext}`), ext).toBe(false);
    }
    for (const p of ['Sales/Report.pdf', 'Sales/Deck.pptx', 'Sales/Logo.png', 'Sales/blob', 'Sales/.hidden', 'notes.txt']) {
      expect(canCarryFrontmatter(p), p).toBe(false);
    }
  });
});
