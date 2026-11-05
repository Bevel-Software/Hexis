// The implementation moved to `lib/clipboard.ts` when the email viewer needed
// it too; re-exported here so the Library keeps importing its copy helper and
// its toast strings from one place.
export { copyToClipboard } from '../../../lib/clipboard';

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
