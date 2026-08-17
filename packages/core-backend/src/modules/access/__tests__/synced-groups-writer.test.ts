import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGroupsFile } from '../group-files.js';
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
    expect(joined).toContain("'Ops: West' skipped");
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
