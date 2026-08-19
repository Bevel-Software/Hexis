import { describe, it, expect } from 'vitest';

import {
  spliceGrant,
  spliceRevoke,
  validatePrincipal,
  AccessSpliceError,
  type Principal,
} from '../access-splice.js';
import { parseAccessEntry, canonicalEmail } from '../access-grammar.js';

const felix: Principal = { kind: 'user', email: 'felix.kissel@example.com', displayName: 'Felix' };
const juan: Principal = { kind: 'user', email: 'juan@bevel.software', displayName: 'Juan V' };
const productTeam: Principal = { kind: 'role', role: 'Product Team' };

/** A realistic access.md with a prose body + comment — the thing parse→emit destroys. */
const ROOT_ACCESS_MD = `---
write:
  - Admin
# download is independent of write
download:
  - Juan <juan@bevel.software>
owner: []
---

# Repository access

This file is the root of the access-control tree. It grants write access only
to the \`Admin\` role by default. Subfolders can broaden access.

See \`lib/access-control.js\` for the resolution semantics.
`;

describe('spliceGrant — body + comment preservation (keystone)', () => {
  it('keeps the markdown body, comments, and key order byte-for-byte', () => {
    const r = spliceGrant(ROOT_ACCESS_MD, 'write', felix);
    expect(r.changed).toBe(true);
    // The body prose must survive verbatim.
    expect(r.text).toContain('# Repository access');
    expect(r.text).toContain('See `lib/access-control.js` for the resolution semantics.');
    // The comment must survive.
    expect(r.text).toContain('# download is independent of write');
    // Existing entries untouched, new one appended under write.
    expect(r.text).toContain('  - Admin');
    expect(r.text).toContain('  - Felix <felix.kissel@example.com>');
    // owner stays empty-list.
    expect(r.text).toContain('owner: []');
    // Felix lands under write, immediately after Admin, before the comment.
    const lines = r.text.split('\n');
    const adminIdx = lines.indexOf('  - Admin');
    const felixIdx = lines.indexOf('  - Felix <felix.kissel@example.com>');
    const commentIdx = lines.indexOf('# download is independent of write');
    expect(adminIdx).toBeGreaterThan(-1);
    expect(felixIdx).toBe(adminIdx + 1);
    expect(commentIdx).toBeGreaterThan(felixIdx);
  });

  it('grant then revoke returns to a body-preserving state', () => {
    const granted = spliceGrant(ROOT_ACCESS_MD, 'write', felix).text;
    const revoked = spliceRevoke(granted, 'write', felix).text;
    expect(revoked).toContain('# Repository access');
    expect(revoked).toContain('  - Admin');
    expect(revoked).not.toContain('Felix');
  });
});

describe('spliceGrant — idempotency + creation', () => {
  it('is a no-op when the principal already has the grant', () => {
    const once = spliceGrant(ROOT_ACCESS_MD, 'write', felix).text;
    const twice = spliceGrant(once, 'write', felix);
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once);
  });

  it('creates the verb key when absent', () => {
    const r = spliceGrant(ROOT_ACCESS_MD, 'read', productTeam);
    expect(r.changed).toBe(true);
    expect(r.text).toContain('read:');
    expect(r.text).toContain('  - Product Team');
    expect(r.text).toContain('# Repository access'); // body still there
  });

  it('promotes an inline-empty `owner: []` to a block list', () => {
    const r = spliceGrant(ROOT_ACCESS_MD, 'owner', juan);
    expect(r.changed).toBe(true);
    expect(r.text).toContain('owner:\n  - Juan V <juan@bevel.software>');
    expect(r.text).not.toContain('owner: []');
  });

  it('synthesises frontmatter for a fresh (frontmatter-less) file', () => {
    const r = spliceGrant('', 'write', felix);
    expect(r.changed).toBe(true);
    expect(r.text.startsWith('---\n')).toBe(true);
    expect(r.text).toContain('write:\n  - Felix <felix.kissel@example.com>');
  });
});

describe('spliceRevoke', () => {
  it('removes one entry and collapses the verb to [] when it empties', () => {
    const r = spliceRevoke(ROOT_ACCESS_MD, 'write', { kind: 'role', role: 'Admin' });
    expect(r.changed).toBe(true);
    expect(r.text).toContain('write: []');
    expect(r.text).not.toMatch(/- Admin/);
    expect(r.text).toContain('# Repository access');
  });

  it('is a no-op when the principal is not present', () => {
    const r = spliceRevoke(ROOT_ACCESS_MD, 'write', felix);
    expect(r.changed).toBe(false);
    expect(r.text).toBe(ROOT_ACCESS_MD);
  });
});

