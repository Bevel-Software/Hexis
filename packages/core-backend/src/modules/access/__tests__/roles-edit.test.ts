import { describe, it, expect } from 'vitest';

import {
  parseRolesModel,
  emitRolesModel,
  deleteRole,
  addMember,
  removeMember,
  removeGroupRefsEverywhere,
  renameGroupRefs,
  RolesEditError,
} from '../roles-edit.js';
import { parseYamlSubset } from '../access-control.service.js';

const BASE = `roles:
  Admin:
    - razvan@bevel.software
    - juan@bevel.software
  Product Team:
    - felix@example.com
  Empty Role: []
`;

describe('roles-edit: parse + emit', () => {
  it('parses roles in order with de-duplicated members', () => {
    const model = parseRolesModel(`roles:\n  A:\n    - x@a.eu\n    - X@a.eu\n    - y@a.eu\n`);
    expect(model).toEqual([{ displayName: 'A', members: ['x@a.eu', 'y@a.eu'] }]);
  });

  it('treats an empty file as no roles', () => {
    expect(parseRolesModel('')).toEqual([]);
    expect(parseRolesModel('   \n')).toEqual([]);
  });

  it('reads both `[]` and a bare key as an empty role', () => {
    expect(parseRolesModel('roles:\n  A: []\n')).toEqual([{ displayName: 'A', members: [] }]);
    expect(parseRolesModel('roles:\n  A:\n')).toEqual([{ displayName: 'A', members: [] }]);
  });

  it('rejects a malformed role value instead of coercing it (CodeRabbit)', () => {
    // A scalar role value is malformed — must throw, not become an empty role.
    expect(() => parseRolesModel('roles:\n  A: somebody@x.eu\n')).toThrow(RolesEditError);
  });

  it('emits an empty role as `Name: []` (the only round-trippable empty form)', () => {
    const text = emitRolesModel([{ displayName: 'Empty', members: [] }]);
    expect(text).toContain('Empty: []');
    // The bare form would parse to null and fail the list check — assert we never emit it.
    expect(text).not.toMatch(/Empty:\s*\n/);
    expect(parseRolesModel(text)).toEqual([{ displayName: 'Empty', members: [] }]);
  });

  it('re-emit is idempotent (canonical model in → byte-identical out)', () => {
    const once = emitRolesModel(parseRolesModel(BASE));
    const twice = emitRolesModel(parseRolesModel(once));
    expect(twice).toBe(once);
  });

  it('emits valid YAML the resolver subset parser reads back', () => {
    const text = emitRolesModel(parseRolesModel(BASE));
    const parsed = parseYamlSubset(text);
    expect(parsed.ok).toBe(true);
  });
});

