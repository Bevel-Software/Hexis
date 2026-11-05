import { describe, it, expect } from 'vitest';
import { pendingProposals } from '../join-proposals.js';

/**
 * What a request's branch proposes, relative to the default branch. This diff
 * IS the request's lifecycle: non-empty ⇒ open, empty ⇒ settled and closed,
 * null ⇒ the branch could not be read and nothing may be concluded.
 *
 * Which grammar reads it follows the ITEM, and the second describe below is
 * why: a folder's rules are block lists in an access.md body, a file's are its
 * own frontmatter, where a single grant is a scalar.
 */
const PATH = 'Plugins/GTM/access.md';

/** New-format access.md: `read: everyone` self-frontmatter, body = folder rules. */
const base = (body: string) => `---\nread:\n  - everyone\n---\n${body}`;

const DEFAULT_MD = base('read:\n  - GTM Team\n  - Olga Ivanova <olga@bevel.software>\n');

describe('pendingProposals', () => {
  it('reports a person the branch adds under read', () => {
    const branch = base(
      'read:\n  - GTM Team\n  - Olga Ivanova <olga@bevel.software>\n  - Ali Baba <ali@bevel.software>\n',
    );
    expect(pendingProposals(branch, DEFAULT_MD, PATH, 'folder')).toEqual([
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
    expect(pendingProposals(branch, DEFAULT_MD, PATH, 'folder')).toEqual([
      {
        verb: 'write',
        id: 'role:finance team',
        principal: { kind: 'role', role: 'Finance Team' },
        label: 'Finance Team',
      },
    ]);
  });

  it('is EMPTY when the branch is identical — the settled state', () => {
    expect(pendingProposals(DEFAULT_MD, DEFAULT_MD, PATH, 'folder')).toEqual([]);
  });

  it('is EMPTY when the branch grants a SUBSET (its proposal already landed)', () => {
    const branch = base('read:\n  - Olga Ivanova <olga@bevel.software>\n');
    expect(pendingProposals(branch, DEFAULT_MD, PATH, 'folder')).toEqual([]);
  });

  it('ignores a REMOVAL — a branch that drops one grant but keeps the rest proposes nothing', () => {
    // Revoking is not something this surface accepts; the branch stays an
    // ordinary change request in the review UI. (Distinct from the subset
    // case above: here GTM Team survives and only Olga is dropped.)
    const branch = base('read:\n  - GTM Team\n');
    expect(pendingProposals(branch, DEFAULT_MD, PATH, 'folder')).toEqual([]);
  });

  it('ignores a `deny` entry — a denial is not something to accept', () => {
    const branch = base(
      'read:\n  - GTM Team\n  - Olga Ivanova <olga@bevel.software>\n  - deny Ali Baba <ali@bevel.software>\n',
    );
    expect(pendingProposals(branch, DEFAULT_MD, PATH, 'folder')).toEqual([]);
  });

  it('matches principals canonically (case-insensitive email, canonical role)', () => {
    const branch = base('read:\n  - gtm team\n  - Olga I <OLGA@Bevel.Software>\n');
    expect(pendingProposals(branch, DEFAULT_MD, PATH, 'folder')).toEqual([]);
  });

  it('says NOTHING about a malformed branch file — not "nothing to propose"', () => {
    // A body naming a verb but shaped wrong is a hard parse error. The
    // difference matters because an empty answer CLOSES the request: it has
    // to mean the branch asks for nothing more, never that it would not say.
    expect(pendingProposals(base('read: GTM Team\n'), DEFAULT_MD, PATH, 'folder')).toBeNull();
  });

  it('says NOTHING about a missing branch file either', () => {
    expect(pendingProposals(null, DEFAULT_MD, PATH, 'folder')).toBeNull();
  });

  it('surfaces every branch grant when the DEFAULT file is missing or unreadable', () => {
    // The safe direction on THAT side: show the editor proposals to consider
    // rather than swallowing them against a baseline nobody could read.
    const branch = base('read:\n  - Ali Baba <ali@bevel.software>\n');
    expect(pendingProposals(branch, null, PATH, 'folder')).toHaveLength(1);
    expect(pendingProposals(branch, base('read: broken\n'), PATH, 'folder')).toHaveLength(1);
  });

  it('does not confuse the SELF-frontmatter with folder rules', () => {
    // The frontmatter governs the access.md FILE, not the folder. The branch
    // here DIFFERS from the default in its frontmatter only (an extra
    // self-read grant) while carrying identical folder rules — so an
    // implementation that read the wrong block would report a proposal, and
    // the correct one reports none. (Identical inputs would prove nothing.)
    const branch =
      '---\nread:\n  - everyone\n  - Ali Baba <ali@bevel.software>\n---\n' +
      'read:\n  - GTM Team\n  - Olga Ivanova <olga@bevel.software>\n';
    expect(pendingProposals(branch, DEFAULT_MD, PATH, 'folder')).toEqual([]);
  });
});

/**
 * A FILE's rules are not an access.md. They live in the node's own
 * frontmatter, and `spliceGrant` writes one grant there as the scalar form
 * the resolver accepts — `write: Rita <rita@x.io>`, not a list.
 *
 * Read with the FOLDER grammar that is a hard parse error ("'write:' must be
 * a list"), the whole file yields no grants, and a branch with a perfectly
 * good proposal on it looks like a branch with nothing left to propose. Every
 * request whose target was a file was closed on the editors' first listing
 * because of it — before anyone saw the line, let alone pressed Accept.
 */
describe('pendingProposals on a FILE, whose rules are its own frontmatter', () => {
  const FILE = 'Research/Notes.md';
  const LIVE = '---\nnodeType: "[Note](../NodeTypes/Note.md)"\n---\n# Notes\n\nbody\n';
  /** Exactly what `spliceGrant(..., { allowScalar: true, target: 'node' })` writes. */
  const ASKS_WRITE =
    '---\nnodeType: "[Note](../NodeTypes/Note.md)"\nwrite: Rita Reader <rita@x.io>\n---\n# Notes\n\nbody\n';

  it('reads the scalar grant the splice actually writes', () => {
    expect(pendingProposals(ASKS_WRITE, LIVE, FILE, 'file')).toEqual([
      {
        verb: 'write',
        id: 'user:rita@x.io',
        principal: { kind: 'user', email: 'rita@x.io', displayName: 'Rita Reader' },
        label: 'Rita Reader',
      },
    ]);
  });

  it('is not fooled by the FOLDER grammar, which cannot read it at all', () => {
    // The regression guard. Before, this answered `[]` — indistinguishable
    // from a finished request, which is what closed them.
    expect(pendingProposals(ASKS_WRITE, LIVE, FILE, 'folder')).toBeNull();
  });

  it('ignores the non-access keys a node legitimately carries', () => {
    expect(pendingProposals(LIVE, LIVE, FILE, 'file')).toEqual([]);
    // `nodeType` is not a grant, and its presence is not a parse failure.
    expect(pendingProposals(LIVE, null, FILE, 'file')).toEqual([]);
  });

  it('reads a file with no frontmatter as granting nothing, not as unreadable', () => {
    // Nothing to say is a real answer here; a node need not declare rules.
    expect(pendingProposals('# Just a note\n', LIVE, FILE, 'file')).toEqual([]);
  });

  it('says NOTHING about a file whose frontmatter is broken — not "nothing to propose"', () => {
    // The same rule the folder side keeps: an empty answer closes somebody's
    // request, so a block that could not be read must not produce one.
    const neverClosed = '---\nnodeType: "[Note](x)"\nwrite: Rita Reader <rita@x.io>\n# Notes\n\nbody\n';
    expect(pendingProposals(neverClosed, LIVE, FILE, 'file')).toBeNull();
    const notAMapping = '---\n- just\n- a list\n---\n# Notes\n';
    expect(pendingProposals(notAMapping, LIVE, FILE, 'file')).toBeNull();
    // An empty block is readable, and says nothing.
    expect(pendingProposals('---\n---\n# Notes\n', LIVE, FILE, 'file')).toEqual([]);
    // A broken copy on LIVE stays the safe direction: every grant looks incoming.
    expect(pendingProposals(ASKS_WRITE, neverClosed, FILE, 'file')).toEqual([
      expect.objectContaining({ verb: 'write', id: 'user:rita@x.io' }),
    ]);
  });

  it('reads the list form too, and an Owner request', () => {
    const asksOwner =
      '---\nnodeType: "[Note](x)"\nowner:\n  - Rita Reader <rita@x.io>\n---\n# Notes\n';
    expect(pendingProposals(asksOwner, LIVE, FILE, 'file')).toEqual([
      expect.objectContaining({ verb: 'owner', id: 'user:rita@x.io' }),
    ]);
  });

  it('still settles a file request once the grant is on live', () => {
    expect(pendingProposals(ASKS_WRITE, ASKS_WRITE, FILE, 'file')).toEqual([]);
  });
});
