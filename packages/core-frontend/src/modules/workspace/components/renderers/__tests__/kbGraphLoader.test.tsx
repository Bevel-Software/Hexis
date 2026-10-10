import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AppRegistryContext, EMPTY_REGISTRY, type AppRegistry } from '../../../../../core/registry';
import { RendererSurfaceContext, type RendererSurface } from '../rendererSurface';
import { useKbGraphLoader } from '../kbGraphLoader';

const SURFACE: RendererSurface = {
  kbDirName: 'knowledge-base',
  openLink: () => undefined,
  openWorkspacePath: () => undefined,
  openNodeId: () => undefined,
  canonicalUrlFor: () => null,
  rawUrl: () => '',
  rawFetch: async () => new Response(),
  offersDownload: false,
};

function wrap(registry: AppRegistry, surface: RendererSurface | null) {
  return ({ children }: { children: ReactNode }) => (
    <AppRegistryContext.Provider value={registry}>
      <RendererSurfaceContext.Provider value={surface}>{children}</RendererSurfaceContext.Provider>
    </AppRegistryContext.Provider>
  );
}

/**
 * The one place a graph-drawing renderer gets its loader: the surface's own
 * on a surface, the registry's `inApp` in the app, nothing when the
 * distribution registered no source.
 */
describe('useKbGraphLoader', () => {
  it('reads the registry source with the session in the app, where there is no surface', async () => {
    const inApp = vi.fn(async (id: string) => ({ for: id }));
    const inEmbed = vi.fn(async () => ({}));
    const registry = { ...EMPTY_REGISTRY, kbGraphSource: { inApp, inEmbed } };
    const { result } = renderHook(() => useKbGraphLoader('ws-main'), { wrapper: wrap(registry, null) });
    expect(await result.current!()).toEqual({ for: 'ws-main' });
    expect(inApp).toHaveBeenCalledWith('ws-main');
    expect(inEmbed).not.toHaveBeenCalled();
  });

  it("uses the surface's loader on a surface that offers one, and nothing on one that does not", async () => {
    const inApp = vi.fn(async () => ({}));
    const registry = { ...EMPTY_REGISTRY, kbGraphSource: { inApp, inEmbed: async () => ({}) } };
    const loadKbGraph = vi.fn(async () => ({ from: 'surface' }));
    const offering = renderHook(() => useKbGraphLoader('ws-main'), { wrapper: wrap(registry, { ...SURFACE, loadKbGraph }) });
    expect(await offering.result.current!()).toEqual({ from: 'surface' });
    expect(inApp).not.toHaveBeenCalled();
    const bare = renderHook(() => useKbGraphLoader('ws-main'), { wrapper: wrap(registry, SURFACE) });
    expect(bare.result.current).toBeNull();
  });

  it('answers nothing when no source is registered, or no workspace is known', () => {
    const none = renderHook(() => useKbGraphLoader('ws-main'), { wrapper: wrap(EMPTY_REGISTRY, null) });
    expect(none.result.current).toBeNull();
    const registry = { ...EMPTY_REGISTRY, kbGraphSource: { inApp: async () => ({}), inEmbed: async () => ({}) } };
    const unknown = renderHook(() => useKbGraphLoader(null), { wrapper: wrap(registry, null) });
    expect(unknown.result.current).toBeNull();
  });
});