describe('spliceGrant — verbs are independent (a principal may hold several)', () => {
  it('grants a second verb without removing the principal from the first', () => {
    // Verbs do not nest: granting `download` on top of `write` leaves BOTH.
    const granted = spliceGrant(ROOT_ACCESS_MD, 'write', felix).text;
    const both = spliceGrant(granted, 'download', felix).text;
    const writeBlock = both.slice(both.indexOf('write:'), both.indexOf('download:'));
    expect(writeBlock).toContain('Felix'); // still under write
    expect(both).toContain('download:'); // and now under download too
    const downloadBlock = both.slice(both.indexOf('download:'));
    expect(downloadBlock).toContain('Felix');
  });

  it('is idempotent for an already-granted verb', () => {
    const granted = spliceGrant(ROOT_ACCESS_MD, 'owner', felix).text;
    const again = spliceGrant(granted, 'owner', felix);
    expect(again.changed).toBe(false);
  });
});

describe('spliceGrant({ deny }) — the deny-here per-item override', () => {
  it('adds a `deny <principal>` line to an existing block list', () => {
    // `write:` already lists Admin; deny Felix there.
    const r = spliceGrant(ROOT_ACCESS_MD, 'write', felix, { deny: true });
    expect(r.changed).toBe(true);
    const writeBlock = r.text.slice(r.text.indexOf('write:'), r.text.indexOf('download:'));
    expect(writeBlock).toContain('- deny Felix <felix.kissel@example.com>');
    expect(writeBlock).toContain('- Admin'); // existing grant untouched
    // The denial parses back as a deny entry.
    const entry = parseAccessEntry('deny Felix <felix.kissel@example.com>');
    expect(entry.ok && entry.entry.deny).toBe(true);
  });

  it('promotes a node-frontmatter scalar to a block list with the deny entry', () => {
    // A node whose own frontmatter names a sole owner via the scalar form.
    const node = `---\nnodeType: process\nowner: Juan V <juan@bevel.software>\n---\n# Body\n`;
    const r = spliceGrant(node, 'owner', felix, { deny: true, allowScalar: true });
    expect(r.changed).toBe(true);
    expect(r.text).toContain('owner:');
    expect(r.text).toContain('- Juan V <juan@bevel.software>'); // old scalar preserved
    expect(r.text).toContain('- deny Felix <felix.kissel@example.com>'); // deny added
    expect(r.text).toContain('# Body'); // body survives
  });

  it('fills an inline-empty `owner: []` with the deny entry', () => {
    const r = spliceGrant(ROOT_ACCESS_MD, 'owner', felix, { deny: true });
    expect(r.changed).toBe(true);
    const ownerBlock = r.text.slice(r.text.indexOf('owner:'));
    expect(ownerBlock).toContain('- deny Felix <felix.kissel@example.com>');
    expect(ownerBlock).not.toContain('owner: []'); // the [] collapsed to a real list
  });

  it('is a no-op when the same deny entry already exists', () => {
    const once = spliceGrant(ROOT_ACCESS_MD, 'write', felix, { deny: true }).text;
    const twice = spliceGrant(once, 'write', felix, { deny: true });
    expect(twice.changed).toBe(false);
    expect(twice.text).toBe(once);
  });

  it('a deny and a grant for the same principal are independent (deny does not no-op a grant)', () => {
    // An existing grant must NOT make the deny idempotent, and vice-versa —
    // the idempotency key includes deny-ness. (The resolver-level grant-beats-
    // deny interaction is handled one layer up in AccessMutationService.)
    const granted = spliceGrant(ROOT_ACCESS_MD, 'write', felix).text;
    const denied = spliceGrant(granted, 'write', felix, { deny: true });
    expect(denied.changed).toBe(true);
    const writeBlock = denied.text.slice(denied.text.indexOf('write:'), denied.text.indexOf('download:'));
    expect(writeBlock).toContain('- Felix <felix.kissel@example.com>');
    expect(writeBlock).toContain('- deny Felix <felix.kissel@example.com>');
  });
});

describe('validatePrincipal — injection guard', () => {
  it('rejects a newline-bearing email (frontmatter injection)', () => {
    expect(() =>
      validatePrincipal({
        kind: 'user',
        email: 'x@y.com\nwrite:\n  - everyone',
        displayName: 'X',
      }),
    ).toThrow(AccessSpliceError);
  });

  it('rejects a display name containing angle brackets', () => {
    expect(() =>
      validatePrincipal({ kind: 'user', email: 'a@b.com', displayName: 'Bad <hack>' }),
    ).toThrow(AccessSpliceError);
  });

  it.each([['\n'], ['\r'], ['\r\n'], [' '], ['']])(
    'rejects a display name carrying the control char %j (frontmatter injection)',
    (ch) => {
      expect(() =>
        validatePrincipal({
          kind: 'user',
          email: 'a@b.com',
          // Interior, so `trim()` cannot quietly rescue it on the way through.
          displayName: `Ali${ch}read:${ch}  - everyone`,
        }),
      ).toThrow(AccessSpliceError);
    },
  );

  it('trims a SURROUNDING newline rather than rejecting, and renders the trimmed name', () => {
    // The guard runs on the trimmed name and the trimmed name is what gets
    // returned — so a stray edge newline can never reach a rendered line.
    const p = validatePrincipal({ kind: 'user', email: 'a@b.com', displayName: '\n Ali \n' });
    expect(p.kind === 'user' && p.displayName).toBe('Ali');
  });

  it('rejects a plugin name with a colon (would forge a key)', () => {
    expect(() => validatePrincipal({ kind: 'role', role: 'write:\n  - everyone' })).toThrow(
      AccessSpliceError,
    );
  });

  it('rejects the reserved plugin name deny', () => {
    expect(() => validatePrincipal({ kind: 'role', role: 'deny' })).toThrow(AccessSpliceError);
  });

  it('accepts the built-in everyone role (grantable as public read; route gates the verb)', () => {
    expect(validatePrincipal({ kind: 'role', role: 'everyone' })).toEqual({
      kind: 'role',
      role: 'everyone',
    });
  });

  it('rejects `#` in a name (uncomment() would truncate it on read-back)', () => {
    expect(() =>
      validatePrincipal({ kind: 'user', email: 'a@b.com', displayName: 'Felix #1' }),
    ).toThrow(AccessSpliceError);
    expect(() => validatePrincipal({ kind: 'role', role: 'Team #1' })).toThrow(AccessSpliceError);
  });

  it('canonicalises a valid principal (lowercased email)', () => {
    const p = validatePrincipal({ kind: 'user', email: 'Felix@Example.COM', displayName: 'Felix' });
    expect(p.kind === 'user' && p.email).toBe('felix@example.com');
  });
});

