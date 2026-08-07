/**
 * Copy text, and say whether it landed.
 *
 * `navigator.clipboard` is undefined outside a secure context (plain-HTTP
 * staging, some embedded webviews), and `writeText` rejects when the document
 * isn't focused. Both are ordinary conditions here, not exceptions — the
 * Library's copy buttons hand over an agent prompt the user can also just
 * select, so a failure has a real answer ("select the text instead") and must
 * never surface as a success toast.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = navigator.clipboard;
  if (!clipboard?.writeText) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** What a copy button tells the user, either way. */
export const COPIED_TOAST = 'Prompt copied.';
export const COPY_FAILED_TOAST = "Couldn't copy: select the prompt text instead.";

/**
 * The same pair for a LINK — the sidebar's `Copy link`. Separate strings
 * because the recovery differs: a prompt is on screen to be selected by hand,
 * a link to a row you are not standing on is not, so the honest advice is to
 * open the row and copy from the address bar.
 */
export const LINK_COPIED_TOAST = 'Link copied.';
export const LINK_COPY_FAILED_TOAST = "Couldn't copy: open the row and copy its address.";
