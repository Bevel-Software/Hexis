---
'@bevel-software/platform-core-frontend': minor
---

HTML pages keep the links written in their markup. An anchor pointing at
another `.md`, `.html` or `.htm` document of the knowledge base, at a
`/workspace/…` address, or at an `http:`, `https:` or `mailto:` destination now
survives sanitization: a click on a knowledge-base document or a `/workspace/…`
address opens that document in the app — a relative one resolved against the
linking page's own folder — and a click on an `http:`, `https:` or `mailto:`
destination opens a new tab with `noopener,noreferrer` while the app stays put.
Every other address still loses its `href` — `javascript:`, `data:`, `file:`,
`vbscript:`, protocol-relative and any unnamed scheme — and an href is read the
way a browser reads it, so case, padding and tabs inside it disguise nothing.
That same reading now carries through to the click: a padded href opens the
address it names rather than one with the padding baked into the filename.
