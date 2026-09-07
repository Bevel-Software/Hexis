import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import type { LibraryData } from '../hooks/useLibraryData';

/**
 * The catalog's own view of change requests refreshes on the same event the
 * shell's change-request provider refreshes on. Two stores that each fetch
 * requests are tolerable only while they move together.
 */
const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));
vi.mock('../services/plugins.api', () => ({ listPlugins: vi.fn().mockResolvedValue([]) }));

import { LibraryProvider, useLibrary } from '../state/library-data';
import { PR_STALE_EVENT } from '../../../core/events';

describe('LibraryProvider', () => {
  it('reloads the catalog when change requests go stale', async () => {
    const reload = vi.fn();
    const data: LibraryData = {
      loading: false,
      error: null,
      skills: [],
      pendingSkills: [],
      tools: [],
      ownedSkills: new Set(),
      allowedToolsBySkill: new Map(),
      crs: [],
      myCrNumbers: new Set(),
      reload,
    };
    dataMock.useLibraryData.mockReturnValue(data);
    const { listPlugins } = await import('../services/plugins.api');
    vi.mocked(listPlugins).mockClear();
    const view = render(<LibraryProvider>x</LibraryProvider>);
    await act(async () => undefined);
    expect(reload).not.toHaveBeenCalled();
    expect(listPlugins).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    });
    expect(reload).toHaveBeenCalledTimes(1);
    // A merged change can move plugin links and access: the summaries
    // refresh with the catalog, not only on a page's own reload.
    expect(listPlugins).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => {
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the context's reload refreshes the plugin summaries with the catalog", async () => {
    // A page that reloads after a link, a repair or an access edit must get
    // fresh plugin counts too — the broken-link number lives in the summary.
    const reload = vi.fn();
    const data: LibraryData = {
      loading: false,
      error: null,
      skills: [],
      pendingSkills: [],
      tools: [],
      ownedSkills: new Set(),
      allowedToolsBySkill: new Map(),
      crs: [],
      myCrNumbers: new Set(),
      reload,
    };
    dataMock.useLibraryData.mockReturnValue(data);
    const { listPlugins } = await import('../services/plugins.api');
    vi.mocked(listPlugins).mockClear();
    let ctx: ReturnType<typeof useLibrary> | null = null;
    function Probe() {
      ctx = useLibrary();
      return null;
    }
    render(
      <LibraryProvider>
        <Probe />
      </LibraryProvider>,
    );
    await act(async () => undefined);
    expect(listPlugins).toHaveBeenCalledTimes(1);
    await act(async () => {
      ctx!.reload();
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(listPlugins).toHaveBeenCalledTimes(2);
  });
});
