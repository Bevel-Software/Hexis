import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureEmbed, EMBED_HANDOFF_GLOBAL, readEmbedHandoff, resetEmbedConfig } from '../embed-config';
import { embedRawUrl, loadEmbed, lockEmbed, saveEmbed } from '../services/embed.api';
import { openThroughHost, resolveToAppUrl } from '../embed-host';

/**
 * The embed runs on two surfaces — the SPA's `/embed` page and the MCP App
 * view's sandbox — and `embed-config` is the one place that says which. These
 * tests drive the difference through the modules that read it: the API
 * client, the host bridge, and the handoff the view leaves on the window.
 */

const BASE = 'https://hexis.example';
const KB = { kbDirName: 'knowledge-base', branch: 'main' };

afterEach(() => {
  resetEmbedConfig();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>)[EMBED_HANDOFF_GLOBAL];
});

describe('unconfigured — the SPA /embed page', () => {
  it('addresses the API relative to the page', () => {
    expect(embedRawUrl('tok', '/Data/a.png')).toBe('/api/embed/raw?token=tok&path=%2FData%2Fa.png');
  });

  it('builds app addresses on the page own origin', () => {
    expect(resolveToAppUrl('/workspace/main/x', '', null)).toBe(`${window.location.origin}/workspace/main/x`);
  });
});

describe('handed the deployment address — the MCP App view', () => {
  it('addresses the read routes on the deployment, still without cookies', async () => {
    configureEmbed({ baseUrl: BASE, token: 'tok' });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ nodeName: 'Thing' }) }));
    vi.stubGlobal('fetch', fetchMock);
    await loadEmbed('tok');
    expect(fetchMock).toHaveBeenCalledWith(
      `${BASE}/api/embed/load?token=tok`,
      expect.objectContaining({ credentials: 'omit' }),
    );
    expect(embedRawUrl('tok', '/Data/a.png')).toBe(`${BASE}/api/embed/raw?token=tok&path=%2FData%2Fa.png`);
  });

  it('addresses the write routes on the deployment, still without cookies', async () => {
    configureEmbed({ baseUrl: BASE, token: 'tok' });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 204, json: async () => ({ acquired: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await lockEmbed('tok');
    await saveEmbed('tok', '# changed');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${BASE}/api/embed/lock`,
      expect.objectContaining({ method: 'POST', credentials: 'omit', body: JSON.stringify({ token: 'tok' }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${BASE}/api/embed/save`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        body: JSON.stringify({ token: 'tok', content: '# changed' }),
      }),
    );
  });

  it('keeps a path prefix the deployment is served under', async () => {
    configureEmbed({ baseUrl: `${BASE}/hexis`, token: 'tok' });
    expect(embedRawUrl('tok')).toBe(`${BASE}/hexis/api/embed/raw?token=tok`);
    expect(resolveToAppUrl('/workspace/main/x', '', null)).toBe(`${BASE}/hexis/workspace/main/x`);
  });

  it('builds app addresses on the deployment, not on the sandbox document', () => {
    configureEmbed({ baseUrl: BASE, token: 'tok' });
    expect(resolveToAppUrl('/workspace/main/x', '', null)).toBe(`${BASE}/workspace/main/x`);
    expect(resolveToAppUrl('Other.md#goal', 'knowledge-base/Data/Thing.md', KB)).toBe(
      `${BASE}/workspace/main/knowledge-base/Data/Other.md#goal`,
    );
  });

  it('opens a link through the host, and nowhere else', () => {
    const openLink = vi.fn();
    configureEmbed({ baseUrl: BASE, token: 'tok', openLink });
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    openThroughHost('Other.md', 'knowledge-base/Data/Thing.md', KB);
    expect(openLink).toHaveBeenCalledWith(`${BASE}/workspace/main/knowledge-base/Data/Other.md`);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('refuses to hand the host a destination the link grammar refuses', () => {
    const openLink = vi.fn();
    configureEmbed({ baseUrl: BASE, token: 'tok', openLink });
    openThroughHost('javascript:alert(1)', 'knowledge-base/Data/Thing.md', KB);
    expect(openLink).not.toHaveBeenCalled();
  });
});

describe('the handoff the view leaves on the window', () => {
  const set = (value: unknown) => {
    (window as unknown as Record<string, unknown>)[EMBED_HANDOFF_GLOBAL] = value;
  };

  it('is absent when the bundle was not loaded by the view', () => {
    expect(readEmbedHandoff()).toBeNull();
  });

  it('is read with its address kept to origin and path, and the open-link kept', () => {
    const openLink = () => undefined;
    set({ baseUrl: `${BASE}/?x=1#y`, token: 'tok', openLink });
    expect(readEmbedHandoff()).toEqual({ baseUrl: BASE, token: 'tok', openLink });
  });

  it('keeps the path prefix a deployment is served under', () => {
    set({ baseUrl: `${BASE}/hexis/`, token: 'tok' });
    expect(readEmbedHandoff()).toEqual({ baseUrl: `${BASE}/hexis`, token: 'tok' });
  });

  it.each([
    ['no token', { baseUrl: BASE, token: '' }],
    ['a non-http address', { baseUrl: 'javascript:alert(1)', token: 'tok' }],
    ['a relative address', { baseUrl: '/api', token: 'tok' }],
    ['not an object', 'https://hexis.example'],
  ])('is refused with %s', (_label, value) => {
    set(value);
    expect(readEmbedHandoff()).toBeNull();
  });
});
