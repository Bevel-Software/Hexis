import { describe, it, expect } from 'vitest';
import { printable, sanitizedPath } from '../printable.js';

/**
 * The two renderings of caller-supplied text, and the one promise they share:
 * whatever a caller put in a name, the text it becomes occupies ONE line.
 */
describe('printable', () => {
  it('quotes and escapes the controls a log line could be forged with', () => {
    expect(printable('python-httpx/0.28.1')).toBe('"python-httpx/0.28.1"');
    expect(printable('evil\n[forged]')).toBe('"evil\\n[forged]"');
    // C1 (U+009B is a one-byte CSI) and the JS line separators, which
    // JSON.stringify leaves raw.
    expect(printable('a\u009bb')).toBe('"a\\u009bb"');
    expect(printable('a\u2028b\u2029c')).toBe('"a\\u2028b\\u2029c"');
  });
});

describe('sanitizedPath', () => {
  it('leaves an ordinary path exactly as it was', () => {
    expect(sanitizedPath('knowledge-base/Knowledge/Note.md')).toBe('knowledge-base/Knowledge/Note.md');
  });

  it('escapes CR and LF, so a name cannot forge a second line of a refusal', () => {
    expect(sanitizedPath('a\nb.md')).toBe('a\\nb.md');
    expect(sanitizedPath('a\r\nb.md')).toBe('a\\r\\nb.md');
  });

  it('escapes the other mandatory breaks — vertical tab, form feed, NEL — as `printable` spells them', () => {
    expect(sanitizedPath('a\vb\fc\u0085d.md')).toBe('a\\u000bb\\u000cc\\u0085d.md');
  });

  it('escapes every other C0/C1 control too, so a name cannot steer a terminal', () => {
    // U+009B is the one-byte CSI: on its own it starts an ANSI sequence.
    expect(sanitizedPath('a\u009b31mb.md')).toBe('a\\u009b31mb.md');
    expect(sanitizedPath('a\u0000b\u001bc\u007fd.md')).toBe('a\\u0000b\\u001bc\\u007fd.md');
    expect(sanitizedPath('tab\there.md')).toBe('tab\\there.md');
  });

  // U+2028/U+2029 render as line breaks in editors, terminals and JSON
  // consumers, and `JSON.stringify` passes them through raw — so a path
  // carrying one survives being carried, in the `path` field of a not-found
  // body and in the log line beside it, and breaks the line at the far end.
  it('escapes the Unicode line separators too, which JSON.stringify does not', () => {
    expect(sanitizedPath('a\u2028b.md')).toBe('a\\u2028b.md');
    expect(sanitizedPath('a\u2029b.md')).toBe('a\\u2029b.md');
    const forged = 'note.md\u2028error: everything is fine';
    expect(sanitizedPath(forged)).not.toContain('\u2028');
    expect(JSON.stringify(sanitizedPath(forged))).not.toContain('\u2028');
  });

  it('is idempotent: sanitizing an already-sanitized path changes nothing', () => {
    const once = sanitizedPath('a\nb\u2028c.md');
    expect(sanitizedPath(once)).toBe(once);
  });
});
