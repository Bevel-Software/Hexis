import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, act } from '@testing-library/react';
import type { LibraryData } from '../hooks/useLibraryData';
import type { ToolSecrets } from '../../secrets-vault/services/tool-secrets.api';

/**
 * The catalog's own view of change requests refreshes on the same event the
 * shell's change-request provider refreshes on. Two stores that each fetch
 * requests are tolerable only while they move together.
 */
const dataMock = vi.hoisted(() => ({ useLibraryData: vi.fn() }));
vi.mock('../hooks/useLibraryData', () => ({ useLibraryData: dataMock.useLibraryData }));
vi.mock('../services/plugins.api', () => ({ listPlugins: vi.fn().mockResolvedValue([]) }));
vi.mock('../services/teams.api', () => ({ listTeams: vi.fn().mockResolvedValue([]) }));

import { LibraryProvider, useLibrary } from '../state/library-data';
import { PR_STALE_EVENT, TOOL_CREDENTIALS_STALE_EVENT } from '../../../core/events';

/** The catalog, empty — each test fills in only the part it is about. */
function emptyData(reload: () => void): LibraryData {
  return {
    loading: false,
    error: null,
    skills: [],
    pendingSkills: [],
    tools: [],
    ownedSkills: new Set(),
    writableSkills: new Set(),
    ownedTools: new Set(),
    allowedToolsBySkill: new Map(),
    crs: [],
    myCrNumbers: new Set(),
    reload,
  };
}

describe('LibraryProvider', () => {
  it('reloads the catalog when change requests go stale', async () => {
    const reload = vi.fn();
    const data = emptyData(reload);
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
    const data = emptyData(reload);
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

  /**
   * A credential landing anywhere in the app.
   *
   * The tool page re-probes itself after a save, which is exactly why the bug
   * this covers was invisible there and obvious one click later: everything
   * that says "needs setup" — the cards, the plugin page's banner, the sidebar
   * count — reads the tool rows in THIS catalog, loaded before the write.
   */
  describe('after a credential lands', () => {
    it('reloads the catalog and the plugin summaries together', async () => {
      // Together, not just the catalog: the plugin summaries carry the counts
      // behind the banner and the sidebar, and a catalog-only reload leaves
      // the number from before the save beside a card that has moved on.
      const reload = vi.fn();
      dataMock.useLibraryData.mockReturnValue(emptyData(reload));
      const { listPlugins } = await import('../services/plugins.api');
      vi.mocked(listPlugins).mockClear();

      const view = render(<LibraryProvider>x</LibraryProvider>);
      await act(async () => undefined);
      expect(reload).not.toHaveBeenCalled();
      expect(listPlugins).toHaveBeenCalledTimes(1);

      await act(async () => {
        window.dispatchEvent(new Event(TOOL_CREDENTIALS_STALE_EVENT));
      });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(listPlugins).toHaveBeenCalledTimes(2);

      // The listener dies with the provider: a save on /secrets, which is a
      // shell route of its own with no Library mounted under it, must not
      // reach for a store that is gone.
      view.unmount();
      await act(async () => {
        window.dispatchEvent(new Event(TOOL_CREDENTIALS_STALE_EVENT));
      });
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it('leaves the tool reading as configured for the page the reader goes back to', async () => {
      // The whole point, end to end: the catalog refetches, and the item every
      // card and banner is built from carries the NEW state. The mock stands
      // in for the real hook's refetch — one reload, one fresher answer.
      const tool = (userConfigured: boolean): ToolSecrets => ({
        slug: 'heyreach',
        name: 'heyreach',
        path: 'Plugins/GTM/heyreach.tool',
        type: 'inline',
        setup: null,
        canWrite: false,
        variables: [
          {
            name: 'API_KEY',
            scope: 'user',
            label: null,
            key: 'heyreach_API_KEY',
            adminConfigured: true,
            userConfigured,
          },
        ],
      });
      dataMock.useLibraryData.mockImplementation(() => {
        const [saved, setSaved] = useState(false);
        return { ...emptyData(() => setSaved(true)), tools: [tool(saved)] };
      });

      let status = '';
      function Probe() {
        status = useLibrary().items[0].status.text;
        return null;
      }
      render(
        <LibraryProvider>
          <Probe />
        </LibraryProvider>,
      );
      await act(async () => undefined);
      expect(status).toBe('Needs a key from you');

      await act(async () => {
        window.dispatchEvent(new Event(TOOL_CREDENTIALS_STALE_EVENT));
      });
      expect(status).toBe('Key saved');
    });
  });
});
