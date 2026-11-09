---
"@bevel-software/platform-core-frontend": patch
"@bevel-software/platform-core-backend": patch
"@bevel-software/platform-shared": patch
---

An HTML page runs only the scripts it ships with.

The frame's Content-Security-Policy no longer allows `script-src 'unsafe-inline'`. `buildSandboxedHtml` lists the SHA-256 of every inline script and every inline event handler in the document it returns (with `'unsafe-hashes'` when there is a handler), read with the browser's own parser from that same document. Every script and handler written in the page still runs, in source order, after the platform runtime. A script the page creates at runtime (`createElement('script')`, `document.write`), an `on…` handler it sets at runtime (by attribute or through `innerHTML`) and a `javascript:` URL do not run, unless the text is byte-identical to a script or handler the page already holds. So a remembered Allow, bound to the page's content, covers all code that can run. The policy never lists `'strict-dynamic'`. An email body, which runs no script, gets `script-src 'none'`.

A page that built its buttons with `innerHTML = '<button onclick="…">'` or loaded code into a new script element stops doing so on this release: attach handlers with `addEventListener`. The agent guide's HTML views section says so, and that an Allow covers the page's code while what the code does may depend on the files it reads.

`@bevel-software/platform-shared` exports `sha256Base64(text)`, the same digest as `sha256Hex` in base64.
