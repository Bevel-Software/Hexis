import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ getSkill: vi.fn(), getSkillFile: vi.fn() }));
vi.mock('../services/library.api', () => ({
  getSkill: api.getSkill,
  getSkillFile: api.getSkillFile,
}));

import { useSkillDetail } from '../hooks/useSkillDetail';

const skill = {
  name: 'newsletter',
  description: 'Drafts the Friday newsletter.',
  path: 'Skills/newsletter',
  body: 'before',
  allowedTools: [],
  files: ['Skills/newsletter/sources.yaml'],
};

beforeEach(() => {
  api.getSkill.mockReset().mockResolvedValue(skill);
  api.getSkillFile.mockReset().mockResolvedValue('sources: before');
});

describe('useSkillDetail', () => {
  /**
   * A bundled-file read started before a reload resolves AFTER it, carrying the
   * file as it read before the merge. Letting that land would poison the map
   * the reload just cleared — and the `contents[relFile]` guard would then
   * treat the file as fetched and never ask again, so the stale tab stays
   * stale for as long as the page is open.
   */
  it('drops a bundled-file read that a reload has overtaken', async () => {
    let releaseStale!: (v: string) => void;
    api.getSkillFile.mockImplementationOnce(
      () =>
        new Promise<string>((res) => {
          releaseStale = res;
        }),
    );

    const { result } = renderHook(() => useSkillDetail('newsletter'));
    await waitFor(() => expect(result.current.skill).not.toBeNull());

    act(() => result.current.loadFile('sources.yaml'));
    expect(api.getSkillFile).toHaveBeenCalledTimes(1);

    // The merge lands; the first read is still in flight.
    api.getSkill.mockResolvedValue({ ...skill, body: 'after' });
    api.getSkillFile.mockResolvedValue('sources: after');
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.skill?.body).toBe('after'));

    // The re-issued read wins…
    act(() => result.current.loadFile('sources.yaml'));
    await waitFor(() => expect(result.current.fileContent('sources.yaml')).toBe('sources: after'));

    // …and the overtaken one cannot claw the tab back to its old contents.
    await act(async () => {
      releaseStale('sources: before');
    });
    expect(result.current.fileContent('sources.yaml')).toBe('sources: after');
  });

  /**
   * A reload keeps the body it has while the new one is in flight — blanking it
   * would flash the whole page through its loading state on every merge.
   * Switching SKILLS is the opposite: that body belongs to another page.
   */
  it('keeps the current body across a reload but clears it across a skill switch', async () => {
    const { result, rerender } = renderHook(({ name }) => useSkillDetail(name), {
      initialProps: { name: 'newsletter' },
    });
    await waitFor(() => expect(result.current.skill?.body).toBe('before'));

    let releaseReload!: (v: typeof skill) => void;
    api.getSkill.mockImplementationOnce(
      () =>
        new Promise<typeof skill>((res) => {
          releaseReload = res;
        }),
    );
    act(() => result.current.reload());
    // Still readable while the fresh copy is on its way.
    expect(result.current.skill?.body).toBe('before');
    await act(async () => {
      releaseReload({ ...skill, body: 'after' });
    });
    expect(result.current.skill?.body).toBe('after');

    // A different skill blanks immediately — even though `revision` is now
    // non-zero, which is why the hook tracks the shown NAME rather than the
    // counter.
    api.getSkill.mockImplementation(
      () => new Promise<typeof skill>(() => {}),
    );
    rerender({ name: 'digest' });
    expect(result.current.skill).toBeNull();
    expect(result.current.loading).toBe(true);
  });
});
