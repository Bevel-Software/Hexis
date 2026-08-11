/**
 * Sanitizer for mammoth's `.docx` → HTML output, applied before that HTML is
 * injected into the APP ORIGIN (see `DocxRenderer`).
 *
 * Why this exists: mammoth is a CONVERTER, not a sanitizer. It never emits a
 * `<script>` because OOXML has no such element — but a hyperlink's target is
 * copied verbatim out of the document's relationship table
 * (`docx/body-reader.js`), passed straight into the anchor's attributes
 * (`document-to-html.js`), and its writer escapes only `& " < >`, which
 * prevents attribute breakout while leaving a `javascript:` scheme intact. A
 * `.docx` whose hyperlink points at `javascript:…` therefore renders as a
 * live script URL in this origin, one click from the reader's session. The
 * markdown renderer already closes exactly this hole with `rehypeSanitize`
 * (whose default schema enforces a protocol allowlist); this is the same
 * guarantee for the docx path.
 *
 * The rule is a URL-scheme allowlist, not a blocklist: anything that is not
 * demonstrably safe to navigate to is dropped. Event-handler attributes are
 * stripped too — mammoth does not emit them today, but that is an internal
 * detail of a dependency, and this function's contract should not rest on it.
 */

/** Schemes a link may navigate to. Everything else is dropped. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

/** Attributes that carry a URL and therefore need scheme checking. */
const URL_ATTRIBUTES = ['href', 'src', 'xlink:href', 'action', 'formaction'];

/**
 * Characters a browser IGNORES while parsing a URL: whitespace and control
 * characters (`\p{Cc}` covers C0 and C1). They must be removed before the
 * scheme is read, or a tab-separated `java<TAB>script:alert(1)` — and a
 * leading-space `  javascript:alert(1)` — sail past a check that the browser
 * then happily navigates.
 */
const URL_IGNORED_CHARS = /[\s\p{Cc}]/gu;

/**
 * Whether `raw` is safe to leave in a URL attribute.
 *
 * Relative URLs and bare fragments have no scheme and stay — they cannot
 * execute. A value WITH a scheme must name one of {@link SAFE_SCHEMES},
 * except `data:image/*`, which is how mammoth inlines a document's embedded
 * pictures: those are inert in an `<img>` (SVG included — scripts inside an
 * SVG do not run when it is loaded as an image).
 */
function isSafeUrl(raw: string, allowInlineImage: boolean): boolean {
  const normalized = raw.replace(URL_IGNORED_CHARS, '').toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized);
  if (!scheme) return true; // relative, or a `#fragment` — same document
  if (SAFE_SCHEMES.has(scheme[1])) return true;
  return allowInlineImage && normalized.startsWith('data:image/');
}

/**
 * Strip script-capable URLs and event handlers from `html`, returning the
 * cleaned markup. Content is preserved wherever possible: an unsafe link
 * loses its `href` and keeps its text, so the document still reads correctly
 * rather than silently losing a passage.
 */
export function sanitizeDocxHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  for (const el of Array.from(doc.body.querySelectorAll('*'))) {
    // `attributes` is live — snapshot it before removing anything.
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();

      // `onclick`, `onerror`, … — never emitted by mammoth, never welcome.
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }

      if (URL_ATTRIBUTES.includes(name)) {
        const allowInlineImage = el.tagName.toLowerCase() === 'img' && name === 'src';
        if (!isSafeUrl(attr.value, allowInlineImage)) {
          el.removeAttribute(attr.name);
        }
      }
    }

    // A `target` comes from the document's own `targetFrame`; pair it with
    // `rel` so the opened page cannot reach back through `window.opener`.
    if (el.tagName.toLowerCase() === 'a' && el.hasAttribute('target')) {
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }

  return doc.body.innerHTML;
}
