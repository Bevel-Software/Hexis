import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { applyHttpServerTimeouts, HTTP_KEEP_ALIVE_TIMEOUT_MS } from '../../index.js';

/**
 * The idle keep-alive a shell applies to its listening server. Pinned on a
 * real Node server, because the header and the idle cut are Node's, not ours.
 */

const servers: http.Server[] = [];

async function listening(): Promise<{ server: http.Server; port: number }> {
  const server = applyHttpServerTimeouts(
    http.createServer((_req, res) => {
      res.end('ok');
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe('applyHttpServerTimeouts', () => {
  it('sets the idle keep-alive to 120 seconds and leaves the headers and request timeouts at Node defaults', async () => {
    const untouched = http.createServer();
    const { server } = await listening();

    expect(HTTP_KEEP_ALIVE_TIMEOUT_MS).toBe(120_000);
    expect(server.keepAliveTimeout).toBe(120_000);
    expect(server.headersTimeout).toBe(untouched.headersTimeout);
    expect(server.requestTimeout).toBe(untouched.requestTimeout);
  });

  it('advertises the duration on a keep-alive response', async () => {
    const { port } = await listening();
    const agent = new http.Agent({ keepAlive: true });
    try {
      const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: '/', agent, headers: { connection: 'keep-alive' } }, (res) => {
            res.resume();
            res.on('end', () => resolve(res.headers));
          })
          .on('error', reject);
      });
      expect(headers.connection).toBe('keep-alive');
      expect(headers['keep-alive']).toBe('timeout=120');
    } finally {
      agent.destroy();
    }
  });

  it('serves a connection left idle past the old 5-second limit', { timeout: 15_000 }, async () => {
    const { port } = await listening();
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    let closedAt: number | null = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      received += chunk;
    });
    socket.on('close', () => {
      closedAt ??= Date.now();
    });
    await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject));

    const statusLines = () => received.match(/HTTP\/1\.1 200 OK\r\n/g)?.length ?? 0;
    const until = (done: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (done()) resolve();
          else if (closedAt !== null) reject(new Error(`socket closed; got: ${received}`));
        };
        socket.on('data', check);
        socket.on('close', check);
        check();
      });

    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await until(() => statusLines() === 1);

    await new Promise((resolve) => setTimeout(resolve, 6_000));
    expect(closedAt).toBeNull();

    socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await until(() => statusLines() === 2);
    socket.destroy();
  });
});
