import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  canDeepLink,
  claudeCodeCommand,
  claudeInstallUrl,
  configureMcpUrl,
  connectorName,
  jsonConfigSnippet,
  langdockSnippet,
  mcpEndpointUrl,
  resetMcpUrlForTests,
} from '../connect-snippets';

/**
 * The rules behind every connect surface. All of it is pure except the
 * module-global endpoint, which is reset between cases the same way the
 * shared test setup does it.
 */
beforeEach(() => {
  resetMcpUrlForTests();
});

describe('mcpEndpointUrl: the deployment answers for its own address', () => {
  it('uses what the server said', () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    expect(mcpEndpointUrl()).toBe('https://kb.acme.com/api/mcp');
  });

  /**
   * The case that decides whether a stale tab can boot: a cached bundle
   * talking to a server that predates the field. It must fall back, not
   * throw — the whole page is on the far side of this call.
   */
  it('falls back to the origin when the server sends nothing', () => {
    configureMcpUrl(undefined);
    expect(mcpEndpointUrl()).toBe(`${window.location.origin}/api/mcp`);
  });

  it('falls back rather than trusting a value it cannot parse', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configureMcpUrl('not a url');
    expect(mcpEndpointUrl()).toBe(`${window.location.origin}/api/mcp`);
    configureMcpUrl(42);
    expect(mcpEndpointUrl()).toBe(`${window.location.origin}/api/mcp`);
    warn.mockRestore();
  });

  /**
   * `new URL()` parses `javascript:alert(1)` perfectly happily. Nothing
   * renders this value as an `href` today and `canDeepLink` would refuse it
   * anyway, but a value arriving over the network should not be able to hold
   * a script scheme at all, waiting for a future consumer to use it less
   * carefully.
   */
  it('refuses a scheme that is not http or https', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>', 'ftp://kb.acme.com/']) {
      configureMcpUrl(hostile);
      expect(mcpEndpointUrl()).toBe(`${window.location.origin}/api/mcp`);
    }
    warn.mockRestore();
  });

  /**
   * A value WAS sent and we refused it: the operator gets a signal instead of
   * silently seeing the origin. Absence is the expected older-server path and
   * must stay quiet.
   */
  it('warns when it refuses a value, and stays quiet when none was sent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    configureMcpUrl('not a url');
    expect(warn).toHaveBeenCalledOnce();
    warn.mockClear();
    configureMcpUrl(undefined);
    configureMcpUrl('');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Module-global state: a suite that configures an address must not decide
  // the answer for the next one.
  it('forgets a configured address on reset', () => {
    configureMcpUrl('https://kb.acme.com/api/mcp');
    resetMcpUrlForTests();
    expect(mcpEndpointUrl()).toBe(`${window.location.origin}/api/mcp`);
  });
});

