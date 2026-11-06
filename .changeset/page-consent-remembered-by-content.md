---
"@bevel-software/platform-core-frontend": minor
"@bevel-software/platform-core-backend": minor
"@bevel-software/platform-shared": patch
---

An HTML page's write-consent card speaks plainly, an Allow is remembered for that exact page, and pages reach platform tools only.

The card before a page's first writing call reads "You're allowing changes using your account. Do you want to allow that?", with the page's path under it and the buttons Don't allow and Allow. Allow runs the waiting calls and every later writing call of the view, as before, and the browser now keeps the SHA-256 digest of the page's source in `localStorage`, for the signed-in account (one `bevel.account/<account>/htmlPage.allowedWrite.<digest>` entry per distinct content digest, so Allows in two tabs never overwrite each other, and identical content at two paths shares one entry; each account keeps its 500 most recently allowed digests). A page whose source hashes to a digest the account keeps asks that account nothing on any later view, reload or path; a source whose digest it does not keep asks again, so an edit asks once and changing back to an allowed source does not. Another account on the same browser is asked afresh. Signing out from the app clears what the signed-out account kept; a session that ends without signing out leaves the entries, which only that account reads. With no signed-in account above the renderer nothing is kept and every view asks. Don't allow is never remembered. A browser that cannot store asks on every view, as before.

The hosted MCP server uses `X-Bevel-Page` to build a surface from the platform manual alone, cached apart from the person's own: a page no longer lists or calls the tools of a `.tool` manual or a plugin's MCP server, directly or in `callToolChain`, and such a call is answered as an unknown tool. The person's own agent is unchanged. A knowledge-base page that called such a tool stops working on this release.

`@bevel-software/platform-shared` exports `sha256Hex(text)`, a dependency-free SHA-256 of a string's UTF-8 bytes that works in any browser context, secure or not.

For implementers: `useHtmlToolBridge` takes a required `source`, the page's HTML as the renderer received it; a renderer of its own that omits it fails to compile. The agent guide's HTML views section says all of the above.
