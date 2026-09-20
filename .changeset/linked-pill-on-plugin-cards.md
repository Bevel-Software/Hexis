---
'@bevel-software/platform-core-frontend': patch
'@bevel-software/platform-core-backend': patch
---

A plugin's page now marks the skills and tools that live somewhere else. A linked item wears a "Linked" pill beside its name, in the Owner pill's dress, and the pill's tooltip names where the item actually is — "Lives in Skills/Testing; linked from this plugin's manifest". An inline item, one sitting in the plugin's own folder, wears nothing: it is simply here, and a pill on every card would be three more words saying nothing.

The report behind it was a skill on a plugin's page that the Advanced tree did not list under the plugin's folder. Both surfaces were right — the skill is linked, and the tree shows the disk — and the page was the one saying nothing; the LINKED badge only ever appeared on the skill's own page, which is not where anybody was looking. The tree is unchanged.

Tools reach a plugin the same way skills do and now say so too. A `.tool` manual sitting beside the skills under a root the manifest points at arrives with them, so `GET /api/plugins` serves each plugin's linked roots and counts those tools in its total — previously such a tool belonged to no plugin's page at all, while the skills beside it did. A tool reached that way is not offered a Remove: the link is the manifest pointing at somebody else's folder, and it is removed where it lives.