describe('canDeepLink: is this endpoint certainly unreachable?', () => {
  it('accepts a public https address', () => {
    expect(canDeepLink('https://kb.acme.com/api/mcp')).toBe(true);
    expect(canDeepLink('https://kb.acme.com:8443/api/mcp')).toBe(true);
  });

  // Anthropic fetches the server from its own infrastructure. Plaintext is
  // a non-starter whatever the host is.
  it('refuses plain http, even on a public host', () => {
    expect(canDeepLink('http://kb.acme.com/api/mcp')).toBe(false);
  });

  /**
   * The default configuration, not an edge case: `publicBackendUrl` falls
   * back to `http://localhost:3001` and `.env.example` ships
   * `PUBLIC_BACKEND_URL` commented out. Every dev machine and every
   * quickstart Docker deploy lands here.
   */
  it('refuses loopback in every spelling', () => {
    expect(canDeepLink('https://localhost/api/mcp')).toBe(false);
    expect(canDeepLink('https://localhost:3001/api/mcp')).toBe(false);
    expect(canDeepLink('http://localhost:3001/api/mcp')).toBe(false);
    expect(canDeepLink('https://app.localhost/api/mcp')).toBe(false);
    expect(canDeepLink('https://127.0.0.1/api/mcp')).toBe(false);
    expect(canDeepLink('https://127.5.5.5/api/mcp')).toBe(false);
    expect(canDeepLink('https://[::1]/api/mcp')).toBe(false);
  });

  it('refuses RFC 1918 space', () => {
    expect(canDeepLink('https://10.0.0.4/api/mcp')).toBe(false);
    expect(canDeepLink('https://192.168.1.10/api/mcp')).toBe(false);
    expect(canDeepLink('https://172.16.0.1/api/mcp')).toBe(false);
    expect(canDeepLink('https://172.31.255.254/api/mcp')).toBe(false);
    expect(canDeepLink('https://169.254.1.1/api/mcp')).toBe(false); // link-local
    expect(canDeepLink('https://0.0.0.0/api/mcp')).toBe(false);
  });

  /**
   * The boundaries of 172.16.0.0/12, stated explicitly — an off-by-one here
   * silently hides the button from a legitimate public deployment, which is
   * a failure nobody would think to look for.
   */
  it('does not over-reach past the edges of 172.16.0.0/12', () => {
    expect(canDeepLink('https://172.15.0.1/api/mcp')).toBe(true);
    expect(canDeepLink('https://172.32.0.1/api/mcp')).toBe(true);
  });

  it('refuses names that are private by definition', () => {
    expect(canDeepLink('https://hexis.local/api/mcp')).toBe(false);
    expect(canDeepLink('https://hexis.internal/api/mcp')).toBe(false);
  });

  // A single-label host has no public DNS to resolve.
  it('refuses a bare hostname', () => {
    expect(canDeepLink('https://hexis/api/mcp')).toBe(false);
  });

  // Called during render — it returns an answer, it never throws one.
  it('refuses garbage without throwing', () => {
    expect(canDeepLink('not a url')).toBe(false);
    expect(canDeepLink('')).toBe(false);
    expect(canDeepLink('ftp://kb.acme.com/api/mcp')).toBe(false);
  });

  /**
   * The known hole, pinned so nobody mistakes it for an oversight: an
   * internal-only hostname is indistinguishable from a public one without
   * resolving it, and no check we run from inside the network could tell.
   * Claude reports this failure; we cannot pre-empt it.
   */
  it('cannot tell an internal-only hostname from a public one', () => {
    expect(canDeepLink('https://hexis.corp.acme.com/api/mcp')).toBe(true);
  });
});

describe('claudeInstallUrl: the documented install link', () => {
  const URL_UNDER_TEST = 'https://kb.acme.com/api/mcp';

  it('targets the documented add-custom-connector dialog', () => {
    const link = claudeInstallUrl(URL_UNDER_TEST, 'Hexis');
    expect(link.startsWith('https://claude.ai/customize/connectors?')).toBe(true);
    expect(link).toContain('modal=add-custom-connector');
  });

  it('percent-encodes the endpoint so it survives as one parameter', () => {
    const link = claudeInstallUrl(URL_UNDER_TEST, 'Hexis');
    expect(link).toContain('connectorUrl=https%3A%2F%2Fkb.acme.com%2Fapi%2Fmcp');
  });

  /**
   * `%20`, never `+`. `URLSearchParams` would produce `+`, which only means
   * "space" to a decoder applying form rules — and the connector name always
   * contains spaces.
   */
  it('encodes spaces as %20 rather than +', () => {
    const link = claudeInstallUrl(URL_UNDER_TEST, 'Hexis — kb.acme.com');
    expect(link).toContain('connectorName=Hexis%20%E2%80%94%20kb.acme.com');
    expect(link).not.toContain('+');
  });

  it('survives a name with characters that would otherwise split the query', () => {
    const link = claudeInstallUrl(URL_UNDER_TEST, 'R&D — kb.acme.com?x=1');
    expect(link).toContain('connectorName=R%26D%20%E2%80%94%20kb.acme.com%3Fx%3D1');
    // Exactly the three parameters we meant to send.
    expect(new URL(link).searchParams.get('connectorName')).toBe('R&D — kb.acme.com?x=1');
    expect(new URL(link).searchParams.get('connectorUrl')).toBe(URL_UNDER_TEST);
  });
});

