import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { GitInternalsError } from '../../../shared/domain-errors.js';
import { ONE_COMMIT_LIMITS } from '../workspace.service.js';
import { planZipEntries, type ZipPlanLimits, type ZipPlanStep } from '../zip-entry-rules.js';

/**
 * The one plan both archive surfaces land (`unzip` and `apply_file_upload`):
 * what it makes of an archive on its own, before any door asks what is on disk
 * or what the caller may write.
 */

const DEST = 'knowledge-base/Drop';
/** Limits small enough that a test's entries are a few bytes each. */
const SMALL: ZipPlanLimits = { entries: 100, totalBytes: 10, entryBytes: 6 };

/** `entries`, written into an archive and opened from its bytes, as both surfaces open one. */
function archiveOf(entries: [name: string, content: string | Buffer][]): AdmZip {
  const zip = new AdmZip();
  for (const [name, content] of entries) zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  return new AdmZip(zip.toBuffer());
}

/** An archive whose entries keep the names given VERBATIM, two of one name included (`addFile` replaces a name it already has). */
function archiveWithRawNames(entries: [name: string, content: string][]): AdmZip {
  const zip = new AdmZip();
  entries.forEach(([name, content], i) => {
    const added = zip.addFile(`__raw_${i}`, Buffer.from(content));
    added.entryName = name;
  });
  return new AdmZip(zip.toBuffer());
}

/** `archive` with the uncompressed size its entry `name` declares patched to `size`, in both headers. */
function withDeclaredSize(archive: Buffer, name: string, size: number): Buffer {
  const nameBytes = Buffer.from(name);
  for (const [signature, sizeAt, nameLengthAt, nameAt] of [
    [0x04034b50, 22, 26, 30],
    [0x02014b50, 24, 28, 46],
  ] as const) {
    for (let at = 0; at + nameAt <= archive.length; at++) {
      if (archive.readUInt32LE(at) !== signature || archive.readUInt16LE(at + nameLengthAt) !== nameBytes.length) continue;
      if (archive.subarray(at + nameAt, at + nameAt + nameBytes.length).equals(nameBytes)) archive.writeUInt32LE(size, at + sizeAt);
    }
  }
  return archive;
}

/** Each step without its bytes, which are asserted on their own where they matter. */
const shapes = (steps: ZipPlanStep[]) => steps.map((s) => (s.kind === 'file' ? { ...s, data: s.data.toString() } : s));

