/**
 * Copy text, and say whether it landed.
 *
 * `navigator.clipboard` is undefined outside a secure context (plain-HTTP
 * staging, some embedded webviews), and `writeText` rejects when the document
 * isn't focused. Both are ordinary conditions, not exceptions — a copy button
 * hands over something the user can also select by hand, so a failure has a
 * real answer and must never surface as success.
 *
 * Lives in `lib/` because more than one module needs it: the Library's copy
 * buttons and the email viewer's link list.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // `navigator` itself is undefined off the browser (SSR, a test runner with
  // no DOM): reading through it would THROW rather than answer false, which is
  // the one thing this function promises not to do.
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