describe('roles-edit: mutations', () => {
  it('addMember is idempotent (no-op when already a member)', () => {
    const r = addMember(BASE, 'admin', 'JUAN@bevel.software');
    expect(r.changed).toBe(false);
  });

  it('addMember appends a new canonicalised member', () => {
    const r = addMember(BASE, 'product team', 'New@example.com');
    expect(r.changed).toBe(true);
    expect(parseRolesModel(r.text).find((x) => x.displayName === 'Product Team')!.members).toContain('new@example.com');
  });

  it('addMember rejects a malformed email before any write', () => {
    expect(() => addMember(BASE, 'admin', 'not-an-email')).toThrow(RolesEditError);
  });

  it('removeMember removes only the target; no-op if absent', () => {
    const r = removeMember(BASE, 'admin', 'juan@bevel.software');
    expect(r.changed).toBe(true);
    expect(parseRolesModel(r.text).find((x) => x.displayName === 'Admin')!.members).toEqual(['razvan@bevel.software']);
    expect(removeMember(BASE, 'admin', 'ghost@x.eu').changed).toBe(false);
  });

  it("addMember rejects a 'group:'-prefixed value with an actionable message", () => {
    // 'group:lee@x.io' passes the email regex — without the guard it would
    // land a dead group ref the resolver reads as an unknown group.
    expect(() => addMember(BASE, 'admin', 'group:lee@x.io')).toThrow(/group assignment/);
    expect(() => addMember(BASE, 'admin', 'group:gtm team')).toThrow(RolesEditError);
  });

  it('deleteRole removes the role; 404 when absent', () => {
    const r = deleteRole(BASE, 'product team');
    expect(parseRolesModel(r.text).some((x) => x.displayName === 'Product Team')).toBe(false);
    expect(() => deleteRole(BASE, 'ghost')).toThrow(/not found/);
  });

  it('removeGroupRefsEverywhere strips every ref to the group across roles', () => {
    const text = [
      'roles:',
      '  Admin:',
      '    - razvan@bevel.software',
      '  Product Team:',
      '    - felix@example.com',
      '    - group:gtm team',
      '  Ops:',
      '    - group:GTM  Team', // un-normalized hand edit — canonical matching must catch it
      '',
    ].join('\n');
    const r = removeGroupRefsEverywhere(text, 'gtm team');
    expect(r.changed).toBe(true);
    expect(r.text).not.toContain('gtm');
    const model = parseRolesModel(r.text);
    expect(model.find((x) => x.displayName === 'Product Team')?.members).toEqual(['felix@example.com']);
    expect(model.find((x) => x.displayName === 'Ops')?.members).toEqual([]);
    expect(removeGroupRefsEverywhere(BASE, 'gtm team').changed).toBe(false);
  });

  it('renameGroupRefs: rewrites group:<ref> members across roles, deduping an existing target', () => {
    const text = [
      'roles:',
      '  Admin:',
      '    - razvan@bevel.software',
      '  Product Team:',
      '    - felix@example.com',
      '    - group:gtm team',
      '  Ops:',
      '    - group:gtm team',
      '    - group:go to market', // target already present → dedupe, not duplicate
      '',
    ].join('\n');
    const r = renameGroupRefs(text, 'gtm team', 'go to market');
    expect(r.changed).toBe(true);
    expect(r.text).not.toContain('group:gtm team');
    const model = parseRolesModel(r.text);
    expect(model.find((x) => x.displayName === 'Product Team')?.members).toContain('group:go to market');
    expect(
      model.find((x) => x.displayName === 'Ops')?.members.filter((m) => m === 'group:go to market'),
    ).toHaveLength(1);
    // Untouched role stays untouched.
    expect(model.find((x) => x.displayName === 'Admin')?.members).toEqual(['razvan@bevel.software']);
  });

  it('renameGroupRefs: no-op when nothing references the old name', () => {
    const r = renameGroupRefs(BASE, 'gtm team', 'go to market');
    expect(r.changed).toBe(false);
  });

  it('renameGroupRefs rewrites EVERY matching ref in a role, collapsing to one', () => {
    // Two differently-formatted refs to the same group: both must follow the
    // rename (a straggler would point at the renamed-away name forever), and
    // only one ref to the new name survives.
    const text = 'roles:\n  Ops:\n    - group:gtm team\n    - group:gtm  team\n';
    const r = renameGroupRefs(text, 'gtm team', 'go to market');
    expect(r.changed).toBe(true);
    const ops = parseRolesModel(r.text).find((x) => x.displayName === 'Ops')!;
    expect(ops.members.filter((m) => m === 'group:go to market')).toHaveLength(1);
    expect(ops.members.some((m) => m.includes('gtm'))).toBe(false);
  });

  it('group-ref matching is canonical: an un-normalized hand-written ref still matches', () => {
    // The resolver canonicalizes the ref's suffix (collapsing runs of
    // spaces), so a hand-written `group:gtm  team` grants — the editors must
    // find it too, or unassign/rename no-op while the roster still shows the
    // group. (Parse lowercases members but keeps the double space.)
    const text = 'roles:\n  Ops:\n    - group:GTM  Team\n';
    const removed = removeMember(text, 'ops', 'nobody@x.io'); // sanity: parse keeps the un-collapsed ref
    expect(removed.text).toContain('group:gtm  team');
    const renamed = renameGroupRefs(text, 'gtm team', 'go to market');
    expect(renamed.changed).toBe(true);
    expect(renamed.text).toContain('group:go to market');
    expect(renamed.text).not.toContain('gtm  team');
  });

  it('only the changed role moves in the diff (other roles untouched)', () => {
    const before = emitRolesModel(parseRolesModel(BASE));
    const after = addMember(before, 'product team', 'z@example.com').text;
    const beforeLines = before.split('\n');
    const afterLines = after.split('\n');
    // Admin block is identical; only Product Team grew by one line.
    expect(afterLines.filter((l) => l.includes('razvan@bevel.software'))).toEqual(
      beforeLines.filter((l) => l.includes('razvan@bevel.software')),
    );
    expect(afterLines.length).toBe(beforeLines.length + 1);
  });
});
