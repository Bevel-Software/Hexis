---
'@bevel-software/platform-core-backend': patch
'@bevel-software/platform-core-frontend': patch
---

Connecting Claude to a workspace is now one click. Anthropic publishes an
install link that opens claude.ai's "Add custom connector" dialog with the name
and URL already filled in, and the welcome page and the External agent access
page both offer it. It only prefills — the person still reviews and confirms,
and Claude marks the values as having come from an external link — so it is a
shortcut through a four-step menu path, not a grant of anything. The
copy-and-paste URL stays exactly where it was, because it is the route that
works on every deployment.

The button is Claude-only, since Claude is the only client with such a link,
and it does not appear at all when this deployment is one Anthropic could not
reach: plain http, localhost, or a private address. That is not an edge case,
it is what an unconfigured install runs as, and a bright button that always
fails is worse on a first-run screen than no button. Where the reader can
plausibly do something about it — the settings page, not the welcome page —
the empty space says which variable to set.

Underneath it, a correctness fix that was overdue. The frontend built its MCP
URL from `window.location.origin` in seven places while the OAuth authorization
server declared its protected resource from `PUBLIC_BACKEND_URL`. Those agree
on a simple deployment and disagree behind a proxy, on a second domain, or on
an internal hostname — and the one that decides whether a connection works is
the OAuth resource identifier, not the browser's address bar. Copy-paste
tolerated the divergence because a human reads the host before pasting it;
handing the URL to a third party does not. The deployment's own answer now
travels on `/api/config`, derived from the same expression as the OAuth
resource so the two cannot drift, and every snippet on both pages is built from
it.

The connection instructions moved into a shared module and a shared component,
so the two pages render the same thing instead of agreeing by convention. The
file holding them had no tests at all; it has them now, including one per URL
site and one asserting the page origin appears in no snippet anywhere.
