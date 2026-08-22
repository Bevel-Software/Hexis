import { buildSandboxedHtml, sanitizeAgentHtml } from './htmlSandbox';
import type { EmailAttachmentView } from './emailMessage';

/**
 * Turn a message's HTML body into something safe to SHOW.
 *
 * The threat model for an email body is not the one for agent-authored HTML,
 * and it is worth stating because it decides every rule below. A message comes
 * from outside: the sender chose its markup, and two of the things a sender
 * may want are hostile to the reader.
 *
 *  - SCRIPT. Never runs. The frame is mounted `sandbox=""` — not
 *    `allow-scripts` like the agent-HTML renderer — so nothing in the message
 *    executes, and the CSP's `script-src` is moot rather than load-bearing.
 *  - THE TRACKING PIXEL. A remote image is a beacon: fetching it tells the
 *    sender the message was opened, when, from which address. `img-src data:`
 *    forbids every remote fetch, so the message renders without ever telling
 *    its sender it was read. Images the sender EMBEDDED (referenced `cid:`,
 *    carried in the file itself) are rewritten to `data:` URIs and do render —
 *    that is the fidelity worth having, and it costs no network at all.
 *
 * Links are the third case, and they get a different answer. A click cannot be
 * intercepted inside a script-free frame, so a live anchor would open its
 * destination with no chance to show the reader where it goes. Every anchor is
 * therefore made INERT and numbered, and its URL is handed back in `links` for
 * the parent to render in trusted UI — where the reader sees the whole address
 * before anything opens. Reverse-tabnabbing and referrer leakage stop being
 * possible rather than being mitigated.
 */

/** One link found in the body, numbered as the rendering marks it. */
export interface EmailLink {
  /** 1-based, matching the `[n]` marker shown after the link text. */
  index: number;
  /** The link's own text, trimmed and bounded. */
  text: string;
  /** Its full destination, exactly as written. */
  url: string;
}

export interface EmailBodyDocument {
  /** A complete document for `<iframe srcDoc>`; makes zero network requests. */
  srcDoc: string;
  /** Every link the body carried, in document order. */
  links: EmailLink[];
  /** How many images were dropped for pointing somewhere REMOTE. */
  blockedRemoteImages: number;
  /**
   * How many images the sender EMBEDDED but this viewer could not draw — the
   * part was missing from the file, or past the inline budget. Counted apart
   * from remote ones because the honest sentence differs: nothing was withheld
   * to protect the reader, the picture simply is not available.
   */
  unavailableInlineImages: number;
}

/** Schemes a link may name. Anything else is not shown as a link at all. */
const PRESENTABLE_SCHEMES = /^(https?|mailto):/i;

/** Elements that never belong in a rendered message, whatever the sender meant. */
const DROP = ['script', 'form', 'input', 'button', 'select', 'textarea', 'object', 'embed', 'iframe', 'link', 'meta', 'base'];

/** Longest link text kept for the panel — a whole paragraph inside an anchor is not a label. */
const MAX_LINK_TEXT = 200;

/** `data:` URI for an inline part, or undefined when its bytes were not retained. */
function dataUri(part: EmailAttachmentView): string | undefined {
  if (!part.bytes || part.bytes.length === 0) return undefined;
  let binary = '';
  // Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte part exceeds
  // the argument limit and throws.
  for (let i = 0; i < part.bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...part.bytes.subarray(i, i + 0x8000));
  }
  return `data:${part.mimeType ?? 'application/octet-stream'};base64,${btoa(binary)}`;
}

/** The `cid:` value an `<img src>` names, lowercased and unbracketed. */
function contentIdOf(src: string): string | undefined {
  const trimmed = src.trim();
  if (!/^cid:/i.test(trimmed)) return undefined;
  return trimmed.slice(4).replace(/^<|>$/g, '').toLowerCase();
}

export function buildEmailBody(html: string, attachments: readonly EmailAttachmentView[]): EmailBodyDocument {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  const inlineByCid = new Map<string, EmailAttachmentView>();
  for (const part of attachments) {
    if (part.contentId && part.bytes) inlineByCid.set(part.contentId.toLowerCase(), part);
  }

  // Images: the sender's own parts become data: URIs, everything remote goes.
  let blockedRemoteImages = 0;
  let unavailableInlineImages = 0;
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    const cid = contentIdOf(src);
    if (cid !== undefined) {
      const uri = inlineByCid.get(cid) && dataUri(inlineByCid.get(cid) as EmailAttachmentView);
      if (uri !== undefined) {
        img.setAttribute('src', uri);
        continue;
      }
      // Named a part this message does not carry, or one whose bytes the
      // inline budget declined to hold.
      img.remove();
      unavailableInlineImages += 1;
      continue;
    }
    if (src.trim().toLowerCase().startsWith('data:image/')) {
      continue; // already inline
    }
    img.remove();
    blockedRemoteImages += 1;
  }

  // Links: inert, numbered, and reported to the caller.
  const links: EmailLink[] = [];
  for (const anchor of Array.from(doc.querySelectorAll('a'))) {
    const href = (anchor.getAttribute('href') ?? '').trim();
    // Removed whatever it says: the sanitizer would strip it anyway, and an
    // anchor with no href cannot be followed even if a future change to the
    // frame's sandbox let it try.
    anchor.removeAttribute('href');
    anchor.removeAttribute('target');
    if (!PRESENTABLE_SCHEMES.test(href)) continue;
    const index = links.length + 1;
    links.push({ index, text: (anchor.textContent ?? '').trim().slice(0, MAX_LINK_TEXT), url: href });
    const marker = doc.createElement('sup');
    marker.textContent = `[${index}]`;
    anchor.after(marker);
  }

  for (const tag of DROP) {
    for (const el of Array.from(doc.querySelectorAll(tag))) el.remove();
  }

  // Event handlers go too. The shared sanitizer keeps them ON PURPOSE — it
  // serves agent HTML, which is allowed to run its own scripts — and the frame
  // here forbids scripts outright, so an `onerror` could not fire. Removing
  // them anyway means the document does not merely fail to execute an attack;
  // it does not carry one.
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name);
    }
  }

  return {
    // Through the shared sanitizer as well: it enforces the URL policy this
    // function relies on (`data:image/` and nothing else) and strips event
    // handlers, so a gap here cannot become a rendered attack.
    srcDoc: buildSandboxedHtml({
      title: 'Message',
      libModuleSources: [],
      includeRuntime: false,
      // The WHOLE document, not `body.innerHTML`: mail routinely puts its CSS
      // in `<head><style>`, and the sanitizer hoists that into the body before
      // serializing. Passing the body alone silently dropped the styling of
      // every message written the ordinary way.
      bodyHtml: sanitizeAgentHtml(doc.documentElement.outerHTML),
    }),
    links,
    blockedRemoteImages,
    unavailableInlineImages,
  };
}
