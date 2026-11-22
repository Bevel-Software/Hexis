import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { SecretsPage } from '../SecretsPage';
import { listToolSecrets } from '../../services/tool-secrets.api';
import { getConnectPending } from '../../services/connect.api';
import { listSecrets } from '../../services/secrets.api';

/**
 * "WHEN the person leaves that page for any other page THEN it acts for the
 * person: nothing else in the app is 'as the bot'."
 *
 * Local Testing#1 found the Skills & Tools lists showing a bot's integration
 * counts after the person left Connect tools opened for that bot: the bot was
 * kept in one module-wide slot that EVERY secrets request read, so a list the
 * Library fetched while the page was open (its refetch on the credentials
 * announcement, the search palette) asked as the bot, and kept the answer.
 * Here the REAL API functions run against a recorded `fetch`: the page's own
 * requests name the bot, and a request made anywhere else — while the page is
 * open and after it leaves — never does.
 */

const asked: { url: string; method: string }[] = [];

function respond(url: string): unknown {
  if (url.startsWith('/api/secrets/tools/') && url.includes('/check')) {
    return { verdict: { status: 'unverifiable', detail: 'n/a', checkedAt: new Date().toISOString() } };
  }
  if (url.startsWith('/api/secrets/tools/')) return {};
  if (url.startsWith('/api/secrets/tools')) {
    return {
      tools: [
        {
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
              adminKind: 'static',
              userConfigured: false,
            },
          ],
        },
      ],
    };
  }
  if (url.startsWith('/api/connect/pending')) return { tools: [], oauth: [], toolOAuth: [] };
  if (url.startsWith('/api/secrets')) return { secrets: [] };
  return {};
}

beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      asked.push({ url, method: init?.method ?? 'GET' });
      return new Response(JSON.stringify(respond(url)), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const forBot = (url: string) => /[?&]bot=ops(?:&|$)/.test(url);

/** Hands the test the router's own navigation, as a link on the page would use it. */
let navigateTo: (to: string) => void = () => undefined;
function Navigator() {
  navigateTo = useNavigate();
  return null;
}

describe('a page opened for a bot acts for it, and nothing else does', () => {
  it('follows its URL while it stays mounted: another link names whom it acts for from then on', async () => {
    window.history.replaceState(null, '', '/secrets?bot=ops');
    render(
      <MemoryRouter initialEntries={['/secrets?bot=ops']}>
        <Navigator />
        <SecretsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('secrets-of-bot')).toHaveTextContent('Secrets of ops');
    asked.length = 0;
    act(() => navigateTo('/secrets'));
    await waitFor(() => expect(screen.queryByTestId('secrets-of-bot')).toBeNull());
    await waitFor(() => expect(asked.filter((a) => a.method === 'GET').length).toBeGreaterThan(0));
    expect(asked.some((a) => a.url.includes('bot='))).toBe(false);
  });

  it("names the bot on the page's own reads and writes, never on a request made elsewhere, during or after", async () => {
    window.history.replaceState(null, '', '/secrets?bot=ops');
    const page = render(
      <MemoryRouter initialEntries={['/secrets?bot=ops']}>
        <SecretsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('secrets-of-bot')).toHaveTextContent('Secrets of ops');
    const field = await screen.findByLabelText('Value for API_KEY');

    // The page's lists were the bot's.
    const pageReads = asked.filter((a) => a.method === 'GET');
    expect(pageReads.map((a) => a.url).sort()).toEqual(['/api/secrets/tools?bot=ops', '/api/secrets?bot=ops']);

    // While it is open, the Library (or the search palette) refetches: the
    // person's, not the bot's.
    asked.length = 0;
    await Promise.all([listToolSecrets(), getConnectPending(), listSecrets()]);
    expect(asked.map((a) => a.url).sort()).toEqual(['/api/connect/pending', '/api/secrets', '/api/secrets/tools']);

    // A value saved in the page's panel is the bot's, and so is its probe.
    asked.length = 0;
    fireEvent.change(field, { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(asked.some((a) => a.method === 'PUT')).toBe(true));
    await waitFor(() => expect(asked.some((a) => a.url.includes('/check'))).toBe(true));
    const put = asked.find((a) => a.method === 'PUT')!;
    expect(put.url).toBe('/api/secrets/tools/heyreach/vars/API_KEY/user?bot=ops');
    expect(asked.filter((a) => a.url.includes('/check')).every((a) => forBot(a.url))).toBe(true);

    // Left: everything is the person's again.
    page.unmount();
    asked.length = 0;
    await listToolSecrets();
    expect(asked.map((a) => a.url)).toEqual(['/api/secrets/tools']);
  });

  it('is the person\'s own page, and asks as the person, when the link names no bot', async () => {
    window.history.replaceState(null, '', '/secrets');
    render(
      <MemoryRouter initialEntries={['/secrets']}>
        <SecretsPage />
      </MemoryRouter>,
    );
    await screen.findByLabelText('Value for API_KEY');
    expect(screen.queryByTestId('secrets-of-bot')).toBeNull();
    expect(asked.some((a) => forBot(a.url) || a.url.includes('bot='))).toBe(false);
  });
});
