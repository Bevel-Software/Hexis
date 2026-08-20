import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGroupsFile } from '../../access-model/group-files.js';
import {
  SyncedGroupsWriter,
  renderSyncedGroupsYaml,
  type SyncedGroupMember,
  type SyncedGroupRecord,
} from '../synced-groups-writer.js';

function member(overrides: Partial<SyncedGroupMember> = {}): SyncedGroupMember {
  return {
    email: 'ada@x.io',
    active: true,
    ...overrides,
  };
}

function group(
  displayName: string,
  members: SyncedGroupMember[],
  externalId = `ext-${displayName}`,
): SyncedGroupRecord {
  return {
    externalId,
    displayName,
    members,
  };
}

describe('renderSyncedGroupsYaml', () => {
  it('renders deterministically: sorted groups, sorted emails, stable bytes', () => {
    const groups = [
      group('Sales', [member({ email: 'zoe@x.io' }), member({ email: 'bo@x.io' })]),
      group('Engineering', [member()]),
    ];
    const a = renderSyncedGroupsYaml(groups);
    const b = renderSyncedGroupsYaml([...groups].reverse());
    expect(a.text).toBe(b.text);
    expect(a.groupCount).toBe(2);
    // Engineering sorts before Sales; emails sort within a group.
    const engineeringAt = a.text.indexOf('Engineering:');
    const salesAt = a.text.indexOf('Sales:');
    expect(engineeringAt).toBeGreaterThan(-1);
    expect(engineeringAt).toBeLessThan(salesAt);
    expect(a.text.indexOf('bo@x.io')).toBeLessThan(a.text.indexOf('zoe@x.io'));
  });

  it('round-trips through the resolver-side parser', () => {
    const rendered = renderSyncedGroupsYaml([
      group('Engineering', [member(), member({ email: 'bo@x.io' })]),
      group('Empty Team', []),
    ]);
    const parsed = parseGroupsFile(rendered.text, 'synced-groups.yaml');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.warnings).toEqual([]);
      expect([...parsed.groups.keys()].sort()).toEqual(['empty team', 'engineering']);
      expect([...parsed.groups.get('engineering')!.emails].sort()).toEqual(['ada@x.io', 'bo@x.io']);
      expect(parsed.groups.get('empty team')!.emails.size).toBe(0);
    }
  });

  it('excludes inactive and email-less members, with a warning', () => {
    const rendered = renderSyncedGroupsYaml([
      group('Engineering', [
        member(),
        member({ email: 'gone@x.io', active: false }),
        member({ email: null }),
      ]),
    ]);
    expect(rendered.text).toContain('ada@x.io');
    expect(rendered.text).not.toContain('gone@x.io');
    expect(rendered.warnings.join(' ')).toContain('2 members not materialized');
  });

  it('refuses malformed emails from the directory (YAML corruption / injection)', () => {
    const rendered = renderSyncedGroupsYaml([
      group('Engineering', [
        member(),
        // A newline-bearing "email" would smuggle extra member lines into the file.
        member({ email: 'evil@x.io\n    - attacker@evil.io' }),
        member({ email: 'not an email' }),
        // Passes the shape regex but would read back as a YAML comment.
        member({ email: '#tag@x.io' }),
        member({ email: '  ADA@X.IO  ' }), // canonicalized, deduped with ada@x.io
      ]),
    ]);
    expect(rendered.text).toContain('ada@x.io');
    expect(rendered.text).not.toContain('attacker@evil.io');
    expect(rendered.text).not.toContain('not an email');
    expect(rendered.text).not.toContain('#tag');
    expect(rendered.text.match(/ada@x\.io/g)).toHaveLength(1);
    expect(rendered.warnings.join(' ')).toContain('malformed email');
  });

  it("refuses the reserved 'group:' prefix as a member email (the read side skips it as a ref token)", () => {
    const rendered = renderSyncedGroupsYaml([
      group('Engineering', [member(), member({ email: 'group:lee@x.io' })]),
    ]);
    expect(rendered.text).toContain('ada@x.io');
    expect(rendered.text).not.toContain('group:lee@x.io');
    expect(rendered.warnings.join(' ')).toContain('malformed email');
    // The emitted file round-trips warning-free through the parser.
    const parsed = parseGroupsFile(rendered.text, 'synced-groups.yaml');
    expect(parsed.ok && parsed.warnings).toEqual([]);
  });

  it('renders IdP names ESCAPED into warnings — control characters never reach the log verbatim', () => {
    const rendered = renderSyncedGroupsYaml([
      group('Evil\u001b[31mTeam\nFAKE LOG LINE', [member()]),
    ]);
    expect(rendered.groupCount).toBe(0);
    expect(rendered.warnings).toHaveLength(1);
    // The raw control chars must not appear; their JSON escapes must.
    expect(rendered.warnings[0]).not.toContain('\n');
    expect(rendered.warnings[0]).not.toContain('\u001b');
    expect(rendered.warnings[0]).toContain('\\n');
    expect(rendered.warnings[0]).toContain('\\u001b');
  });

  it('also escapes C1 controls and U+2028/U+2029 — the ranges JSON.stringify leaves raw', () => {
    // JSON.stringify only escapes C0 (U+0000–U+001F): the one-byte CSI
    // U+009B starts an ANSI sequence on its own, DEL (U+007F) is a control
    // too, and U+2028/U+2029 are line breaks to JS consumers — all four
    // would otherwise reach the log stream verbatim.
    const raw = { csi: '\u009B', del: '\u007F', ls: '\u2028', ps: '\u2029' };
    // C1/2028/2029 do NOT make a name unsafe (only C0 does), so the group
    // is emitted — the name reaches the log through a MEMBER warning.
    const rendered = renderSyncedGroupsYaml([
      group(`Csi${raw.csi}31mTeam${raw.del}${raw.ls}${raw.ps}FAKE`, [member({ active: false })]),
    ]);
    expect(rendered.groupCount).toBe(1);
    expect(rendered.warnings).toHaveLength(1);
    const warning = rendered.warnings[0];
    for (const c of Object.values(raw)) {
      expect(warning).not.toContain(c);
    }
    expect(warning).toContain('\\u009b');
    expect(warning).toContain('\\u007f');
    expect(warning).toContain('\\u2028');
    expect(warning).toContain('\\u2029');
  });

  it('full-key duplicate tie-break is collision-proof (JSON member key, not a delimiter join)', () => {
    // Crafted so the OLD delimiter-joined keys collide: one malformed "email"
    // containing the join delimiters serializes identically to two real
    // members. A collision pushed the tie onto input order — the two renders
    // below would then disagree on which duplicate wins first-wins dedup.
    const a = group('Team', [member({ email: 'a@x.io:true,b@x.io' })], 'ext-1');
    const b = group('Team', [member({ email: 'a@x.io' }), member({ email: 'b@x.io' })], 'ext-1');
    const forward = renderSyncedGroupsYaml([a, b]);
    const reversed = renderSyncedGroupsYaml([b, a]);
    expect(forward.text).toBe(reversed.text);
  });

  it('sorts by code units, not locale (byte-stable across deployments)', () => {
    // localeCompare in most locales collates 'é' before 'z'; code units put
    // 'z' (0x7a) before 'é' (0xe9). Pin the code-unit order so the rendered
    // bytes never depend on the process's ambient locale/ICU build.
    const rendered = renderSyncedGroupsYaml([
      group('équipe', [member()]),
      group('z team', [member()]),
    ]);
    const z = rendered.text.indexOf('z team:');
    const e = rendered.text.indexOf('équipe:');
    expect(z).toBeGreaterThan(-1);
    expect(z).toBeLessThan(e);
  });

  it('skips YAML-unsafe, reserved, and name-colliding groups (fail-closed)', () => {
    const rendered = renderSyncedGroupsYaml([
      group('Ops: West', [member()]),
      group('everyone', [member()]),
      group('Engineering', [member()], 'ext-a'),
      group('engineering', [member({ email: 'bo@x.io' })], 'ext-b'),
    ]);
    expect(rendered.groupCount).toBe(1);
    expect(rendered.text).not.toContain('Ops: West');
    expect(rendered.text).not.toContain('everyone');
    const joined = rendered.warnings.join('\n');
    expect(joined).toContain('"Ops: West" skipped');
    expect(joined).toContain('reserved');
    expect(joined).toContain('collides');
  });
});

