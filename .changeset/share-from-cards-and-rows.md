---
'@bevel-software/platform-core-frontend': patch
---

Every skill card and plugin row on Everything, Owned by me and a group's page now carries its own "…" menu, so sharing is offered on the thing you are looking at rather than only on the page you have to open first. The button appears on hover and on focus and is a real tab stop after the card; a right-click anywhere on the card or row opens the same menu at the pointer. Opening it moves focus to the first item, the arrow keys (and Home/End) walk the list, and Escape closes it and hands focus back to the button. Clicking the card or row body still opens the item, exactly as before.

A skill's "Share" opens Manage access on the skill's own folder — the same dialog, on the same folder, as the skill page's Share. A plugin's opens it on the plugin's primary folder, as the plugin page's does. For a plugin the caller cannot read, the menu offers "Subscribe" in place of Share: the same request, the same toast naming the people who decide, and the same "Requested" afterwards as the locked plugin page's button. The gallery hosts one access dialog for both bands, reading the default branch the catalog itself was read from.

Tool cards are unchanged and carry no menu — access to a tool is decided at the plugin that carries it, so a tool has no rules of its own to open. The card's props now say so in the type rather than leaving it to a runtime check.
