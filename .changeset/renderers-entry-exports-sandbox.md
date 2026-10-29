---
'@bevel-software/platform-core-frontend': patch
---

The renderers entry (`modules/workspace/components/renderers`) exports `buildSandboxedHtml`, `sanitizeAgentHtml` and `BuildSandboxedHtmlOptions`. A distribution's own HTML renderer — one that inlines its libraries into the frame, as bevel-platform's knowledge-graph renderer does — builds its document the way core's `HtmlRenderer` builds core's, and its tests prove what a page sees the way core's do; until now that meant importing `htmlSandbox.ts` past the entry. No behaviour changes.