describe('SyncedGroupsWriter', () => {
  const GROUPS = [group('Engineering', [member()])];

  function makeWriter(overrides: { current?: string | null; debounceMs?: number } = {}) {
    const persisted: string[] = [];
    const written: unknown[] = [];
    let current = overrides.current ?? null;
    const writer = new SyncedGroupsWriter({
      source: { listGroups: async () => GROUPS },
      readCurrent: async () => current,
      persist: async (content) => {
        persisted.push(content);
        current = content;
      },
      onWritten: (result) => written.push(result),
      debounceMs: overrides.debounceMs ?? 50,
    });
    return { writer, persisted, written };
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writeNow persists changed content and fires onWritten', async () => {
    const { writer, persisted, written } = makeWriter();
    const result = await writer.writeNow();
    expect(result.changed).toBe(true);
    expect(result.groupCount).toBe(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toContain('Engineering:');
    expect(written).toHaveLength(1);
  });

  it('is a no-op (no commit, no events) when the content is unchanged', async () => {
    const { writer, persisted, written } = makeWriter({
      current: renderSyncedGroupsYaml(GROUPS).text,
    });
    const result = await writer.writeNow();
    expect(result.changed).toBe(false);
    expect(persisted).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it('debounces a burst of mutations into one write', async () => {
    const { writer, persisted } = makeWriter({ debounceMs: 50 });
    writer.notifyMutation();
    await vi.advanceTimersByTimeAsync(30);
    writer.notifyMutation(); // burst continues → timer re-arms
    await vi.advanceTimersByTimeAsync(30);
    expect(persisted).toHaveLength(0); // still inside the burst window
    writer.notifyMutation();
    await vi.advanceTimersByTimeAsync(60); // burst goes quiet → fire once
    expect(persisted).toHaveLength(1);
  });

  it('dispose cancels a pending debounce', async () => {
    const { writer, persisted } = makeWriter({ debounceMs: 50 });
    writer.notifyMutation();
    writer.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(persisted).toHaveLength(0);
  });
});
