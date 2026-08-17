import { useState } from 'react';
import { Link2, Check } from 'lucide-react';

/**
 * Copy text to the clipboard. Prefers the async Clipboard API; falls back to a
 * hidden-textarea `execCommand('copy')` for contexts where the Clipboard API is
 * blocked by Permissions Policy (e.g. some embedded iframes).
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    let ta: HTMLTextAreaElement | null = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      // Always remove the textarea, even if select()/execCommand threw.
      if (ta?.parentNode) document.body.removeChild(ta);
    }
  }
}

/**
 * Hover-revealed "copy link to this heading" button — mirrors the FileViewer's
 * "copy link to this file" affordance (same `Link2` icon + 1.5s copied state),
 * but copies the heading's deep-link (URL + `#slug`) so a reader can cite a
 * specific section.
 *
 * Lives in its own module because the heading renderer that mounts it moved to
 * `kbMarkdownPipeline`, which is shared with the diff viewer.
 */
export function CopyAnchorButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.preventDefault();
        if (await copyToClipboard(url)) {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        } else {
          console.error('Failed to copy heading link');
        }
      }}
      // `align-middle` keeps it on the heading baseline; hidden until the
      // heading is hovered (or the button is focused for keyboard users).
      className="ml-1.5 inline-flex align-middle p-0.5 rounded-xs text-ink-faint no-underline opacity-0 transition-opacity hover:bg-hover hover:text-ink focus:opacity-100 group-hover/anchor:opacity-100"
      title={copied ? 'Link copied' : 'Copy link to this heading'}
      aria-label="Copy link to this heading"
    >
      {copied ? <Check size={13} /> : <Link2 size={13} />}
    </button>
  );
}
