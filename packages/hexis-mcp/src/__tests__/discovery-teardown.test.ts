import { describe, expect, it, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { HexisMcpConfig } from '../config.js';

/**
 * The three edges where background discovery meets teardown and the operator
 * log — all of them created by moving discovery BEHIND the handshake, and none
 * of them reachable through the real deployment stub the other suites use:
 * they need a discovery that fails with EXACTLY a chosen message, or one that
 * never comes back at all.
 *
 * So the deployment module is mocked rather than served. What is under test is
 * `server.ts`'s own conduct once a fetch misbehaves, which is independent of
 * how that fetch was made — `answer-first.test.ts` covers the same paths
 * against a genuine HTTP deployment.
 */

/** Held by a test: `fetchAllManuals` does not answer until this resolves. */
let manualsGate: Promise<void> = Promise.resolve();
let releaseManuals: () => void = () => {};
/** When set, `fetchAllManuals` throws this instead of answering. */
let manualsThrow: Error | null = null;

function holdManuals(): void {
  manualsGate = new Promise<void>((resolve) => {
    releaseManuals = resolve;
  });
}

vi.mock('../deployment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../deployment.js')>();
  return {
    ...actual,
    resolveDeployment: async () => ({
      // Never dialled: every test here stops discovery at the manual list,
      // which is the phase before the client is built.
      mcpUrl: 'http://127.0.0.1:9/api/mcp',
      agentInstructions: false,
    }),
    fetchAllManuals: async () => {
      await manualsGate;
      if (manualsThrow) throw manualsThrow;
      return [];
    },
    fetchLocalOnlyManuals: async () => new Map(),
  };
});

const { DISCOVERY_NOTICE_TOOL, DISCOVERY_SHUTDOWN_GRACE_MS, createHexisMcpServer } = await import(
  '../server.js'
);

afterEach(() => {
  vi.restoreAllMocks();
  releaseManuals();
  manualsGate = Promise.resolve();
  manualsThrow = null;
});

/** Start the bridge with stderr captured and a real MCP client connected. */
async function start(): Promise<{
  handle: Awaited<ReturnType<typeof createHexisMcpServer>>;
  client: Client;
  stderr: string[];
}> {
  const stderr: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(' '));
  });
  const config: HexisMcpConfig = { baseUrl: 'http://127.0.0.1:9', connectionKey: 'bevel_test' };
  const handle = await createHexisMcpServer(config, '0.0.0');
  const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await handle.server.connect(serverTransport);
  await client.connect(clientTransport);
  return { handle, client, stderr };
}

describe('a discovery failure reaching the operator log', () => {
  /**
   * The reason is not ours: it comes off the network, through a deployment
   * (or a proxy in front of one) that chose the text. Written raw to stderr, a
   * newline in it starts a line of its own — a forged log entry — and a CSI
   * sequence paints the reader's terminal. The client-facing copy is a
   * different matter: it travels inside a JSON-RPC string, where the same
   * bytes are data and the reader needs them unmangled.
   */
  it('escapes a reason carrying newlines and terminal control bytes, and only on stderr', async () => {
    manualsThrow = new Error('gateway said no\n[hexis-mcp] forged line\u001b[31m');
    const s = await start();
    try {
      await s.handle.ready;

      const line = s.stderr.find((l) => l.includes('tool discovery failed:'));
      expect(line, 'the failure was never logged').toBeDefined();
      // ONE line, with the control bytes rendered rather than acted on.
      expect(line).not.toContain('\n');
      expect(line).not.toContain('\u001b');
      expect(line).toContain('\\n');
      expect(line).toContain('\\u001b');
      expect(line).toContain('gateway said no');

      // The client still gets the reason as it was said.
      const { tools } = await s.client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe(DISCOVERY_NOTICE_TOOL);
      expect(tools[0]!.description).toContain('gateway said no\n');
    } finally {
      await s.handle.shutdown();
    }
  });
});

describe('teardown landing in the middle of discovery', () => {
  /**
   * `closed` stops discovery at its next phase boundary, and that boundary is
   * a plain `return`: no error recorded, and nothing discovered. A `tools/list`
   * still in the transport then used to be answered with an EMPTY catalog —
   * indistinguishable, to whoever is reading it, from a correctly configured
   * workspace that has no tools. It is the very look `hexis_unavailable` was
   * introduced to prevent, arriving by another door.
   */
  it('tells a `tools/list` that the server is going away, not that the workspace is empty', async () => {
    holdManuals();
    const s = await start();
    // ORDER MATTERS, and it is the reason this reads the way it does. The
    // listing goes first and is given time to PARK on the gate, so its
    // handler is what resumes when discovery lets go. Shutting down first
    // would leave the client's rejection ambiguous: the transport closing
    // rejects a pending request too, with the same `ConnectionClosed` code,
    // and the test would then pass with the guard deleted. The MESSAGE is
    // asserted for the same reason — it is the half only the handler writes.
    const listing = s.client.listTools();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const shuttingDown = s.handle.shutdown();
    releaseManuals();

    await expect(listing).rejects.toMatchObject({
      code: ErrorCode.ConnectionClosed,
      message: expect.stringContaining('hexis-mcp is shutting down.'),
    });
    await shuttingDown;
  });

  /**
   * The bound on that wait. Phase BOUNDARIES stop discovery; the phase in
   * flight does not — a deployment fetch runs to its own timeout, a credential
   * swap drains for up to 15s — so `shutdown()` waiting for discovery to come
   * to rest is waiting on something uncancellable. The CLI has a watchdog for
   * that; an embedding host, which this handle is explicitly documented for,
   * has nothing. So the wait is capped, and what discovery builds afterwards
   * is released when it finally does come to rest.
   */
  it('does not wait out a discovery phase that never returns', { timeout: 30_000 }, async () => {
    holdManuals();
    const s = await start();
    try {
      const began = Date.now();
      await s.handle.shutdown();
      const waited = Date.now() - began;

      expect(waited).toBeGreaterThanOrEqual(DISCOVERY_SHUTDOWN_GRACE_MS - 250);
      expect(waited).toBeLessThan(DISCOVERY_SHUTDOWN_GRACE_MS + 5_000);
      expect(s.stderr.some((l) => l.includes('still in flight'))).toBe(true);
    } finally {
      releaseManuals();
    }
  });
});
