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
    const hextets = parseIPv6(host);
    // Not an address `new URL` would accept either — nothing to connect to.
    if (!hextets) return true;
    // IPv4-mapped (::ffff:0:0/96) connects to the embedded v4 — judge that.
    // Decoded from the hextets, so every spelling lands here: dotted
    // (`::ffff:169.254.169.254`), the hex form WHATWG `new URL` canonicalizes
    // to (`::ffff:a9fe:a9fe`) and the fully expanded `0:0:0:0:0:ffff:…`.
    if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
      const [hi, lo] = [hextets[6], hextets[7]];
      return isBlockedV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    // Everything else must be global unicast (2000::/3). That excludes loopback
    // and unspecified (`::1`, `::`, `::2`…), link-local fe80::/10, unique-local
    // fc00::/7 and multicast ff00::/8.
    if (hextets[0] < 0x2000 || hextets[0] > 0x3fff) return true;
    // Inside global unicast, the special-purpose blocks: 2001::/23 (Teredo,
    // ORCHID, the benchmarking range 2001:2::/48, …), documentation
    // 2001:db8::/32, and the newer documentation block 3fff::/20. None is a
    // real host to fetch from.
    if (hextets[0] === 0x2001 && (hextets[1] < 0x0200 || hextets[1] === 0x0db8)) return true;
    if (hextets[0] === 0x3fff && hextets[1] < 0x1000) return true;
    return false;
  }
  return isBlockedV4(host);
}

/**
 * The eight hextets of an IPv6 literal (`::` expanded, a dotted IPv4 tail
 * decoded), or null when it is not one. A zone id (`%eth0`) is ignored.
 */
function parseIPv6(literal: string): number[] | null {
  let text = literal.replace(/%.*$/, '');
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted.slice(2).map(Number);
    if (octets.some((o) => o > 255)) return null;
    text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = (half: string) => (half === '' ? [] : half.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
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
