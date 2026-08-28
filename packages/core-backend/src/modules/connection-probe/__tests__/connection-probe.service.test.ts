import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommunicationProtocol, type CallTemplate } from '@utcp/sdk';
import type {
  IToolManualService,
  ToolHealthCheck,
  ToolProbeTarget,
} from '../../tool-manuals/tool-manuals.contract.js';
import type { ISecretsVaultService } from '../../secrets-vault/secrets-vault.contract.js';

/**
 * The three-way verdict is the whole point of this module, and the line that
 * matters most is between `failed` and `unverifiable`.
 *
 * `failed` is the only status that ACCUSES the user's credential, so it must be
 * reachable ONLY from a provider definitively rejecting it. Everything else —
 * a timeout, a 500, a tool with nothing to call — has to come back "we don't
 * know", because a badge that shouts "not working" during someone else's outage
 * gets ignored, and an ignored badge is the bug we started with wearing a
 * different colour.
 */

const registerManualMock = vi.fn<(client: unknown, manual: CallTemplate) => Promise<unknown>>();
const createClientMock = vi.fn<() => Promise<unknown>>();

// Only `registerManual` is replaced. The rest of this package has to stay real:
// `shared/utcp-namespace.ts` RE-EXPORTS `utcpNamespacedKey` from it, so a bare
// factory silently removes the function every vault lookup goes through.
vi.mock('@bevel-software/platform-mcp-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bevel-software/platform-mcp-core')>()),
  registerManual: (client: unknown, manual: CallTemplate) => registerManualMock(client, manual),
}));
vi.mock('@utcp/code-mode', () => ({
  CodeModeUtcpClient: { create: () => createClientMock() },
}));

const { ConnectionProbeService } = await import('../connection-probe.service.js');

const DECLARED_PROBE: ToolHealthCheck = {
  url: 'https://api.acme.test/me',
  headers: { Authorization: 'Bearer ${API_KEY}' },
};

const MCP_TEMPLATE = {
  name: 'acme',
  call_template_type: 'mcp',
  config: { mcpServers: { acme: { transport: 'http', url: 'https://mcp.acme.test' } } },
} as unknown as CallTemplate;

function build(
  target: Partial<ToolProbeTarget> | null,
  resolve: (key: string) => Promise<string | null> = async () => 'sk-live-abc',
) {
  const toolManualService = {
    // Probe config travels by its own accessor rather than on the summary: it
    // carries `headers`, which a `.tool` may write as a literal token, and the
    // summary is serialized straight to the browser.
    probeTargetFor: async (): Promise<ToolProbeTarget | null> =>
      target === null
        ? null
        : { name: 'acme', type: 'http', callTemplate: null, ...target },
  } as unknown as IToolManualService;
  const secretsVault = { resolve: (_u: string, key: string) => resolve(key) } as unknown as ISecretsVaultService;
  return new ConnectionProbeService(toolManualService, secretsVault);
}

const httpTool = (probe: ToolHealthCheck = DECLARED_PROBE) => build({ type: 'http', healthCheck: probe });

