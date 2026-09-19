---
'@bevel-software/platform-core-frontend': patch
---

Every upload now says what happened, once, in the tree the file was dropped into.

A drop reports itself on the first tick. Until now nothing at all appeared until the app had worked out where the bytes should go, and on the first upload of a session into a folder the user cannot write that took the longest it ever takes: their personal suggestions branch had to be created and a workspace cloned for it before the change request could be opened. A suggestion-routed upload draws no optimistic rows either, on purpose, so for the whole of that wait the sidebar showed nothing whatsoever — the reported "first upload, nothing happened; second one, the message appeared". An in-progress notice now names the file and the folder from the moment of the drop, and is replaced by the result.

The upload notices are shown once per page. The Knowledge explorer and the Library sidebar's two trees (`Skills/` and `Plugins/`) each render the upload banners over one shared piece of state, so a single drop into `Skills/` used to paint the same "the upload became a suggestion" notice above both Library trees. Each tree names itself and draws only the banners that carry its name.

A refused upload shows the whole refusal. The banner was one truncated line — "Couldn't add knowledge-base/K…" — with the server's reason hidden in a tooltip. It now names the file, gives the server's reason in full over as many lines as it needs, and ends with what to do about it: try another folder or ask its owner for a permission refusal, a smaller file for a size limit, try again otherwise.
