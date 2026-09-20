import { describe, it, expect } from 'vitest';
import type { AccessPrincipalRef, PathPrincipals } from '../../../access/api';
import { accessChangeLines, moveQuestion, moveSentence, principalLabel } from '../treeConfirm';

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
