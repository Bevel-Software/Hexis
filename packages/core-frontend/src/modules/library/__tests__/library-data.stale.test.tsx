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

import { LibraryProvider } from '../state/library-data';
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
    const view = render(<LibraryProvider>x</LibraryProvider>);
    expect(reload).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    });
    expect(reload).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => {
      window.dispatchEvent(new Event(PR_STALE_EVENT));
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
