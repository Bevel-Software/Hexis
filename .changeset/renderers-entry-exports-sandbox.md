---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-core-backend': patch
---

Two module entries export what a distribution's own code needs, so it stops importing core's files past them. The renderers entry (`modules/workspace/components/renderers`) exports `buildSandboxedHtml`, `sanitizeAgentHtml` and `BuildSandboxedHtmlOptions`: a distribution's HTML renderer that inlines its libraries into the frame, as bevel-platform's knowledge-graph renderer does, builds its document the way core's `HtmlRenderer` builds core's, and its tests prove what a page sees the way core's do. The auth entry (`modules/auth`) exports `AuthProviderPlugin`, `setAuthCookie`, `authCookieSecure` and `AUTH_COOKIE_NAME`: a distribution's sign-in provider implements the contract and sets the one cookie password login sets. No behaviour changes.
