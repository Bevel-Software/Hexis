/**
 * The rules about the deployment preamble's TEXT that both sides need to
 * agree on: the file it lives in, the caps it is cut at, and what counts as a
 * private comment inside it.
 *
 * These lived in the backend composer and were mirrored by hand in the
 * frontend editor, whose own comment said so. The two are not free to differ:
 * the editor decides what an admin is shown and what it writes back, the
 * composer decides what agents receive, and a drift between them shows the
 * admin one description while agents get another.
 *
 * Pure: no IO, no clock, no platform assumptions.
 */

/** The repository-root file an admin edits. */
export const PREAMBLE_FILE = 'mcp-description.md';

/**
 * UTF-16 units of preamble sent on the handshake before the marker replaces
 * the rest.
 *
 * 1,800 (it was 6,000) so the whole handshake fits the length Claude Code
 * keeps of a server's instructions (`INSTRUCTIONS_CAP` in the backend
 * composer, 4,096): past it the client cut the text, and a description that
 * followed the platform's opening never arrived. The backend test holds the
 * platform opening with the longest default-branch name, this cap and the
 * truncation marker under that length.
 */
export const PREAMBLE_CAP = 1_800;

/** UTF-16 units of the whole tool prefix (fixed line included). */
export const TOOL_PREFIX_CAP = 300;

/**
 * Remove every `<!-- … -->` block.
 *
 * A `<!--` that is never closed takes the rest of the text with it and is
 * reported, so a caller can warn: that is the fail-closed half of the rule,
 * and it is why an admin's private note cannot leak through the likeliest
 * editing slip. The editor strips the same blocks to decide what to show, and
 * closes an unterminated one when it writes back.
 */
export function stripHtmlComments(text: string): { text: string; unterminated: boolean } {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('<!--', from);
    if (open === -1) {
      out += text.slice(from);
      return { text: out, unterminated: false };
    }
    out += text.slice(from, open);
    const close = text.indexOf('-->', open + 4);
    if (close === -1) return { text: out, unterminated: true };
    from = close + 3;
  }
}
