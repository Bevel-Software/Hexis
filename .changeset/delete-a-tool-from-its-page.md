---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': minor
---

An owner can delete a tool from its own page, after seeing what depends on it. The `⋯` menu beside a tool's title now carries Delete for owners of the plugin holding the tool — the same place, and the same ownership verdict, as the plugin page's own Delete; nobody else sees it, and the backend refuses them.

The confirmation is built from what the deletion would actually break: the skills whose allowed tools name the tool, the other plugins that carry it, and how many keys and sign-ins are stored under its name — counts across every user, never a value and never whose. Confirming removes the `.tool` file or the entry in the plugin's `mcp.json` (with its half of `plugin.json`) in one commit, wipes the stored secrets under that name, and returns to the plugin page, with the cards, the sidebar and agent discovery agreeing on the next request rather than after a restart. A refused commit puts the tool back untouched, credentials included. The dependent skills' files are deliberately not edited: their allowed-tools entry becomes a name that no longer resolves.
