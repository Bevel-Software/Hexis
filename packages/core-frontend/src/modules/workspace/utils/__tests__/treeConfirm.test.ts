import { describe, it, expect, afterEach } from 'vitest';
import { DEFAULT_KB_LAYOUT, configureKbLayout } from '@bevel-software/platform-shared';
import type { AccessPrincipalRef, PathPrincipals } from '../../../access/api';
import type { FileTreeEntry } from '@bevel-software/platform-shared';
import {
  accessChangeLines,
  deleteSentence,
  moveQuestion,
  moveSentence,
  moveWarnings,
  platformFileDragRefusal,
  platformFileMoveRefusal,
  principalLabel,
} from '../treeConfirm';

/**
 * The delete question counts what the listing shows. When the caller's read
 * rules kept entries out of it, the delete still takes them, so the sentence
 * stops naming a count as the whole and says what the count is.
 */
describe('deleteSentence', () => {
  const folder: FileTreeEntry = {
    name: 'Sales',
    relativePath: 'knowledge-base/KnowledgeBase/Sales',
    type: 'directory',
    children: [
      { name: 'a.md', relativePath: 'knowledge-base/KnowledgeBase/Sales/a.md', type: 'file' },
      { name: 'b.md', relativePath: 'knowledge-base/KnowledgeBase/Sales/b.md', type: 'file' },
    ],
  };

  it('counts the files it can see when the listing is whole', () => {
    expect(deleteSentence(folder)).toBe('Delete Sales and its 2 files?');
  });

  it('says "everything in it" when the folder had entries withheld', () => {
    expect(deleteSentence(folder, undefined, true)).toBe(
      'Delete Sales and everything in it? (2 files you can see; it holds more you can\'t.)',
    );
  });
});

/**
 * What the move confirmation says about access. The tester who failed the
 * previous move warning asked for names — "these people would lose the
 * following access, these people would gain the following access" — so these
 * cases are the sentences, not the resolution: the resolver's before and after
 * lists go in, the lines the dialog reads go out.
 */

const group = (name: string): AccessPrincipalRef => ({ kind: 'group', name });
const role = (name: string): AccessPrincipalRef => ({ kind: 'role', name });
const person = (name: string, email: string): AccessPrincipalRef => ({ kind: 'person', name, email });
const plugin = (token: string): AccessPrincipalRef => ({ kind: 'plugin', name: token });

/** The layout is module state shared by the whole file; each test that names one puts the defaults back. */
afterEach(() => configureKbLayout({ ...DEFAULT_KB_LAYOUT }));

const side = (read: AccessPrincipalRef[], write: AccessPrincipalRef[] = []): PathPrincipals => ({
  read,
  write,
});

describe('accessChangeLines', () => {
  it('names who loses access, by verb', () => {
    const change = accessChangeLines(
      side([group('Engineering')], [group('Engineering')]),
      side([], []),
    );

    expect(change.lose).toEqual([
      'Engineering: can no longer open',
      'Engineering: can no longer edit',
    ]);
    expect(change.gain).toEqual([]);
  });

  it('names who gains access, by verb', () => {
    const change = accessChangeLines(side([], []), side([group('Product')], [group('Product')]));

    expect(change.lose).toEqual([]);
    expect(change.gain).toEqual(['Product: can open', 'Product: can edit']);
  });

  it('lists both blocks when the move costs one group and serves another', () => {
    const change = accessChangeLines(side([group('Engineering')]), side([group('Product')]));

    expect(change.lose).toEqual(['Engineering: can no longer open']);
    expect(change.gain).toEqual(['Product: can open']);
  });

  it('reports no change at all when both sides resolve the same', () => {
    const both = side([group('Engineering'), person('Ali Raza', 'ali@x.io')], [group('Engineering')]);

    expect(accessChangeLines(both, both)).toEqual({ lose: [], gain: [] });
  });

  it('is unmoved by the order the resolver happens to list principals in', () => {
    const before = side([group('Engineering'), group('Product')]);
    const after = side([group('Product'), group('Engineering')]);

    expect(accessChangeLines(before, after)).toEqual({ lose: [], gain: [] });
  });

  it('names a directly granted person, by the name on the grant', () => {
    const change = accessChangeLines(side([person('Ali Raza', 'ali@x.io')]), side([]));

    expect(change.lose).toEqual(['Ali Raza: can no longer open']);
  });

  it('matches a person on their address, whatever name each side carries', () => {
    const change = accessChangeLines(
      side([person('Ali Raza', 'ali@x.io')]),
      side([person('ali@x.io', 'ALI@x.io')]),
    );

    expect(change).toEqual({ lose: [], gain: [] });
  });

  it('falls back to a nameless person’s address rather than an empty line', () => {
    const change = accessChangeLines(side([]), side([person('', 'ali@x.io')]));

    expect(change.gain).toEqual(['ali@x.io: can open']);
  });

  it('keeps a group and a same-named role apart — they are different principals', () => {
    const change = accessChangeLines(side([group('Design')]), side([role('Design')]));

    expect(change.lose).toEqual(['Design: can no longer open']);
    expect(change.gain).toEqual(['Design: can open']);
  });

  it('names a plugin principal as the share sheet does', () => {
    const change = accessChangeLines(side([]), side([plugin('plugin/GTM/read')]));

    expect(change.gain).toEqual(['GTM · readers: can open']);
  });

  it('names the built-in everyone role Everyone', () => {
    const change = accessChangeLines(side([role('everyone')]), side([]));

    expect(change.lose).toEqual(['Everyone: can no longer open']);
  });

  it('puts one principal’s two verbs together, opening before editing', () => {
    const change = accessChangeLines(
      side([group('Engineering'), group('Ops')], [group('Ops')]),
      side([]),
    );

    expect(change.lose).toEqual([
      'Engineering: can no longer open',
      'Ops: can no longer open',
      'Ops: can no longer edit',
    ]);
  });

  it('lists a principal in both blocks when it trades one verb for another', () => {
    const change = accessChangeLines(
      side([group('Engineering')], [group('Engineering')]),
      side([group('Engineering')], []),
    );

    expect(change.lose).toEqual(['Engineering: can no longer edit']);
    expect(change.gain).toEqual([]);
  });

  it('shows six lines and folds the rest into "and N more"', () => {
    const many = Array.from({ length: 9 }, (_, i) => group(`Team ${i + 1}`));
    const change = accessChangeLines(side(many), side([]));

    expect(change.lose).toHaveLength(7);
    expect(change.lose[5]).toBe('Team 6: can no longer open');
    expect(change.lose[6]).toBe('and 3 more');
  });

  it('caps at six without a count when there are exactly six', () => {
    const six = Array.from({ length: 6 }, (_, i) => group(`Team ${i + 1}`));
    const change = accessChangeLines(side([]), side(six));

    expect(change.gain).toHaveLength(6);
    expect(change.gain.at(-1)).toBe('Team 6: can open');
  });

  it('caps each block on its own', () => {
    const losers = Array.from({ length: 8 }, (_, i) => group(`Old ${i + 1}`));
    const change = accessChangeLines(side(losers), side([group('Product')]));

    expect(change.lose.at(-1)).toBe('and 2 more');
    expect(change.gain).toEqual(['Product: can open']);
  });
});

