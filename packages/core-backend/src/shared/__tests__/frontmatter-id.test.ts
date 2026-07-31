import { describe, test, expect, vi } from 'vitest';
import {
  extractFrontmatter,
  extractFrontmatterId,
  resolveDeclaredId,
  isValidId,
  dedupeById,
} from '../frontmatter-id.js';
import { setFrontmatterField } from '@bevel-software/platform-shared';

describe('extractFrontmatter', () => {
  test('splits a leading --- block from the body', () => {
    const r = extractFrontmatter('---\nid: foo\n---\ntype: http\n');
    expect(r).toEqual({ frontmatter: 'id: foo', body: 'type: http\n' });
  });
  test('null when there is no fence', () => {
    expect(extractFrontmatter('type: http')).toBeNull();
  });
});

describe('extractFrontmatterId', () => {
  test('reads a legacy kebab id from frontmatter', () => {
    expect(extractFrontmatterId('---\nid: foo-bar\n---\n# x')).toBe('foo-bar');
  });
  test('null with no fence or no id', () => {
    expect(extractFrontmatterId('# heading')).toBeNull();
    expect(extractFrontmatterId('---\nnodeType: "[T](T.md)"\n---\n# x')).toBeNull();
  });
});

describe('resolveDeclaredId', () => {
  test('id wins over name, name over fallback', () => {
    expect(resolveDeclaredId({ id: 'the_id', name: 'The Name' }, 'file')).toBe('the_id');
    expect(resolveDeclaredId({ name: 'the_name' }, 'file')).toBe('the_name');
    expect(resolveDeclaredId({}, 'file')).toBe('file');
    expect(resolveDeclaredId({ id: '   ' }, 'file')).toBe('file'); // blank id ignored
  });
});

describe('isValidId', () => {
  test('accepts lowercase snake_case, rejects hyphens/uppercase/leading underscore', () => {
    for (const ok of ['a', 'my_tool', 'weather1', 'a_b_c']) expect(isValidId(ok)).toBe(true);
    for (const bad of ['a-b', 'My_Tool', '_x', '', 'a b']) expect(isValidId(bad)).toBe(false);
  });
});

describe('dedupeById', () => {
  test('keeps the first, refuses later duplicates and reports them', () => {
    const onDup = vi.fn();
    const items = [
      { id: 'a', at: 1 },
      { id: 'b', at: 2 },
      { id: 'a', at: 3 }, // duplicate
    ];
    const out = dedupeById(items, (x) => x.id, (x, id) => onDup(id, x.at));
    expect(out.map((x) => x.at)).toEqual([1, 2]); // first `a` kept, second dropped
    expect(onDup).toHaveBeenCalledWith('a', 3);
  });
});

describe('setFrontmatterField (shared, line-based)', () => {
  test('replaces an existing key, leaving every other line byte-identical', () => {
    const node = '---\nnodeType: "[Thing](../NodeTypes/Thing.md)"\nid: "old-id"\nwrite:\n  - Product Team\n---\n\n# Name\nFoo\n';
    const out = setFrontmatterField(node, 'id', 'old-id2');
    expect(out).toBe('---\nnodeType: "[Thing](../NodeTypes/Thing.md)"\nid: old-id2\nwrite:\n  - Product Team\n---\n\n# Name\nFoo\n');
  });

  test('inserts a missing key at the top of an existing block', () => {
    const out = setFrontmatterField('---\nname: weather\n---\n{"type":"http"}\n', 'id', 'weather2');
    expect(out).toBe('---\nid: weather2\nname: weather\n---\n{"type":"http"}\n');
  });

  test('creates a frontmatter block when the file has none', () => {
    const out = setFrontmatterField('{"type":"http","url":"https://x/m"}', 'id', 'tool_x');
    expect(out).toBe('---\nid: tool_x\n---\n{"type":"http","url":"https://x/m"}');
  });

  test('does not touch a same-named key in the BODY', () => {
    const out = setFrontmatterField('---\nid: a\n---\nid: body-line stays\n', 'id', 'b');
    expect(out).toBe('---\nid: b\n---\nid: body-line stays\n');
  });

  test("preserves a CRLF file's line endings byte-for-byte", () => {
    const crlf = '---\r\nid: a\r\nname: keep\r\n---\r\nbody line\r\n';
    const out = setFrontmatterField(crlf, 'id', 'b');
    expect(out).toBe('---\r\nid: b\r\nname: keep\r\n---\r\nbody line\r\n');
  });
});
