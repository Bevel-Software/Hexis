---
'@bevel-software/platform-core-frontend': patch
---

Saving or removing a key now refreshes the rest of the Library at once. A tester saved a key on a tool page, pressed back, and the plugin still called the tool unconfigured: its card, its banner and the sidebar count all read "needs setup" off the library catalog, which was loaded before the save. Only the tool page looked right, because it is the one surface that re-probes itself — which is exactly why the staleness showed up one click later, on the page nobody was watching.

Every surface that can write a tool credential — the tool page, "Connect your tools", the Secrets vault and the `.tool` editor's panel — now announces the landing on a shared `bevel:tool-credentials-stale` event, and the Library reloads its catalog *and* its plugin summaries in response. The summaries go with it deliberately: the counts behind the banner and the sidebar come from there, and a catalog-only reload leaves yesterday's number beside a card that has moved on. Returning from an OAuth sign-in announces the same thing, authorized or not: nothing local wrote anything, and the outcome we were handed is the only evidence either way about a grant somebody else decided.

An event rather than a direct call because `/connect` and `/secrets` are shell routes of their own, with no Library mounted beneath them to reach for — announcing regardless keeps one rule for every surface, and an unheard announcement costs nothing.

A failed save announces nothing. It changed nothing, and a reload on it would blink every card in the Library for no reason — worse, it would teach the reader that the blink means something happened.
