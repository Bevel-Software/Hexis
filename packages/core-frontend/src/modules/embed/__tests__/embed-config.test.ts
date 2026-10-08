import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureEmbed, EMBED_HANDOFF_GLOBAL, readEmbedHandoff, resetEmbedConfig } from '../embed-config';
import { embedRawUrl, loadEmbed } from '../services/embed.api';
import { openThroughHost, resolveToAppUrl } from '../embed-host';

/**
 * The embed runs on two surfaces — the SPA's `/embed` page and the MCP App
 * view's sandbox — and `embed-config` is the one place that says which. These
 * tests drive the difference through the modules that read it: the API
 * client, the host bridge, and the handoff the view leaves on the window.
 */

const ORIGIN = 'https://hexis.example';
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

describe('handed the deployment origin — the MCP App view', () => {
  it('addresses every token route on the deployment, still without cookies', async () => {
    configureEmbed({ origin: ORIGIN, token: 'tok' });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ nodeName: 'Thing' }) }));
    vi.stubGlobal('fetch', fetchMock);
    await loadEmbed('tok');
    expect(fetchMock).toHaveBeenCalledWith(
      `${ORIGIN}/api/embed/load?token=tok`,
      expect.objectContaining({ credentials: 'omit' }),
    );
    expect(embedRawUrl('tok', '/Data/a.png')).toBe(`${ORIGIN}/api/embed/raw?token=tok&path=%2FData%2Fa.png`);
  });

  it('builds app addresses on the deployment, not on the sandbox document', () => {
    configureEmbed({ origin: ORIGIN, token: 'tok' });
    expect(resolveToAppUrl('/workspace/main/x', '', null)).toBe(`${ORIGIN}/workspace/main/x`);
    expect(resolveToAppUrl('Other.md#goal', 'knowledge-base/Data/Thing.md', KB)).toBe(
      `${ORIGIN}/workspace/main/knowledge-base/Data/Other.md#goal`,
    );
  });

  it('opens a link through the host, and nowhere else', () => {
    const openLink = vi.fn();
    configureEmbed({ origin: ORIGIN, token: 'tok', openLink });
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    openThroughHost('Other.md', 'knowledge-base/Data/Thing.md', KB);
    expect(openLink).toHaveBeenCalledWith(`${ORIGIN}/workspace/main/knowledge-base/Data/Other.md`);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('refuses to hand the host a destination the link grammar refuses', () => {
    const openLink = vi.fn();
    configureEmbed({ origin: ORIGIN, token: 'tok', openLink });
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

  it('is read with its origin reduced to an origin, and the open-link kept', () => {
    const openLink = () => undefined;
    set({ origin: `${ORIGIN}/some/path?x=1`, token: 'tok', openLink });
    expect(readEmbedHandoff()).toEqual({ origin: ORIGIN, token: 'tok', openLink });
  });

  it.each([
    ['no token', { origin: ORIGIN, token: '' }],
    ['a non-http origin', { origin: 'javascript:alert(1)', token: 'tok' }],
    ['a relative origin', { origin: '/api', token: 'tok' }],
    ['not an object', 'https://hexis.example'],
  ])('is refused with %s', (_label, value) => {
    set(value);
    expect(readEmbedHandoff()).toBeNull();
  });
});
