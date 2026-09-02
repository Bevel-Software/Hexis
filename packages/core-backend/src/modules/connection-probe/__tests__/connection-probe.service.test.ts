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

const { ConnectionProbeService, readCapped } = await import('../connection-probe.service.js');

const DECLARED_PROBE: ToolHealthCheck = {
  url: 'https://api.acme.test/me',
  headers: { Authorization: 'Bearer ${API_KEY}' },
};

const MCP_TEMPLATE = {
  name: 'acme',
  call_template_type: 'mcp',
  config: { mcpServers: { acme: { transport: 'http', url: 'https://mcp.acme.test' } } },
} as unknown as CallTemplate;

/** The shape a real remote MCP manual has: a url and a credential in a header. */
const MCP_TEMPLATE_WITH_KEY = {
  name: 'acme',
  call_template_type: 'mcp',
  config: {
    mcpServers: {
      acme: {
        transport: 'http',
        url: 'https://mcp.acme.test',
        headers: { Authorization: 'Bearer ${API_KEY}' },
      },
    },
  },
} as unknown as CallTemplate;

const TEMPLATED_HOST = {
  name: 'acme',
  call_template_type: 'mcp',
  config: { mcpServers: { acme: { transport: 'http', url: 'https://${HOST}/mcp' } } },
} as unknown as CallTemplate;

const serversOf = (template: unknown) =>
  (template as { config: { mcpServers: Record<string, { url?: string }> } }).config.mcpServers;

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
const mcpTool = () => build({ type: 'mcp', callTemplate: MCP_TEMPLATE });