describe('ConnectionProbeService: what the probe concludes', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    registerManualMock.mockReset();
    createClientMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is ok when the provider accepts the credential', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    const r = await httpTool().probe('u1', 'a@b.c', 'acme');

    expect(r?.status).toBe('ok');
    expect(r?.detail).toBeNull();
    expect(r?.checkedAt).toBeInstanceOf(Date);
  });

  it('carries the credential into the probe, so it tests what the tool would send', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

    await httpTool().probe('u1', 'a@b.c', 'acme');

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.acme.test/me');
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer sk-live-abc' });
    // A probe runs unattended on every save; it must not be able to mutate, and
    // a 3xx to an internal host must not be followed.
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).redirect).toBe('manual');
  });

  it.each([401, 403])('fails on a definitive rejection (%i), quoting the provider', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response('invalid api key', { status }));

    const r = await httpTool().probe('u1', 'a@b.c', 'acme');

    expect(r?.status).toBe('failed');
    expect(r?.detail).toContain('invalid api key');
  });

  it('does NOT accuse the credential when the provider is merely unwell', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('boom', { status: 500 }));

    const r = await httpTool().probe('u1', 'a@b.c', 'acme');

    expect(r?.status).toBe('unverifiable');
    expect(r?.detail).toContain('500');
  });

  it('does NOT accuse the credential when the provider is unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ETIMEDOUT'));

    const r = await httpTool().probe('u1', 'a@b.c', 'acme');

    expect(r?.status).toBe('unverifiable');
    expect(r?.detail).toMatch(/Couldn't reach the provider/);
  });

  it('does not fire a request at all when the credential is not set yet', async () => {
    const svc = build({ type: 'http', healthCheck: DECLARED_PROBE }, async () => null);

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    // Sending an empty Bearer and reading the inevitable 401 would report a
    // MISSING key as a WRONG one — two different problems with two different fixes.
    expect(r?.status).toBe('unverifiable');
    expect(r?.detail).toMatch(/isn't set yet/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is unverifiable, not ok, for an http tool that declares no probe', async () => {
    // Built directly rather than through `httpTool`: passing an explicit
    // `undefined` to a defaulted parameter selects the DEFAULT probe, which is
    // the opposite of what this test is about.
    const r = await build({ type: 'http' }).probe('u1', 'a@b.c', 'acme');

    expect(r?.status).toBe('unverifiable');
    expect(r?.detail).toMatch(/doesn't offer a way to test/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is unverifiable for a local-only tool this server cannot reach', async () => {
    const svc = build({ type: 'http', healthCheck: DECLARED_PROBE, remote: false });

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r?.status).toBe('unverifiable');
    expect(r?.detail).toMatch(/local agent/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is null for a tool the caller cannot read, so a 404 confirms nothing', async () => {
    expect(await build(null).probe('u1', 'a@b.c', 'nope')).toBeNull();
  });

  /**
   * The parse-time SSRF guard cannot check a TEMPLATED host — it does not exist
   * until a secret resolves — so the fetch-time re-check is the only thing
   * standing between a `.tool` and the cloud metadata endpoint.
   */
  it('refuses to call an internal host a variable resolved to', async () => {
    const svc = build({ type: 'http', healthCheck: { url: 'https://${HOST}/me' } }, async () => '169.254.169.254');

    const r = await svc.probe('u1', 'a@b.c', 'acme');

    expect(r?.status).toBe('unverifiable');
    expect(fetch).not.toHaveBeenCalled();
  });

  /**
   * UTCP substitutes BOTH `${VAR}` and bare `$VAR`, and the scanner that decides
   * which variables to ask the user for accepts both too. A probe that only
   * understood the braced form sent the literal `$API_KEY` on the wire, drew a
   * 401, and reported a perfectly good credential as "Not working".
   */
  describe('variable references, in UTCP’s own grammar', () => {
    it('substitutes a BARE $VAR, not just ${VAR}', async () => {
      const svc = build({ type: 'http', healthCheck: { url: 'https://api.acme.test/me', headers: { Authorization: 'Bearer $API_KEY' } } });
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      await svc.probe('u1', 'a@b.c', 'acme');

      const [, init] = vi.mocked(fetch).mock.calls[0];
      expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer sk-live-abc' });
    });

    it('does not let a SHORTER name corrupt a longer one sharing its prefix', async () => {
      // `$API` must not eat the head of `$API_KEY`. A replace-per-name loop
      // gets this wrong; one left-to-right pass, as the SDK does it, does not.
      const svc = build(
        { type: 'http', healthCheck: { url: 'https://api.acme.test/me', headers: { A: '$API_KEY', B: '$API' } } },
        async (key) => (key.endsWith('API_KEY') ? 'long-value' : 'short'),
      );
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      await svc.probe('u1', 'a@b.c', 'acme');

      const [, init] = vi.mocked(fetch).mock.calls[0];
      expect((init as RequestInit).headers).toEqual({ A: 'long-value', B: 'short' });
    });

    it('leaves a `$ref` string alone, exactly as UTCP does', async () => {
      const resolve = vi.fn(async () => 'sk-live-abc');
      const svc = build({ type: 'http', healthCheck: { url: 'https://api.acme.test/me', headers: { X: '{"$ref": "#/x"}' } } }, resolve);
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      await svc.probe('u1', 'a@b.c', 'acme');

      const [, init] = vi.mocked(fetch).mock.calls[0];
      expect((init as RequestInit).headers).toEqual({ X: '{"$ref": "#/x"}' });
    });
  });

  /**
   * The MCP handshake is the probe for an `mcp` tool — but `@utcp/mcp` caches
   * sessions on a MODULE-LEVEL singleton keyed only `<serverName>:<transport>`,
   * and hands back a cached session WITHOUT looking at the credential. A
   * throwaway client is therefore not a throwaway session, and probing under the
   * manual's own name would let a session opened with an EARLIER token answer
   * for a key that was just mistyped — reporting "Connected" for a wrong key,
   * which is the bug this module exists to remove.
   */
  describe('the MCP handshake probes the credential, not the session cache', () => {
    const mcpTool = () => build({ type: 'mcp', callTemplate: MCP_TEMPLATE });

    it('never dials under the manual’s own session key, and never twice under the same one', async () => {
      createClientMock.mockResolvedValue({});
      registerManualMock.mockResolvedValue({ ok: true });

      await mcpTool().probe('u1', 'a@b.c', 'acme');
      await mcpTool().probe('u2', 'a@b.c', 'acme');

      const keysOf = (call: number) =>
        Object.keys((registerManualMock.mock.calls[call][1] as unknown as { config: { mcpServers: Record<string, unknown> } }).config.mcpServers);
      const [first] = keysOf(0);
      const [second] = keysOf(1);

      expect(first).not.toBe('acme');
      expect(second).not.toBe('acme');
      // Two probes, two sessions: one user's probe must never be answered by
      // another's session, and a failing probe must not evict a live one.
      expect(first).not.toBe(second);
    });

    it('leaves the original template untouched, so the live session key is unchanged', async () => {
      createClientMock.mockResolvedValue({});
      registerManualMock.mockResolvedValue({ ok: true });

      await mcpTool().probe('u1', 'a@b.c', 'acme');

      expect(Object.keys((MCP_TEMPLATE as unknown as { config: { mcpServers: Record<string, unknown> } }).config.mcpServers)).toEqual(['acme']);
    });

    it('closes its session even when the handshake FAILED', async () => {
      // The failure case is the one that leaks: the client never saves a manual
      // it couldn't register, so `client.deregisterManual` finds nothing, while
      // the session — created before `listTools` was attempted — stays open.
      const deregisterManual = vi.fn(async () => {});
      const previous = CommunicationProtocol.communicationProtocols.mcp;
      CommunicationProtocol.communicationProtocols.mcp = { deregisterManual } as never;
      try {
        createClientMock.mockResolvedValue({});
        registerManualMock.mockResolvedValue({ ok: false, error: '401 Unauthorized' });

        const r = await mcpTool().probe('u1', 'a@b.c', 'acme');

        expect(r?.status).toBe('failed');
        expect(deregisterManual).toHaveBeenCalledTimes(1);
        // Deregistered under the SAME isolated key it dialled, or it would close
        // somebody else's session instead of its own.
        const closed = deregisterManual.mock.calls[0][1] as unknown as { config: { mcpServers: Record<string, unknown> } };
        const dialled = registerManualMock.mock.calls[0][1] as unknown as { config: { mcpServers: Record<string, unknown> } };
        expect(Object.keys(closed.config.mcpServers)).toEqual(Object.keys(dialled.config.mcpServers));
      } finally {
        CommunicationProtocol.communicationProtocols.mcp = previous;
      }
    });

    it('reports a non-auth registration failure as unverifiable, not as a bad key', async () => {
      createClientMock.mockResolvedValue({});
      registerManualMock.mockResolvedValue({ ok: false, error: 'ECONNREFUSED' });

      const r = await mcpTool().probe('u1', 'a@b.c', 'acme');

      expect(r?.status).toBe('unverifiable');
      expect(r?.detail).toMatch(/Couldn't reach the provider/);
    });

    it('is unverifiable when the manual produces no valid call template', async () => {
      const r = await build({ type: 'mcp', callTemplate: null }).probe('u1', 'a@b.c', 'acme');

      expect(r?.status).toBe('unverifiable');
      expect(r?.detail).toMatch(/couldn't be resolved/);
      expect(registerManualMock).not.toHaveBeenCalled();
    });

    it('prefers a DECLARED health check over the handshake, even for an mcp tool', async () => {
      // The author naming an endpoint is a stronger statement about how to test
      // their tool than any inference of ours.
      const svc = build({ type: 'mcp', callTemplate: MCP_TEMPLATE, healthCheck: DECLARED_PROBE });
      vi.mocked(fetch).mockResolvedValue(new Response('{}', { status: 200 }));

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r?.status).toBe('ok');
      expect(registerManualMock).not.toHaveBeenCalled();
    });
  });
});
