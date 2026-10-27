import { describe, expect, it } from 'vitest';
import { holderChanges } from '../access-view.js';
import type { HolderList } from '../access-control.interface.js';

/**
 * `holderChanges`: who loses and who gains opening or editing a thing in a
 * move, from the holder lists `prospectiveHolders` answers. The case these
 * tests are built on is a team handing a folder to another team, in a
 * knowledge base everyone may read.
 */

const list = (principals: { name: string; kind: 'role' | 'group' | 'plugin' }[], users: { name: string; email: string }[] = []): HolderList => ({
  principals,
  roles: principals.map((p) => p.name),
  users,
});
const everyone = { name: 'everyone', kind: 'role' as const };
const support = { name: 'Support', kind: 'group' as const };
const operations = { name: 'Operations', kind: 'group' as const };

describe('holderChanges', () => {
  it('a folder handed to another team: the old team loses editing, the new one gains it, and everyone still reads', () => {
    const changes = holderChanges({
      before: { read: list([everyone, support]), write: list([support]) },
      after: { read: list([everyone, operations]), write: list([operations]) },
    });
    expect(changes).toEqual({
      lose: [{ kind: 'group', name: 'Support', verb: 'write' }],
      gain: [{ kind: 'group', name: 'Operations', verb: 'write' }],
    });
  });

  it('a page leaving a folder only a team may read: that team loses opening, and everyone gains it', () => {
    const changes = holderChanges({
      before: { read: list([support]), write: list([support]) },
      after: { read: list([everyone]), write: list([]) },
    });
    expect(changes.lose).toEqual([
      { kind: 'group', name: 'Support', verb: 'write' },
    ]);
    expect(changes.gain).toEqual([{ kind: 'role', name: 'everyone', verb: 'read' }]);
  });

  it('the same lists on both sides change nobody, whatever the spelling of a name', () => {
    expect(
      holderChanges({
        before: { read: list([everyone]), write: list([support], [{ name: 'Ana', email: 'Ana@X.io' }]) },
        after: { read: list([everyone]), write: list([{ name: 'support', kind: 'group' }], [{ name: '', email: 'ana@x.io' }]) },
      }),
    ).toEqual({ lose: [], gain: [] });
  });

  it('a group and a role sharing a name are two principals', () => {
    const changes = holderChanges({
      before: { read: list([everyone]), write: list([{ name: 'Support', kind: 'role' }]) },
      after: { read: list([everyone]), write: list([support]) },
    });
    expect(changes.lose).toEqual([{ kind: 'role', name: 'Support', verb: 'write' }]);
    expect(changes.gain).toEqual([{ kind: 'group', name: 'Support', verb: 'write' }]);
  });

  it('a person granted with no display name is named by their address', () => {
    const changes = holderChanges({
      before: { read: list([everyone]), write: list([]) },
      after: { read: list([everyone]), write: list([], [{ name: '', email: 'ops@x.io' }]) },
    });
    expect(changes.gain).toEqual([{ kind: 'person', name: 'ops@x.io', email: 'ops@x.io', verb: 'write' }]);
  });
});