/** Long enough to be redactable, and shaped like the keys providers echo. */
const SECRET = 'sk-live-supersecret-1234';

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

    it('a 401 that only appears inside a URL accuses nobody', async () => {
      // `fetch failed: https://mcp.example.com/v1/401/stream` carries the
      // digits in a PATH — the provider said nothing about the credential.
      const deregisterManual = vi.fn(async () => {});
      const previous = CommunicationProtocol.communicationProtocols.mcp;
      CommunicationProtocol.communicationProtocols.mcp = { deregisterManual } as never;
      try {
        createClientMock.mockResolvedValue({});
        registerManualMock.mockResolvedValue({
          ok: false,
          error: 'fetch failed: https://mcp.example.com/v1/401/stream — socket hang up',
        });

        const r = await mcpTool().probe('u1', 'a@b.c', 'acme');

        expect(r?.status).toBe('unverifiable');
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

    /**
     * The parse-time guard cannot see a templated host, exactly as for the
     * declared probe — and `@utcp/mcp`'s own `ensureSecureMcpUrl` is no
     * substitute: it checks the SCHEME, so `https://169.254.169.254` sails
     * through it. Without a re-check here, clicking Test connection on such a
     * manual reaches the metadata endpoint.
     */
    it('refuses to dial an internal host the server url resolved to', async () => {
      const svc = build({ type: 'mcp', callTemplate: TEMPLATED_HOST }, async () => '169.254.169.254');
      createClientMock.mockResolvedValue({});
      registerManualMock.mockResolvedValue({ ok: true });

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r?.status).toBe('unverifiable');
      expect(registerManualMock).not.toHaveBeenCalled();
      expect(createClientMock).not.toHaveBeenCalled();
    });

    it('still dials a templated host that resolves somewhere public', async () => {
      const svc = build({ type: 'mcp', callTemplate: TEMPLATED_HOST }, async () => 'mcp.acme.test');
      createClientMock.mockResolvedValue({});
      registerManualMock.mockResolvedValue({ ok: true });

      expect((await svc.probe('u1', 'a@b.c', 'acme'))?.status).toBe('ok');
      expect(registerManualMock).toHaveBeenCalledTimes(1);
    });

    /**
     * The guard and the handshake have to see the SAME bytes. Checking
     * `https://${HOST}/mcp` and then handing UTCP the template back leaves the
     * vault free to answer differently the second time, so a concurrent
     * `PUT …/vars/HOST` landing in that gap aims the handshake wherever it
     * likes — with the guard's approval behind it.
     */
    it('registers the url it CHECKED, not the template that produced it', async () => {
      const svc = build({ type: 'mcp', callTemplate: TEMPLATED_HOST }, async () => 'mcp.acme.test');
      createClientMock.mockResolvedValue({});
      registerManualMock.mockResolvedValue({ ok: true });

      await svc.probe('u1', 'a@b.c', 'acme');

      const dialled = Object.values(serversOf(registerManualMock.mock.calls[0][1]))[0];
      expect(dialled.url).toBe('https://mcp.acme.test/mcp');
      // The manual's own template is untouched — only the probe's clone resolves.
      expect(serversOf(TEMPLATED_HOST).acme.url).toBe('https://${HOST}/mcp');
    });

    /**
     * A handshake that outlives the deadline is abandoned, not cancelled — and
     * `@utcp/mcp` caches its session only AFTER `connect()` resolves. So the
     * verdict's own cleanup runs while there is nothing yet to close, and the
     * session appears moments later with nobody holding it: one live session
     * leaked per probe against a slow server, on every save and every click.
     */
    it('closes the session a slow handshake opens AFTER the probe gave up', async () => {
      vi.useFakeTimers();
      const deregisterManual = vi.fn(async () => {});
      const previous = CommunicationProtocol.communicationProtocols.mcp;
      CommunicationProtocol.communicationProtocols.mcp = { deregisterManual } as never;
      try {
        createClientMock.mockResolvedValue({});
        let finishHandshake: (result: unknown) => void = () => {};
        registerManualMock.mockReturnValue(
          new Promise((resolve) => {
            finishHandshake = resolve;
          }),
        );

        const pending = mcpTool().probe('u1', 'a@b.c', 'acme');
        await vi.advanceTimersByTimeAsync(11_000);
        const r = await pending;

        expect(r?.status).toBe('unverifiable');
        expect(r?.detail).toMatch(/didn't answer within/);
        // One close so far, and it found nothing: the session does not exist yet.
        expect(deregisterManual).toHaveBeenCalledTimes(1);

        finishHandshake({ ok: true });
        await vi.advanceTimersByTimeAsync(0);

        // The late-settle owner. Without it this session stays open forever.
        expect(deregisterManual).toHaveBeenCalledTimes(2);
        expect(Object.keys(serversOf(deregisterManual.mock.calls[1][1]))).toEqual(
          Object.keys(serversOf(registerManualMock.mock.calls[0][1])),
        );
      } finally {
        CommunicationProtocol.communicationProtocols.mcp = previous;
        vi.useRealTimers();
      }
    });

    it('does not quote the credential back from a rejected handshake', async () => {
      const svc = build({ type: 'mcp', callTemplate: MCP_TEMPLATE_WITH_KEY }, async () => SECRET);
      createClientMock.mockResolvedValue({});
      registerManualMock.mockResolvedValue({
        ok: false,
        error: `401 Unauthorized: {"message":"bad token ${SECRET}"}`,
      });

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r?.status).toBe('failed');
      expect(r?.detail).not.toContain(SECRET);
      expect(r?.detail).toContain('[redacted]');
    });
  });

  /**
   * Anyone who can READ a tool can probe it, and providers routinely echo the
   * key they refused. Quoting that body verbatim hands a plain reader part of a
   * shared ADMIN credential they were never allowed to see — the 200-character
   * cap bounds the quote, it does not redact it.
   */
  describe('the quoted rejection cannot carry the credential back out', () => {
    it('redacts the credential the provider echoed in full', async () => {
      const svc = build({ type: 'http', healthCheck: DECLARED_PROBE }, async () => SECRET);
      vi.mocked(fetch).mockResolvedValue(
        new Response(`Incorrect API key provided: ${SECRET}. Check your key at acme.test.`, { status: 401 }),
      );

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r?.status).toBe('failed');
      expect(r?.detail).not.toContain(SECRET);
      expect(r?.detail).toContain('[redacted]');
      // The actionable half of the provider's sentence still survives — that is
      // the whole reason the body is quoted at all.
      expect(r?.detail).toContain('Check your key at acme.test.');
    });

    it('redacts a TRUNCATED echo, which is the usual shape of one', async () => {
      const svc = build({ type: 'http', healthCheck: DECLARED_PROBE }, async () => SECRET);
      vi.mocked(fetch).mockResolvedValue(
        new Response(`Incorrect API key provided: ${SECRET.slice(0, 14)}****`, { status: 401 }),
      );

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      // A whole-value search finds nothing here and prints the head of the key.
      expect(r?.detail).not.toContain(SECRET.slice(0, 14));
      expect(r?.detail).toContain('[redacted]');
    });

    /**
     * Redacting a short secret before a long one that starts with it consumes
     * the long one's head and prints its tail — the half-redaction this class
     * exists to prevent, reached from the other direction. Set iteration is
     * insertion order, and the url is substituted before the headers, so
     * putting the shorter value in the url makes that order deterministic.
     */
    it('redacts a secret that another secret is a prefix of, whole', async () => {
      const short = 'sk-live-abc123';
      const long = `${short}-456789`;
      const svc = build(
        {
          type: 'http',
          healthCheck: {
            url: 'https://api.acme.test/me?v=${SHORTKEY}',
            headers: { Authorization: 'Bearer ${LONGKEY}' },
          },
        },
        async (key) => (key.includes('SHORTKEY') ? short : long),
      );
      vi.mocked(fetch).mockResolvedValue(
        new Response(`Incorrect API key provided: ${long}. Check your key.`, { status: 401 }),
      );

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r?.detail).not.toContain('456789');
      expect(r?.detail).toContain('Check your key.');
    });

    /**
     * A `.tool` may write its token inline instead of through a `${VAR}`, which
     * is why `ToolManualSummary` withholds `headers` from the browser at all.
     * Substitution never sees such a value, so before this the one credential a
     * reader could not otherwise reach was the one a 401 could quote back.
     */
    it('redacts a token the manual wrote out in full, not only one from the vault', async () => {
      const literal = 'sk-live-written-into-the-file';
      const svc = build({
        type: 'http',
        healthCheck: { url: 'https://api.acme.test/me', headers: { Authorization: `Bearer ${literal}` } },
      });
      vi.mocked(fetch).mockResolvedValue(
        new Response(`Incorrect API key provided: ${literal}. Check your key at acme.test.`, { status: 401 }),
      );

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r?.status).toBe('failed');
      expect(r?.detail).not.toContain(literal);
      expect(r?.detail).toContain('Check your key at acme.test.');
    });

    it('redacts a literal token an mcp manual carries on its server headers', async () => {
      const literal = 'sk-live-mcp-in-the-file';
      const template = {
        name: 'acme',
        call_template_type: 'mcp',
        config: {
          mcpServers: {
            acme: { transport: 'http', url: 'https://mcp.acme.test', headers: { Authorization: `Bearer ${literal}` } },
          },
        },
      } as unknown as CallTemplate;
      createClientMock.mockResolvedValue({});
      registerManualMock.mockResolvedValue({ ok: false, error: `401 Unauthorized: bad token ${literal}` });

      const r = await build({ type: 'mcp', callTemplate: template }).probe('u1', 'a@b.c', 'acme');

      expect(r?.status).toBe('failed');
      expect(r?.detail).not.toContain(literal);
    });

    it('redacts a literal token the manual put in the query string', async () => {
      const literal = 'sk-live-in-the-query-string';
      const svc = build({
        type: 'http',
        healthCheck: { url: `https://api.acme.test/me?api_key=${literal}` },
      });
      vi.mocked(fetch).mockResolvedValue(
        new Response(`Incorrect API key provided: ${literal}`, { status: 401 }),
      );

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r?.detail).not.toContain(literal);
    });

    /**
     * A signed url grants access exactly as a bearer token does — the secret is
     * what derived the signature, and the signature is what travels. `sig` is
     * matched only as a whole word, since inside one it would swallow `design`.
     */
    it('redacts a signature, and leaves a word that merely contains "sig" alone', async () => {
      const signature = 'a3f9c1e77b2d4406b8e15c9f0d3a7e42';
      const design = 'lakeside-revision-7';
      const svc = build({
        type: 'http',
        healthCheck: { url: `https://api.acme.test/me?sig=${signature}&design=${design}` },
      });
      vi.mocked(fetch).mockResolvedValue(
        new Response(`Signature ${signature} is not valid for design ${design}`, { status: 401 }),
      );

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r?.detail).not.toContain(signature);
      expect(r?.detail).toContain(design);
    });

    /**
     * The other half of the bargain: the quote is only worth having because it
     * carries the provider's own words, so a header that is a description of
     * the request rather than a credential must survive it.
     */
    it('leaves a header that is not a credential in the message', async () => {
      const accept = 'application/vnd.acme.v3+json';
      const svc = build({
        type: 'http',
        healthCheck: { url: 'https://api.acme.test/me', headers: { Accept: accept } },
      });
      vi.mocked(fetch).mockResolvedValue(new Response(`Unsupported Accept: ${accept}`, { status: 401 }));

      const r = await svc.probe('u1', 'a@b.c', 'acme');

      expect(r?.detail).toContain(accept);
    });
  });

  /**
   * The rejecting body is written by whatever server the credential points at,
   * so how much of it we read is that server's choice unless we bound it.
   */
  it('quotes a rejection without swallowing an unbounded body', async () => {
    const huge = 'x'.repeat(5_000_000);
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Endless: only the read cap can stop this.
        controller.enqueue(new TextEncoder().encode(huge));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.mocked(fetch).mockResolvedValue(new Response(body, { status: 401 }));

    const r = await httpTool().probe('u1', 'a@b.c', 'acme');

    expect(r?.status).toBe('failed');
    // 200 chars of quote plus the ellipsis and the fixed prefix — not 5MB.
    expect(r?.detail!.length).toBeLessThan(400);
    expect(cancelled).toBe(true);
  });

  /**
   * The cap has to bound what is DECODED, not merely how many times we loop.
   * Counting a chunk against the budget after decoding it lets a provider that
   * answers in one huge chunk put the whole thing through the decoder — the
   * bound bypassed by exactly the party it exists to bound. Asserted on
   * `readCapped` directly because the caller's 200-character snippet is
   * identical either way, which is how the first version of this passed.
   */
  it('holds one oversized chunk to the byte budget, not just the loop', async () => {
    const oneHugeChunk = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(5_000_000)));
        controller.close();
      },
    });

    const out = await readCapped(new Response(oneHugeChunk), 8 * 1024);

    expect(out.length).toBe(8 * 1024);
  });
});
