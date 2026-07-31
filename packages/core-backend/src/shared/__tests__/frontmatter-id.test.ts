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

  /**
   * REGRESSION GUARD for the "one folder = one space" model.
   *
   * Spaces are grouping folders under the catalog root, and a tool or skill
   * shared by two spaces is expected to be duplicated as two files with
   * DISTINCT ids. Nothing enforces that convention — `seen` is a single
   * global Set keyed on the declared id, with no notion of the folder the
   * item came from. So the moment two spaces hold a same-named item, one of
   * them silently disappears from the catalog.
   *
   * These tests pin that behaviour so it is a documented, observable
   * property rather than a surprise. If dedup ever becomes folder-scoped,
   * they are the tests that should change.
   */
  test('same id in two different space folders: the second folder loses its copy', () => {
    const onDup = vi.fn();
    // Services sort by (name, path) before deduping, so path order is stable.
    const items = [
      { name: 'notion', path: 'Tools/Everyone/notion.tool' },
      { name: 'notion', path: 'Tools/Finance/notion.tool' },
    ];
    const out = dedupeById(items, (x) => x.name, (x, id) => onDup(id, x.path));

    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('Tools/Everyone/notion.tool');
    // The Finance space loses its tool entirely — only a server-side warning
    // marks it, which is why the convention needs distinct ids per space.
    expect(onDup).toHaveBeenCalledWith('notion', 'Tools/Finance/notion.tool');
  });

  test('distinct ids per space folder keep BOTH copies — the supported pattern', () => {
    const onDup = vi.fn();
    const items = [
      { name: 'everyone_notion', path: 'Tools/Everyone/notion.tool' },
      { name: 'finance_notion', path: 'Tools/Finance/notion.tool' },
    ];
    const out = dedupeById(items, (x) => x.name, (x, id) => onDup(id, x.path));

    expect(out).toHaveLength(2);
    expect(onDup).not.toHaveBeenCalled();
  });

  test('the surviving copy is the alphabetically-first path, not scan order', () => {
    // Deterministic winner matters: an unstable one means a space's tool
    // appears or vanishes depending on filesystem iteration order.
    const items = [
      { name: 'x', path: 'Tools/Zulu/x.tool' },
      { name: 'x', path: 'Tools/Alpha/x.tool' },
    ].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

    expect(dedupeById(items, (i) => i.name)[0].path).toBe('Tools/Alpha/x.tool');
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
