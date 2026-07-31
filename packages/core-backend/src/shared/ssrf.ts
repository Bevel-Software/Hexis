/**
 * Minimal SSRF guard for user-supplied outbound URLs. Rejects obvious
 * non-public targets (loopback, private, link-local, cloud-metadata) so an
 * authenticated user can't point a server-side fetch at internal services.
 *
 * Only catches LITERAL hosts/IPs — DNS-rebinding (a public name that resolves to
 * a private IP) is out of scope here; blunt that at fetch time / network layer.
 */
export function isBlockedHost(hostname: string): boolean {
  let host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // A trailing dot is the FQDN root and resolves identically: `localhost.` === `localhost`.
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  // IPv6 literals only: they contain a colon, whereas a plain hostname never does
  // — so domains like `fc.example.org` / `fd.example.com` are not matched.
  if (host.includes(':')) {
    // IPv4-mapped IPv6 connects to the embedded v4 — validate it. The textual
    // form may be dotted (`::ffff:169.254.169.254`) OR two hex hextets
    // (`::ffff:a9fe:a9fe`) — WHATWG `new URL` canonicalizes the mapped address
    // to the HEX form, so the dotted regex alone would miss a normalized
    // hostname. Handle both.
    const mappedDotted = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (mappedDotted && isBlockedV4(mappedDotted[1])) return true;
    const mappedHex = /:ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      const v4 = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
      if (isBlockedV4(v4)) return true;
    }
    if (host === '::1' || host === '::') return true; // loopback / unspecified
    // link-local fe80::/10 (fe80–febf) and unique-local fc00::/7 (fc/fd).
    if (/^fe[89ab]/.test(host) || host.startsWith('fc') || host.startsWith('fd')) return true;
    return false;
  }
  return isBlockedV4(host);
}

/** True for an IPv4 literal in a private / loopback / link-local (incl. cloud IMDS) range. */
function isBlockedV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 169 && b === 254) return true; // link-local (incl. cloud IMDS 169.254.169.254)
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10 (incl. Alibaba IMDS 100.100.100.200)
  return false;
}

/**
 * Parse + validate a user-supplied URL for a server-side fetch: must be http(s)
 * (or https only when `requireHttps`), and its literal host must not be a
 * blocked/internal target. Returns the parsed URL or throws a plain `Error`
 * (callers wrap it in a domain error). `label` names the field in the message.
 */
export function assertSafeFetchUrl(
  raw: string,
  opts: { requireHttps?: boolean; label?: string } = {},
): URL {
  const label = opts.label ?? 'URL';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (opts.requireHttps) {
    if (u.protocol !== 'https:') throw new Error(`${label} must use https`);
  } else if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${label} must be an http(s) URL`);
  }
  if (isBlockedHost(u.hostname)) throw new Error(`${label} host is not allowed`);
  return u;
}
