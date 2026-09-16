/**
 * The form Copy path puts on the clipboard: root-anchored, `/<kbDirName>/…`.
 *
 * Markdown reads a slash-less path as relative to the CURRENT file's folder,
 * so `knowledge-base/KnowledgeBase/x.md` pasted into a link in a subfolder
 * resolves to a doubled path and the page says File not found. The leading
 * slash anchors it at the workspace root, where it resolves from any folder.
 */
export function rootAnchoredPath(relativePath: string): string {
  return relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
}

/** `[` and `]` in a label would close the link early. */
function escapeLabel(label: string): string {
  return label.replace(/[[\]]/g, '\\$&');
}

/**
 * A destination with a space or a bracket goes in angle brackets
 * (`(<Some File.md>)`) — plain CommonMark, and the same form the renderer's
 * `escapeSpacesInLinkDestinations` produces.
 */
function destination(target: string): string {
  return /[\s()<>]/.test(target) ? `<${target}>` : target;
}

/** `Foo.md` → `Foo`; a dotfile or an extension-less name stays whole. */
function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * What pasting `clipboard` over `selection` should insert, or `null` for an
 * ordinary paste.
 *
 * Only a clipboard that is exactly ONE bare workspace path (`/<kbDirName>/…`,
 * spaces in folder names allowed) or ONE `http(s)` URL becomes a link. The
 * label is the selection when there is one; otherwise the file name without
 * its extension for a path, and host plus path for a URL. The path stays in
 * its root-anchored form, so the link works from any folder.
 */
export function markdownLinkForPaste(
  clipboard: string,
  kbDirName: string | null,
  selection = '',
): string | null {
  const text = clipboard.trim();
  if (!text || /[\r\n]/.test(text)) return null;

  if (kbDirName && text.startsWith(`/${kbDirName}/`)) {
    const name = text.replace(/\/+$/, '').split('/').pop() ?? '';
    if (!name || name === kbDirName) return null;
    // The link resolver splits at the first `#` and percent-decodes the rest,
    // so a literal `#` or `%` in a file name is encoded to survive both.
    const target = text.replace(/%/g, '%25').replace(/#/g, '%23');
    return `[${escapeLabel(selection || stem(name))}](${destination(target)})`;
  }

  if (/^https?:\/\/\S+$/i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    const label = selection || `${url.host}${url.pathname.replace(/\/+$/, '')}`;
    return `[${escapeLabel(label)}](${destination(text)})`;
  }

  return null;
}
