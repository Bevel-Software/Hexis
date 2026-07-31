import { describe, it, expect } from 'vitest';
import { parseFrontmatter, labelFor } from '../frontmatter';

describe('parseFrontmatter', () => {
  it('returns the whole content as body when there is no frontmatter', () => {
    const { data, body } = parseFrontmatter('# Just a heading\n\ntext');
    expect(data).toEqual({});
    expect(body).toBe('# Just a heading\n\ntext');
  });

  it('parses simple scalars and strips the block from the body', () => {
    const { data, body } = parseFrontmatter('---\nname: rfi\nversion: 1.4.0\n---\n\n# Body');
    expect(data.name).toBe('rfi');
    expect(data.version).toBe('1.4.0');
    expect(body).toBe('# Body');
  });

  it('parses a YAML block scalar (`|`) as the joined multi-line text, not "|"', () => {
    const src = [
      '---',
      'name: rfi',
      'description: |',
      '  Specialist RFI responder. Runs KB-only: every answer is',
      '  grounded in a real knowledge-graph node.',
      'allowed-tools:',
      '  - Bash',
      '  - Read',
      '---',
      '',
      '# Body',
    ].join('\n');
    const { data } = parseFrontmatter(src);

    // The bug: naive parsing stored "|" and turned the colon line into a key.
    expect(data.description).not.toBe('|');
    expect(data.description).toContain('Specialist RFI responder');
    expect(data.description).toContain('grounded in a real knowledge-graph node');
    // No bogus key derived from the "Runs KB-only:" colon inside the scalar.
    expect(Object.keys(data)).toEqual(['name', 'description', 'allowed-tools']);
    // Lists stay arrays.
    expect(data['allowed-tools']).toEqual(['Bash', 'Read']);
  });

  it('keeps a quoted markdown-link scalar (nodeType) intact', () => {
    const { data } = parseFrontmatter(
      '---\nnodeType: "[Process](../NodeTypes/Process.md)"\n---\n\n# Body',
    );
    expect(data.nodeType).toBe('[Process](../NodeTypes/Process.md)');
  });

  it('renders a nested map (metadata) as a readable string', () => {
    const { data } = parseFrontmatter(
      '---\nmetadata:\n  author: example-org\n  version: "1.0"\n---\n',
    );
    expect(data.metadata).toBe('author: example-org, version: 1.0');
  });

  it('does not infinite-loop on a circular YAML anchor/alias', () => {
    // `a: &x { b: *x }` makes toJS() return a cyclic object; rendering it must
    // terminate with a `[circular]` placeholder rather than overflow the stack.
    const { data } = parseFrontmatter('---\na: &x\n  b: *x\n---\n\n# Body');
    expect(typeof data.a).toBe('string');
    expect(data.a).toContain('[circular]');
  });

  it('falls back safely when toJS throws (alias bomb), keeping the body', () => {
    const src = [
      '---',
      'a: &a [x,x,x,x,x,x,x,x,x,x]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      '---',
      '',
      '# Body',
    ].join('\n');
    const { data, body } = parseFrontmatter(src);
    expect(data).toEqual({});
    expect(body).toBe('# Body');
  });

  it('is resilient: one malformed entry does not drop the valid sibling entries', () => {
    // A malformed `bad` entry must not blank the access entries around it —
    // permissions have to always surface.
    const src = [
      '---',
      'write:',
      '  - Admin',
      'bad: [unclosed',
      'download:',
      '  - Felix <felix@x.eu>',
      '---',
      '',
      '# Body',
    ].join('\n');
    const { data, body } = parseFrontmatter(src);
    expect(data.write).toEqual(['Admin']);
    expect(data.download).toEqual(['Felix <felix@x.eu>']);
    expect(body).toBe('# Body');
  });
});

describe('labelFor', () => {
  it('humanizes camelCase keys', () => {
    expect(labelFor('nodeType')).toBe('Node Type');
    expect(labelFor('name')).toBe('Name');
  });
});
