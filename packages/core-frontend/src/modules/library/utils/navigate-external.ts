/**
 * Leave the SPA for an absolute URL — the OAuth provider's authorization page.
 *
 * A one-line module rather than an inline `window.location.href = url`, for one
 * reason: happy-dom treats a location assignment as a real navigation, so a
 * test that exercises the sign-in path either warns or blows up. Behind a
 * module boundary the whole thing is one `vi.mock` away, and the assertion
 * becomes "we sent the user to the URL the server gave us" instead of "we
 * poked window.location".
 *
 * Never call this with a path — `navigate()` from react-router owns those.
 */
export function navigateExternal(url: string): void {
  window.location.href = url;
}