describe('planZipEntries', () => {
  it('plans each file under the destination with its bytes, and each directory entry, in the archive\'s order', () => {
    const plan = planZipEntries(archiveOf([['a.md', 'A'], ['Sub/', ''], ['Sub/b.md', 'B']]), DEST, SMALL);

    expect(shapes(plan)).toEqual([
      { kind: 'file', name: 'a.md', target: `${DEST}/a.md`, data: 'A', duplicate: false },
      { kind: 'dir', name: 'Sub/', target: `${DEST}/Sub` },
      { kind: 'file', name: 'Sub/b.md', target: `${DEST}/Sub/b.md`, data: 'B', duplicate: false },
    ]);
  });

  it('drops macOS metadata with no step, and counts none of it toward the entry cap', () => {
    const plan = planZipEntries(
      archiveOf([['__MACOSX/._a.md', 'x'], ['.DS_Store', 'x'], ['Sub/._b.md', 'x'], ['a.md', 'A'], ['b.md', 'B']]),
      DEST,
      { ...SMALL, entries: 2 },
    );

    expect(plan.map((s) => [s.kind, s.name])).toEqual([
      ['file', 'a.md'],
      ['file', 'b.md'],
    ]);
  });

  it('skips every entry past the entry cap, with where it would have landed', () => {
    const plan = planZipEntries(archiveOf([['a.md', 'A'], ['b.md', 'B'], ['c.md', 'C'], ['Sub/', '']]), DEST, { ...SMALL, entries: 2 });

    expect(shapes(plan).slice(2)).toEqual([
      { kind: 'skip', name: 'c.md', target: `${DEST}/c.md`, reason: 'too_many_entries' },
      { kind: 'skip', name: 'Sub/', target: `${DEST}/Sub`, reason: 'too_many_entries' },
    ]);
  });

  it('skips a file past what is left of the total, unread, and plans a smaller one after it', () => {
    const plan = planZipEntries(archiveOf([['a.md', '123456'], ['b.md', '12345'], ['c.md', '1234']]), DEST, SMALL);

    expect(shapes(plan)).toEqual([
      { kind: 'file', name: 'a.md', target: `${DEST}/a.md`, data: '123456', duplicate: false },
      { kind: 'skip', name: 'b.md', target: `${DEST}/b.md`, reason: 'total_too_large' },
      { kind: 'file', name: 'c.md', target: `${DEST}/c.md`, data: '1234', duplicate: false },
    ]);
  });

  it('skips a file past the per-file cap even with the total to spare', () => {
    const plan = planZipEntries(archiveOf([['big.md', '1234567'], ['fits.md', '123456']]), DEST, SMALL);

    expect(plan.map((s) => (s.kind === 'skip' ? s.reason : s.kind))).toEqual(['entry_too_large', 'file']);
  });

  it('caps an archive at 5,000 entries with ONE_COMMIT_LIMITS', () => {
    const entries: [string, string][] = Array.from({ length: 5_001 }, (_, i) => [`f${String(i).padStart(4, '0')}.md`, '']);

    const plan = planZipEntries(archiveOf(entries), DEST, ONE_COMMIT_LIMITS);

    expect(plan.filter((s) => s.kind === 'file')).toHaveLength(5_000);
    expect(plan[5_000]).toEqual({ kind: 'skip', name: 'f5000.md', target: `${DEST}/f5000.md`, reason: 'too_many_entries' });
  });

  /**
   * At the real limits without holding 128 MB: 29 MB that are read, then two
   * entries whose headers DECLARE 100 MB and one byte more over a few bytes of
   * their own. Each is judged on the size it declares and never read, which is
   * also why a byte count from a read could not have caught them.
   */
  it('caps an archive at 128 MB in all and 100 MB per file with ONE_COMMIT_LIMITS, judging a declared size unread', () => {
    const MB = 1024 * 1024;
    const zip = new AdmZip();
    zip.addFile('a.bin', Buffer.alloc(29 * MB));
    zip.addFile('b.md', Buffer.from('tiny'));
    zip.addFile('c.md', Buffer.from('tiny'));
    const archive = withDeclaredSize(withDeclaredSize(zip.toBuffer(), 'b.md', 100 * MB), 'c.md', 100 * MB + 1);

    const plan = planZipEntries(new AdmZip(archive), DEST, ONE_COMMIT_LIMITS);

    expect(plan.map((s) => (s.kind === 'skip' ? s.reason : s.kind))).toEqual(['file', 'total_too_large', 'entry_too_large']);
    expect(plan[0].kind === 'file' && plan[0].data.byteLength).toBe(29 * MB);
  });

  it('skips a symbolic link, with where it would have landed, so a door can tell an access rule from content', () => {
    const zip = new AdmZip();
    for (const name of ['note.md', 'Secret/access.md']) {
      // The unix mode a zip records for a symbolic link (`S_IFLNK | 0777`), in
      // the high half of the external attributes.
      zip.addFile(name, Buffer.from('../../etc/passwd')).header.attr = ((0o120000 | 0o777) << 16) >>> 0;
    }
    zip.addFile('real.md', Buffer.from('real'));

    const plan = planZipEntries(new AdmZip(zip.toBuffer()), DEST, SMALL);

    expect(shapes(plan)).toEqual([
      { kind: 'skip', name: 'note.md', target: `${DEST}/note.md`, reason: 'link' },
      { kind: 'file', name: 'real.md', target: `${DEST}/real.md`, data: 'real', duplicate: false },
      { kind: 'skip', name: 'Secret/access.md', target: `${DEST}/Secret/access.md`, reason: 'link' },
    ]);
  });

  it('skips a name the entry rules refuse, with the rule\'s reason and no place to land', () => {
    const plan = planZipEntries(archiveWithRawNames([['../up.md', 'x'], ['.git/config', 'x']]), DEST, SMALL);

    expect(plan).toEqual([
      { kind: 'skip', name: '../up.md', target: null, reason: 'invalid_name', detail: 'Invalid path' },
      { kind: 'skip', name: '.git/config', target: null, reason: 'invalid_name', detail: new GitInternalsError().message },
    ]);
  });

  it('plans both files of a path the archive carries twice, and marks the later one', () => {
    const plan = planZipEntries(
      archiveWithRawNames([['a.md', 'first'], ['a.md', 'second'], ['Sub/b.md', 'one'], ['Sub\\b.md', 'two']]),
      DEST,
      { ...SMALL, totalBytes: 100 },
    );

    expect(shapes(plan)).toEqual([
      { kind: 'file', name: 'a.md', target: `${DEST}/a.md`, data: 'first', duplicate: false },
      { kind: 'file', name: 'a.md', target: `${DEST}/a.md`, data: 'second', duplicate: true },
      { kind: 'file', name: 'Sub/b.md', target: `${DEST}/Sub/b.md`, data: 'one', duplicate: false },
      { kind: 'file', name: 'Sub/b.md', target: `${DEST}/Sub/b.md`, data: 'two', duplicate: true },
    ]);
  });

  it('skips a directory entry at the path of a file entry, whichever the archive holds first', () => {
    const entries = archiveOf([['Doc', 'D'], ['Doc/', '']]).getEntries();
    const skippedDir = { kind: 'skip', name: 'Doc/', target: `${DEST}/Doc`, reason: 'directory_is_a_file' };
    const file = { kind: 'file', name: 'Doc', target: `${DEST}/Doc`, data: 'D', duplicate: false };

    expect(shapes(planZipEntries({ getEntries: () => entries }, DEST, SMALL))).toEqual([file, skippedDir]);
    expect(shapes(planZipEntries({ getEntries: () => [...entries].reverse() }, DEST, SMALL))).toEqual([skippedDir, file]);
  });

  it('keeps a directory entry whose file of the same path the plan skipped', () => {
    const plan = planZipEntries(archiveOf([['Doc', '1234567'], ['Doc/', '']]), DEST, SMALL);

    expect(plan.map((s) => (s.kind === 'skip' ? s.reason : s.kind))).toEqual(['entry_too_large', 'dir']);
  });
});
