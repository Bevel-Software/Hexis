/**
 * Whether a window message is an Escape handed up by a page's frame inside
 * `surface` (`bevel.key`, posted by the sandbox's key bridge in
 * `htmlSandbox.ts`) — the one kind the full-screen view acts on. A message
 * from any other window, or of any other shape, is not.
 *
 * Closes over nothing, so the real-browser suite can load it into a page from
 * its source and hold it to a real sandboxed frame's `postMessage`.
 */
export function isFrameEscape(e: MessageEvent, surface: Element | null): boolean {
  const msg = e.data as { type?: unknown; key?: unknown } | null;
  if (!msg || typeof msg !== 'object' || msg.type !== 'bevel.key' || msg.key !== 'Escape') return false;
  if (!e.source || !surface) return false;
  return Array.from(surface.querySelectorAll('iframe')).some((f) => f.contentWindow === e.source);
}