describe('round-trip — every granted entry parses back', () => {
  it('a granted person renders to a line parseAccessEntry accepts', () => {
    const r = spliceGrant(ROOT_ACCESS_MD, 'write', felix);
    const line = r.text
      .split('\n')
      .find((l) => l.trim().startsWith('- Felix'))!
      .trim()
      .slice(2)
      .trim();
    const parsed = parseAccessEntry(line);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.entry.kind === 'user' && parsed.entry.email).toBe(
      canonicalEmail(felix.kind === 'user' ? felix.email : ''),
    );
  });
});

describe('token-kind family — exact-token grants, shadow-aware revokes', () => {
  // One name, two spellings, two possible principals: the bare token is the
  // GROUP's whenever a group shadows the name (group-first precedence), the
  // `role/` token is always the ROLE's. Grants must be exact-token idempotent;
  // revokes are alias-tolerant ONLY when unshadowed (the caller passes
  // tokenMatch: 'exact' when a group owns the bare name).
  const SHARED = `---
write:
  - role/Sales
  - Sales
  - Admin
---
`;

  it("GRANT is exact-token: a bare GROUP grant goes through even when role/<Name> is present", () => {
    const md = '---\nwrite:\n  - role/Sales\n---\n';
    const r = spliceGrant(md, 'write', { kind: 'role', role: 'Sales' });
    expect(r.changed).toBe(true); // NOT swallowed as already-granted
    expect(r.text).toContain('  - role/Sales');
    expect(r.text).toContain('  - Sales');
  });

  it('GRANT is exact-token: a role/<Name> grant goes through even when the bare token is present', () => {
    const md = '---\nwrite:\n  - Sales\n---\n';
    const r = spliceGrant(md, 'write', { kind: 'role', role: 'role/Sales' });
    expect(r.changed).toBe(true);
    expect(r.text).toContain('  - Sales');
    expect(r.text).toContain('  - role/Sales');
  });

  it('GRANT stays idempotent for the SAME spelling (both spellings)', () => {
    expect(spliceGrant(SHARED, 'write', { kind: 'role', role: 'Sales' }).changed).toBe(false);
    expect(spliceGrant(SHARED, 'write', { kind: 'role', role: 'role/Sales' }).changed).toBe(false);
  });

  it("REVOKE unshadowed (default 'name'): revoking the role strips BOTH spellings (legacy cleanup)", () => {
    const r = spliceRevoke(SHARED, 'write', { kind: 'role', role: 'role/Sales' });
    expect(r.changed).toBe(true);
    expect(r.text).not.toContain('Sales');
    expect(r.text).toContain('  - Admin');
  });

  it("REVOKE shadowed ('exact'): revoking the ROLE leaves the group's bare token", () => {
    const r = spliceRevoke(SHARED, 'write', { kind: 'role', role: 'role/Sales' }, { tokenMatch: 'exact' });
    expect(r.changed).toBe(true);
    expect(r.text).not.toContain('role/Sales');
    expect(r.text).toContain('  - Sales'); // the GROUP's grant survives
    expect(r.text).toContain('  - Admin');
  });

  it("REVOKE shadowed ('exact'): revoking the GROUP (bare) leaves the role's explicit token", () => {
    const r = spliceRevoke(SHARED, 'write', { kind: 'role', role: 'Sales' }, { tokenMatch: 'exact' });
    expect(r.changed).toBe(true);
    expect(r.text).toContain('  - role/Sales'); // the ROLE's grant survives
    const lines = r.text.split('\n');
    expect(lines).not.toContain('  - Sales');
  });

  it("REVOKE unshadowed bare principal (group since vanished): 'name' matching strips both spellings", () => {
    const r = spliceRevoke(SHARED, 'write', { kind: 'role', role: 'Sales' });
    expect(r.changed).toBe(true);
    expect(r.text).not.toContain('Sales'); // bare token falls back to the role — same principal
  });
});