describe('the move question', () => {
  it('asks it plainly, for the blocks to answer under', () => {
    expect(moveQuestion('contract.pdf', 'Sales')).toBe('Move contract.pdf to Sales?');
  });

  // The fallback sentence, still said when the access change is not known.
  it("uses 's for a destination that does not end in s", () => {
    expect(moveSentence('contract.pdf', 'Old')).toBe(
      "Move contract.pdf to Old? Access to it will follow Old's rules from now on.",
    );
  });

  it("uses a bare ' for one that does", () => {
    expect(moveSentence('contract.pdf', 'Sales')).toBe(
      "Move contract.pdf to Sales? Access to it will follow Sales' rules from now on.",
    );
  });
});

describe('principalLabel', () => {
  it('leaves a malformed plugin token as written rather than inventing a name', () => {
    expect(principalLabel(plugin('plugin/GTM/delete'))).toBe('plugin/GTM/delete');
  });
});

const KB = 'knowledge-base';

/**
 * What the tree refuses before it asks, and what it no longer warns about.
 *
 * The refusal is the server's sentence, decided by the shared predicate, so
 * the sidebar cannot drift from the endpoint it would have called.
 */
describe('platformFileMoveRefusal', () => {
  it('refuses the four platform files where the platform reads them', () => {
    expect(platformFileMoveRefusal(`${KB}/access.md`, KB))
      .toBe('access.md is a platform file and stays in its folder.');
    expect(platformFileMoveRefusal(`${KB}/Sales/access.md`, KB))
      .toBe('access.md is a platform file and stays in its folder.');
    expect(platformFileMoveRefusal(`${KB}/Sales/.bevelignore`, KB))
      .toBe('.bevelignore is a platform file and stays in its folder.');
    expect(platformFileMoveRefusal(`${KB}/roles.yaml`, KB))
      .toBe('roles.yaml is a platform file and stays in its folder.');
    expect(platformFileMoveRefusal(`${KB}/AGENTS.md`, KB))
      .toBe('AGENTS.md is a platform file and stays in its folder.');
  });

  it('leaves content alone, including a nested roles.yaml or AGENTS.md the platform never reads', () => {
    expect(platformFileMoveRefusal(`${KB}/Sales/deal.md`, KB)).toBeNull();
    expect(platformFileMoveRefusal(`${KB}/Sales/roles.yaml`, KB)).toBeNull();
    expect(platformFileMoveRefusal(`${KB}/Sales/AGENTS.md`, KB)).toBeNull();
    // Exact spelling, as the platform reads it.
    expect(platformFileMoveRefusal(`${KB}/Sales/Access.md`, KB)).toBeNull();
  });

  /**
   * The tree's copy of the rule reads the layout the browser was served, so a
   * deployment that renamed its guide gets the same two answers here as it
   * does from the server: ours is managed, theirs is a page.
   */
  it('follows the configured guide name — and lets go of AGENTS.md when it differs', () => {
    configureKbLayout({ ...DEFAULT_KB_LAYOUT, agentsFile: 'HEXIS.md' });
    expect(platformFileMoveRefusal(`${KB}/HEXIS.md`, KB))
      .toBe('HEXIS.md is a platform file and stays in its folder.');
    // The customer's own conventions file moves, renames and deletes like any
    // page — which is the whole point of naming ours something else.
    expect(platformFileMoveRefusal(`${KB}/AGENTS.md`, KB)).toBeNull();
    expect(platformFileDragRefusal(`${KB}/AGENTS.md`, KB, false)).toBeNull();
    // Root-only, like `roles.yaml`: a nested copy of ours is content too.
    expect(platformFileMoveRefusal(`${KB}/Sales/HEXIS.md`, KB)).toBeNull();
  });

  it('refuses nothing outside the KB clone, or before the clone folder is known', () => {
    // No repo-relative form to judge — the server is the gate and says the
    // same sentence, so the tree stays quiet rather than guessing.
    expect(platformFileMoveRefusal(`${KB}/access.md`, null)).toBeNull();
    expect(platformFileMoveRefusal('scratch/access.md', KB)).toBeNull();
  });
});

