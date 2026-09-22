import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type { LibraryData } from '../hooks/useLibraryData';
import type { LibrarySkillSummary } from '../services/library.api';

/**
 * What the catalog payload becomes — specifically, what it does NOT become.
 *
 * This is the reachable layer for the lifecycle removal. A `SKILL.md` may
 * still declare `metadata.lifecycle`/`metadata.owner` and an older server may
 * still put them on the wire; the acceptance criterion is that neither key
 * reaches a `LibraryItem`. Pinned HERE rather than on a component, because
 * once the mapper drops the keys no downstream card, picker or panel can
 * badge or filter on them — there is nothing left to read.
 */
const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));
vi.mock('../services/plugins.api', () => ({ listPlugins: vi.fn().mockResolvedValue([]) }));
vi.mock('../services/teams.api', () => ({ listTeams: vi.fn().mockResolvedValue([]) }));

import { LibraryProvider, useLibrary, type LibraryItem } from '../state/library-data';

function catalog(skills: LibrarySkillSummary[]): LibraryData {
  return {
    loading: false,
    error: null,
    skills,
    pendingSkills: [],
    pendingTools: [],
    tools: [],
    ownedSkills: new Set(),
    writableSkills: new Set(),
    ownedTools: new Set(),
    allowedToolsBySkill: new Map(),
    crs: [],
    myCrNumbers: new Set(),
    reload: vi.fn(),
  };
}

/** Reads the mapped items back out of the provider. */
function Probe({ seen }: { seen: LibraryItem[][] }) {
  seen.push(useLibrary().items);
  return null;
}

async function itemsFor(skills: LibrarySkillSummary[]): Promise<LibraryItem[]> {
  dataMock.useLibraryData.mockReturnValue(catalog(skills));
  const seen: LibraryItem[][] = [];
  render(
    <LibraryProvider>
      <Probe seen={seen} />
    </LibraryProvider>,
  );
  await act(async () => undefined);
  return seen[seen.length - 1];
}

describe('LibraryProvider item mapping', () => {
  it('drops the governance keys an older server still sends', async () => {
    // The cast is the case under test: `lifecycle`/`owner` are gone from
    // `LibrarySkillSummary`, so the only way they arrive is from a server
    // this frontend no longer agrees with — a deployment mid-upgrade, or a
    // SKILL.md whose frontmatter still declares them.
    const legacy = {
      name: 'legacy-pitch',
      description: 'Old but readable.',
      version: '2.1.0',
      path: 'Skills/Sales/legacy-pitch',
      plugins: [],
      lifecycle: 'retired',
      owner: 'gtm-team',
    } as LibrarySkillSummary;

    const [item] = await itemsFor([legacy]);

    // The skill is present and complete — the removal drops the two keys,
    // not the skill and not the metadata that stayed.
    expect(item.name).toBe('legacy-pitch');
    expect(item.version).toBe('2.1.0');
    expect(item.path).toBe('Skills/Sales/legacy-pitch');

    // `in`, not a truthiness check: the point is the key is absent from the
    // item, not merely that it reads as undefined.
    expect('lifecycle' in item).toBe(false);
    expect('owner' in item).toBe(false);
  });

  it('keeps a lifecycle-less skill indistinguishable from the legacy one', async () => {
    // Both shapes map to the same item, which is the whole claim: the
    // platform has no opinion left to form about a skill's lifecycle.
    const [legacy] = await itemsFor([
      { name: 'x', description: 'd', path: 'Skills/x', plugins: [], lifecycle: 'retired' } as LibrarySkillSummary,
    ]);
    const [plain] = await itemsFor([{ name: 'x', description: 'd', path: 'Skills/x', plugins: [] }]);
    expect(legacy).toEqual(plain);
  });
});