describe('connectorName: what it is called in a connector list', () => {
  it('names the product and the deployment', () => {
    expect(connectorName('https://kb.acme.com/api/mcp')).toBe('Hexis — kb.acme.com');
  });

  /**
   * The collision this exists to prevent: try the public demo, then
   * self-host, and two identically-named connectors point at different
   * servers with nothing to tell them apart.
   */
  it('distinguishes two deployments of the same product', () => {
    expect(connectorName('https://demo.bevel.software/api/mcp')).not.toBe(
      connectorName('https://kb.acme.com/api/mcp'),
    );
  });

  // `host`, not `hostname` — two instances on one machine differ only by port.
  it('keeps a non-default port', () => {
    expect(connectorName('https://kb.acme.com:8443/api/mcp')).toBe('Hexis — kb.acme.com:8443');
  });

  it('still names something when the URL is unparseable', () => {
    expect(connectorName('not a url')).toBe('Hexis');
  });
});

describe('snippets: one builder per client, keyed or not', () => {
  const URL_UNDER_TEST = 'https://kb.acme.com/api/mcp';
  const KEY = 'bvl_secret_123';

  it('builds the Claude Code command without a key', () => {
    expect(claudeCodeCommand(URL_UNDER_TEST)).toBe(
      `claude mcp add --transport http knowledge-base ${URL_UNDER_TEST}`,
    );
  });

  it('appends the Authorization header when there is a key', () => {
    expect(claudeCodeCommand(URL_UNDER_TEST, KEY)).toBe(
      `claude mcp add --transport http knowledge-base ${URL_UNDER_TEST} --header "Authorization: Bearer ${KEY}"`,
    );
  });

  /**
   * The keyless config must not carry an empty `headers` block — a client
   * reading it would send `Authorization: Bearer undefined`.
   */
  it('omits headers entirely from the keyless JSON config', () => {
    const parsed = JSON.parse(jsonConfigSnippet(URL_UNDER_TEST));
    expect(parsed.mcpServers['knowledge-base']).toEqual({
      type: 'http',
      url: URL_UNDER_TEST,
    });
    expect('headers' in parsed.mcpServers['knowledge-base']).toBe(false);
  });

  it('carries the key in the JSON config when there is one', () => {
    const parsed = JSON.parse(jsonConfigSnippet(URL_UNDER_TEST, KEY));
    expect(parsed.mcpServers['knowledge-base']).toEqual({
      type: 'http',
      url: URL_UNDER_TEST,
      headers: { Authorization: `Bearer ${KEY}` },
    });
  });

  it('spells the Langdock fields out separately', () => {
    expect(langdockSnippet(URL_UNDER_TEST, KEY)).toBe(
      `URL: ${URL_UNDER_TEST}\nHeader name: Authorization\nHeader value: Bearer ${KEY}`,
    );
  });

  /**
   * The regression that the six-site consolidation could have introduced:
   * every snippet quotes the endpoint it was handed, and none of them
   * reaches for the browser's address instead.
   */
  it('never falls back to the page origin', () => {
    const origin = window.location.origin;
    for (const snippet of [
      claudeCodeCommand(URL_UNDER_TEST),
      claudeCodeCommand(URL_UNDER_TEST, KEY),
      jsonConfigSnippet(URL_UNDER_TEST),
      jsonConfigSnippet(URL_UNDER_TEST, KEY),
      langdockSnippet(URL_UNDER_TEST, KEY),
    ]) {
      expect(snippet).toContain(URL_UNDER_TEST);
      expect(snippet).not.toContain(origin);
    }
  });
});