describe('platformFileDragRefusal', () => {
  const sentence = (n: string) => `${n} is a platform file and stays in its folder.`;

  it('is the rename refusal for anyone who is not an admin', () => {
    for (const p of [`${KB}/access.md`, `${KB}/Sales/access.md`, `${KB}/Sales/.bevelignore`]) {
      expect(platformFileDragRefusal(p, KB, false)).toBe(platformFileMoveRefusal(p, KB));
    }
  });

  it('lets an admin drag a MISPLACED copy — the drag that puts one back', () => {
    expect(platformFileDragRefusal(`${KB}/Sales/access.md`, KB, true)).toBeNull();
    expect(platformFileDragRefusal(`${KB}/Sales/.bevelignore`, KB, true)).toBeNull();
  });

  it("never lets go of the root's own copy, which is the one a restore puts back", () => {
    expect(platformFileDragRefusal(`${KB}/access.md`, KB, true)).toBe(sentence('access.md'));
    expect(platformFileDragRefusal(`${KB}/roles.yaml`, KB, true)).toBe(sentence('roles.yaml'));
    expect(platformFileDragRefusal(`${KB}/.bevelignore`, KB, true)).toBe(sentence('.bevelignore'));
    expect(platformFileDragRefusal(`${KB}/AGENTS.md`, KB, true)).toBe(sentence('AGENTS.md'));
  });

  it('leaves ordinary content alone for either of them', () => {
    for (const admin of [true, false]) {
      expect(platformFileDragRefusal(`${KB}/Sales/deal.md`, KB, admin)).toBeNull();
      expect(platformFileDragRefusal(`${KB}/access.md`, null, admin)).toBeNull();
    }
  });
});

describe('moveWarnings', () => {
  it('no longer warns about a platform file — the move never reaches the dialog', () => {
    expect(
      moveWarnings({
        sourcePath: `${KB}/KnowledgeBase/Legal/access.md`,
        targetDir: `${KB}/KnowledgeBase/Sales`,
        destinationLabel: 'Sales',
        kbDirName: KB,
        canWrite: null,
      }),
    ).toEqual([]);
  });

  it('still says what it alone knows: a denied destination and a change of root', () => {
    expect(
      moveWarnings({
        sourcePath: `${KB}/KnowledgeBase/Legal/contract.pdf`,
        targetDir: `${KB}/Data`,
        destinationLabel: 'Data',
        kbDirName: KB,
        canWrite: false,
      }),
    ).toEqual([
      "You can't write to Data — the move will be refused.",
      'This moves it out of KnowledgeBase/ into Data/ — the two roots are handled differently.',
    ]);
  });

  it('does not predict a refusal for the one move a denied destination still takes', () => {
    // The admin's restore: a misplaced access.md into a folder that has none.
    // "The move will be refused" would be the wrong prediction — this is the
    // move the destination's rules are bypassed for.
    expect(
      moveWarnings({
        sourcePath: `${KB}/KnowledgeBase/Misplaced/access.md`,
        targetDir: `${KB}/KnowledgeBase/Legal`,
        destinationLabel: 'Legal',
        kbDirName: KB,
        canWrite: false,
        isAdmin: true,
      }),
    ).toEqual([
      "You can't write to Legal, but putting access.md back where the platform reads it is allowed for an Admin.",
    ]);
  });

  it('promises a non-admin nothing: the exception is not theirs to use', () => {
    // A nested `roles.yaml` is ordinary content, so anyone can drag one at
    // the root — and for anyone but an admin the destination's refusal is
    // exactly what happens.
    expect(
      moveWarnings({
        sourcePath: `${KB}/KnowledgeBase/Misplaced/roles.yaml`,
        targetDir: KB,
        destinationLabel: 'the top level',
        kbDirName: KB,
        canWrite: false,
        isAdmin: false,
      }),
    ).toEqual(["You can't write to the top level — the move will be refused."]);
  });
});
