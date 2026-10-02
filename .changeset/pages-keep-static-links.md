---
'@bevel-software/platform-core-frontend': minor
---

HTML pages keep the links written in their markup. An anchor pointing at
another `.md`, `.html` or `.htm` document of the knowledge base, at a
`/workspace/…` address, or at an `http:`, `https:` or `mailto:` destination now
survives sanitization: a click on the first opens that document in the app,
resolved against the linking page's own folder, and a click on the second opens
a new tab with `noopener,noreferrer` while the app stays put. Every other
address still loses its `href` — `javascript:`, `data:`, `file:`, `vbscript:`,
protocol-relative and any unnamed scheme — and the scheme is read the way a
browser reads it, so case, padding and tabs inside it disguise nothing.
