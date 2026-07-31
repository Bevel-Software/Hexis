import { describe, it, expect } from 'vitest';
import { formatAffectedOwnersBlock, MAX_AFFECTED_PATHS_LISTED } from '../workflow.service.js';

type Info = { roles: string[]; users: { name: string; email: string }[] };
const resolvedOf = (entries: Record<string, Info>) => new Map(Object.entries(entries));

describe('formatAffectedOwnersBlock', () => {
  it('returns "" when no path has resolvable eligibility', () => {
    expect(formatAffectedOwnersBlock(['a.md', 'b.md'], resolvedOf({}))).toBe('');
  });

  it('lists each path with its roles and named users', () => {
    const out = formatAffectedOwnersBlock(
      ['a.md', 'b.md'],
      resolvedOf({
        'a.md': { roles: ['Product Team'], users: [{ name: 'Jane', email: 'jane@x.io' }] },
        'b.md': { roles: ['Admin'], users: [] },
      }),
    );
    expect(out).toBe(
      ['## Affected owners', '', '- `a.md` — Product Team; Jane <jane@x.io>', '- `b.md` — Admin'].join('\n'),
    );
  });

  it('skips paths with no eligible writers', () => {
    const out = formatAffectedOwnersBlock(
      ['a.md', 'skip.md'],
      resolvedOf({
        'a.md': { roles: ['Admin'], users: [] },
        'skip.md': { roles: [], users: [] },
      }),
    );
    expect(out).toBe(['## Affected owners', '', '- `a.md` — Admin'].join('\n'));
  });

  it('caps the per-path list and summarizes the overflow with deduped approvers', () => {
    const paths = Array.from({ length: 120 }, (_, i) => `f${i}.md`);
    const resolved = resolvedOf(
      Object.fromEntries(
        paths.map((p, i) => [
          p,
          { roles: [i % 2 ? 'Admin' : 'Product Team'], users: [{ name: 'Jane', email: 'jane@x.io' }] },
        ]),
      ),
    );
    const out = formatAffectedOwnersBlock(paths, resolved, 50);
    const lines = out.split('\n');
    // 2 header lines + 50 listed + 1 blank + 1 summary
    expect(lines.filter((l) => l.startsWith('- `')).length).toBe(50);
    expect(out).toContain('…and 70 more changed path(s).');
    // deduped: roles sorted, single Jane despite 120 occurrences
    expect(out).toContain('All eligible approvers across this change: Admin, Product Team; Jane <jane@x.io>');
  });

  it('does not append a summary when the path count is within the cap', () => {
    const out = formatAffectedOwnersBlock(
      ['a.md'],
      resolvedOf({ 'a.md': { roles: ['Admin'], users: [] } }),
      50,
    );
    expect(out).not.toContain('more changed path(s)');
  });

  it('exposes a sane default cap', () => {
    expect(MAX_AFFECTED_PATHS_LISTED).toBe(50);
  });
});
