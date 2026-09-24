import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { agentDisplayName, agentStoreKey, holdInitialize, registrationName } from '../handshake.js';

describe('agent names', () => {
  it('names the well-known clients the way a person does, and title-cases the rest', () => {
    expect(agentDisplayName({ name: 'claude-code', version: '2.0.1' })).toBe('Claude Code');
    expect(agentDisplayName({ name: 'Cursor-VSCode' })).toBe('Cursor');
    expect(agentDisplayName({ name: 'codex-mcp-client' })).toBe('Codex');
    expect(agentDisplayName({ name: 'my_custom-agent' })).toBe('My Custom Agent');
    expect(agentDisplayName({ name: '   ' })).toBe('Unknown agent');
  });

  it('registers as the agent on this machine, or as the plain machine name when no agent is known', () => {
    expect(registrationName({ name: 'claude-code' }, 'LAPTOP-1')).toBe('Claude Code · local server on LAPTOP-1');
    expect(registrationName(null, 'LAPTOP-1')).toBe('hexis-mcp on LAPTOP-1');
  });

  it('keys the stored credential by a bounded, file-safe slug of the raw name', () => {
    expect(agentStoreKey({ name: 'claude-code' })).toBe('claude-code');
    expect(agentStoreKey({ name: 'Visual Studio Code' })).toBe('visual-studio-code');
    expect(agentStoreKey({ name: '../../etc' })).toBe('etc');
    expect(agentStoreKey({ name: 'x'.repeat(80) })).toHaveLength(40);
    expect(agentStoreKey({ name: '!!!' })).toBe('agent');
  });
});

/** A transport whose messages the test injects and whose sends it reads. */
function fakeTransport() {
  const sent: JSONRPCMessage[] = [];
  let started = 0;
  const transport: Transport & { deliver(message: JSONRPCMessage): void; hangUp(): void } = {
    async start() {
      started += 1;
      if (started > 1) throw new Error('already started');
    },
    async send(message) {
      sent.push(message);
    },
    async close() {},
    deliver(message) {
      this.onmessage?.(message);
    },
    hangUp() {
      this.onclose?.();
    },
  };
  return { transport, sent, startedTimes: () => started };
}

const INITIALIZE: JSONRPCMessage = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.0.1' } },
};

describe('holdInitialize', () => {
  it('starts the transport, reads the agent off the first message, and replays it to the server once it listens', async () => {
    const { transport, sent, startedTimes } = fakeTransport();
    const pending = holdInitialize(transport);
    // Started at once — the client is already writing to stdin.
    expect(startedTimes()).toBe(1);
    transport.deliver(INITIALIZE);
    // Anything after it, before a server exists, is held in order too.
    transport.deliver({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const held = await pending;
    expect(held.agent).toEqual({ name: 'claude-code', version: '2.0.1' });
    // Nothing answered yet: no server has seen the request.
    expect(sent).toHaveLength(0);

    // A real SDK server connects to the wrapper exactly as it would to stdio
    // — and gets the held initialize, which it answers through the same pipe.
    const server = new Server({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await server.connect(held.transport);
    // The replay hands the request to the server; its answer is written a tick later.
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: 1, result: { serverInfo: { name: 'test' } } });
    expect(server.getClientVersion()).toEqual({ name: 'claude-code', version: '2.0.1' });
    // The inner transport was started ONCE; the wrapper's start is the replay.
    expect(startedTimes()).toBe(1);
    // And what arrives afterwards flows straight through.
    transport.deliver({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ id: 2, result: {} });
  });

  it('resolves with no agent when the first message is not an initialize, or names no client', async () => {
    const a = fakeTransport();
    const pendingA = holdInitialize(a.transport);
    a.transport.deliver({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect((await pendingA).agent).toBeNull();

    const b = fakeTransport();
    const pendingB = holdInitialize(b.transport);
    b.transport.deliver({ ...INITIALIZE, params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: '' } } });
    expect((await pendingB).agent).toBeNull();
  });

  it('resolves with no agent when the client hangs up before saying anything', async () => {
    const { transport } = fakeTransport();
    const pending = holdInitialize(transport);
    transport.hangUp();
    expect((await pending).agent).toBeNull();
  });

  it('completes a real handshake end to end: the client sees its initialize answered after the hold', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'cursor-vscode', version: '1.4.0' }, { capabilities: {} });
    // The client starts its handshake and waits on the answer, as an agent does.
    const connecting = client.connect(clientTransport);
    const held = await holdInitialize(serverTransport);
    expect(held.agent).toEqual({ name: 'cursor-vscode', version: '1.4.0' });
    // "Sign-in" happens here, with the name in hand; then the server exists.
    const server = new Server({ name: 'hexis-mcp', version: '0.0.0' }, { capabilities: {} });
    await server.connect(held.transport);
    await connecting;
    expect(client.getServerVersion()).toEqual({ name: 'hexis-mcp', version: '0.0.0' });
    await client.close();
    await server.close();
  });
});
