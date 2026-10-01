import { describe, test, expect } from 'vitest';
import { isBlockedHost, assertSafeFetchUrl } from '../ssrf.js';

describe('isBlockedHost', () => {
  test('blocks loopback / private / link-local / metadata', () => {
    for (const h of [
      'localhost', 'app.localhost', 'localhost.', '127.0.0.1', '0.0.0.0', '10.1.2.3', '192.168.1.1',
      '172.16.0.1', '169.254.169.254', '::1', '::', 'fe80::1', 'fe90::1', 'fc00::1', '::ffff:127.0.0.1',
      // CGNAT 100.64.0.0/10 — includes Alibaba Cloud's metadata endpoint.
      '100.64.0.1', '100.100.100.200', '100.127.255.255',
    ]) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  test('allows public hosts (incl. lookalikes)', () => {
    for (const h of ['api.example.com', 'github.com', 'fc.example.org', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1']) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });

  test('blocks IPv4-mapped IPv6 in the hex form new URL canonicalizes to', () => {
    // `new URL('http://[::ffff:169.254.169.254]/').hostname` === '[::ffff:a9fe:a9fe]'
    // — the mapped v4 is emitted as hex hextets, not dotted, so the guard must
    // decode the hex mapping and not just match a dotted tail.
    for (const h of ['[::ffff:a9fe:a9fe]', '::ffff:a9fe:a9fe', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:1']) {
      expect(isBlockedHost(h)).toBe(true);
    }
    // A public address in the same mapped-hex form stays allowed (8.8.8.8 → 0808:0808).
    expect(isBlockedHost('::ffff:808:808')).toBe(false);
    // Every other spelling of a mapped address is judged by its v4 too.
    for (const h of ['0:0:0:0:0:ffff:808:808', '0:0:0:0:0:ffff:8.8.8.8', '::ffff:8.8.8.8']) {
      expect(isBlockedHost(h)).toBe(false);
    }
    for (const h of ['0:0:0:0:0:ffff:a9fe:a9fe', '0:0:0:0:0:ffff:127.0.0.1', '0:0::ffff:a00:1']) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  test('blocks IPv6 literals outside global unicast, and allows global unicast', () => {
    for (const h of ['::2', '[::2]', '2001:db8::1', '2001:0db8::1', 'ff02::1', '100::1', '64:ff9b::a00:1', 'not:an:address', '2001::db8::1', '1:2:3:4:5:6:7:8:9', '::ffff:999.0.0.1']) {
      expect(isBlockedHost(h)).toBe(true);
    }
    // Special-purpose blocks inside 2000::/3: Teredo, ORCHID, benchmarking, the 3fff documentation range.
    for (const h of ['2001::1', '2001:1::1', '2001:2::1', '2001:1ff:ffff::1', '3fff::1', '3fff:fff::1']) {
      expect(isBlockedHost(h), h).toBe(true);
    }
    for (const h of ['2606:4700::1111', '[2a00:1450:4001::200e]', '2400:cb00::1', '2001:200::1', '2001:4860:4860::8888', '3fff:1000::1']) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });
});

describe('assertSafeFetchUrl', () => {
  test('accepts a public https URL', () => {
    expect(() => assertSafeFetchUrl('https://api.example.com/token', { requireHttps: true })).not.toThrow();
  });

  test('rejects http when https is required', () => {
    expect(() => assertSafeFetchUrl('http://api.example.com/token', { requireHttps: true })).toThrow(/https/);
  });

  test('rejects internal/metadata hosts (SSRF)', () => {
    expect(() => assertSafeFetchUrl('https://169.254.169.254/latest/meta-data/', { requireHttps: true })).toThrow(
      /not allowed/,
    );
    expect(() => assertSafeFetchUrl('https://localhost:8080/token', { requireHttps: true })).toThrow(/not allowed/);
  });

  test('rejects a non-URL', () => {
    expect(() => assertSafeFetchUrl('not a url')).toThrow(/valid URL/);
  });
});
