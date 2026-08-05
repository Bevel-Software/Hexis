import { describe, it, expect } from 'vitest';
import { pendingProposals } from '../join-proposals.js';

/**
 * What a join branch proposes, relative to the default branch. This diff IS
 * the request's lifecycle: non-empty ⇒ open, empty ⇒ settled and closed.
 */
const PATH = 'Groups/GTM/access.md';

/** New-format access.md: `read: everyone` self-frontmatter, body = folder rules. */
const base = (body: string) => `---\nread:\n  - everyone\n---\n${body}`;

const DEFAULT_MD = base('read:\n  - GTM Team\n  - Olga Ivanova <olga@bevel.software>\n');

describe('pendingProposals', () => {
  it('reports a person the branch adds under read', () => {
    const branch = base(
      'read:\n  - GTM Team\n  - Olga Ivanova <olga@bevel.software>\n  - Ali Baba <ali@bevel.software>\n',
    );
    expect(pendingProposals(branch, DEFAULT_MD, PATH)).toEqual([
      {
        verb: 'read',
        id: 'user:ali@bevel.software',
        principal: { kind: 'user', email: 'ali@bevel.software', displayName: 'Ali Baba' },
        label: 'Ali Baba',
      },
    ]);
  });

  it('reports a role, and reports the VERB the branch actually asks for', () => {
    // A branch asking for `write` must be visible AS a write request rather
    // than hiding behind "asked to join".
    const branch = base('read:\n  - GTM Team\n  - Olga Ivanova <olga@bevel.software>\nwrite:\n  - Finance Team\n');
    expect(pendingProposals(branch, DEFAULT_MD, PATH)).toEqual([
      {
        verb: 'write',
        id: 'role:finance team',
        principal: { kind: 'role', role: 'Finance Team' },
        label: 'Finance Team',
      },
    ]);
  });

  it('is EMPTY when the branch is identical — the settled state', () => {
    expect(pendingProposals(DEFAULT_MD, DEFAULT_MD, PATH)).toEqual([]);
  });

  it('is EMPTY when the branch grants a SUBSET (its proposal already landed)', () => {
    const branch = base('read:\n  - GTM Team\n');
    expect(pendingProposals(branch, DEFAULT_MD, PATH)).toEqual([]);
  });

  it('ignores a REMOVAL — a branch that drops a grant proposes nothing', () => {
    // Revoking is not something this surface accepts; the branch stays an
    // ordinary change request in the review UI.
    const branch = base('read:\n  - GTM Team\n');
    expect(pendingProposals(branch, DEFAULT_MD, PATH)).toEqual([]);
  });

  it('ignores a `deny` entry — a denial is not something to accept', () => {
    const branch = base(
      'read:\n  - GTM Team\n  - Olga Ivanova <olga@bevel.software>\n  - deny Ali Baba <ali@bevel.software>\n',
    );
    expect(pendingProposals(branch, DEFAULT_MD, PATH)).toEqual([]);
  });

  it('matches principals canonically (case-insensitive email, canonical role)', () => {
    const branch = base('read:\n  - gtm team\n  - Olga I <OLGA@Bevel.Software>\n');
    expect(pendingProposals(branch, DEFAULT_MD, PATH)).toEqual([]);
  });

  it('treats a MALFORMED branch file as proposing nothing (fail-closed)', () => {
    // A body naming a verb but shaped wrong is a hard parse error; there is
    // nothing to offer a manager, and merging is not how this settles anyway.
    expect(pendingProposals(base('read: GTM Team\n'), DEFAULT_MD, PATH)).toEqual([]);
  });

  it('treats a missing branch file as proposing nothing', () => {
    expect(pendingProposals(null, DEFAULT_MD, PATH)).toEqual([]);
  });

  it('surfaces every branch grant when the DEFAULT file is missing or unreadable', () => {
    // The safe direction: show the manager proposals to consider rather than
    // silently swallowing them against an unreadable baseline.
    const branch = base('read:\n  - Ali Baba <ali@bevel.software>\n');
    expect(pendingProposals(branch, null, PATH)).toHaveLength(1);
  });

  it('does not confuse the SELF-frontmatter with folder rules', () => {
    // `read: everyone` in the frontmatter governs the access.md FILE (it is
    // what makes the group discoverable), not the folder — so it must never
    // show up as a proposal to grant everyone read on the group.
    const branch = base('read:\n  - GTM Team\n  - Olga Ivanova <olga@bevel.software>\n');
    expect(pendingProposals(branch, DEFAULT_MD, PATH)).toEqual([]);
  });
});
