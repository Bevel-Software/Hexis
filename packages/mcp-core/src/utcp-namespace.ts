/**
 * The key UTCP uses to look up a manual's `${VAR}`. `@utcp/sdk` first SANITIZES
 * the manual name — every non-word char (`-`, `.`, spaces, …) becomes `_`
 * (`manualCallTemplate.name.replace(/[^\w]/g, "_")` at registration) — and then
 * namespaces variables under `<namespace>_<VAR>` where every `_` in the
 * sanitized namespace is DOUBLED (the variable substitutor), so `my_tool` + `KEY`
 * → `my__tool_KEY` and `my-tool` + `KEY` → the very same `my__tool_KEY`. Our
 * secret storage AND scope resolution must derive the exact same key. For an
 * alphanumeric name (no `_`, no punctuation) this reduces to `<name>_<VAR>`,
 * so plain tool names are unaffected.
 */
export function utcpNamespacePrefix(manualName: string): string {
  return `${manualName.replace(/[^\w]/g, '_').replace(/_/g, '__')}_`;
}

export function utcpNamespacedKey(manualName: string, varName: string): string {
  return `${utcpNamespacePrefix(manualName)}${varName}`;
}

/**
 * The origin template WE mint for every Bevel-hosted manual's discovery URL
 * (`${API_URL}/api/…`). `${API_URL}` expands to the loopback origin, so a
 * Bevel-hosted URL always has this exact string as its scheme+authority.
 */
const LOOPBACK_ORIGIN_TEMPLATE = '${API_URL}';

/**
 * True only when `${API_URL}` is the URL's ORIGIN (scheme+authority) — the shape
 * we ourselves produce for a Bevel-hosted manual. A third-party `.tool` author
 * can embed the literal `${API_URL}` anywhere in a path or query
 * (`http://evil.example/?x=${API_URL}`) but can NOT make it the authority without
 * pointing the request back at our own loopback, so anchoring the trust decision
 * to the origin is what a user `.tool`'s URL text cannot forge.
 */
function isBevelHostedUrl(url: string): boolean {
  if (!url.startsWith(LOOPBACK_ORIGIN_TEMPLATE)) return false;
  // The char right after the origin must delimit the authority; anything else
  // (`${API_URL}.evil.com`, `${API_URL}evil`) is a different, untrusted host.
  const next = url.charAt(LOOPBACK_ORIGIN_TEMPLATE.length);
  return next === '' || next === '/' || next === '?' || next === '#';
}

/**
 * Seed the loopback discovery vars (`<ns>_API_URL` + `<ns>_CONNECTION_KEY`) for
 * every Bevel-HOSTED manual in `manuals` — one whose discovery `url` targets our
 * own backend with `${API_URL}` as its ORIGIN (the KB manual and inline `.tool`
 * sub-manuals). A third-party http/mcp `.tool` points at an arbitrary URL, so it
 * is deliberately NOT seeded: handing it `connectionKey` would leak the bearer to
 * that endpoint. Keying off the origin (not a bare `includes('${API_URL}')`) is
 * deliberate — an `http` `.tool`'s URL is author-controlled, so a substring match
 * would let `http://attacker/?x=${API_URL}` be seeded the bearer and exfiltrate
 * it. This is the exfiltration-safe seeding rule shared by the external MCP proxy
 * and the in-process agent factory, so the bearer-leak decision is written ONCE.
 */
export function seedBevelHostedManualVars(
  manuals: readonly { name?: unknown; url?: unknown }[],
  loopbackBaseUrl: string,
  connectionKey: string,
): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const m of manuals) {
    const name = typeof m.name === 'string' ? m.name : '';
    if (!name) continue;
    const url = (m as { url?: unknown }).url;
    if (typeof url !== 'string' || !isBevelHostedUrl(url)) continue;
    variables[utcpNamespacedKey(name, 'API_URL')] = loopbackBaseUrl;
    variables[utcpNamespacedKey(name, 'CONNECTION_KEY')] = connectionKey;
  }
  return variables;
}
