---
'@bevel-software/platform-core-backend': minor
'@bevel-software/platform-core-frontend': patch
---

`move_file` now tells an agent what the app's move confirmation tells a person: who loses and who gains opening or editing the file or folder. The dry run (and an unconfirmed move) answers `holderChanges: { lose, gain }`, each entry `{ kind, name, email?, verb }`. A move that changes anyone's access, not only the caller's, now wants `confirm: true`, and the description asks the agent to tell the person who loses and who gains before it confirms.

A caller must be able to read what moves and the folder it lands in, on every branch: a move preview reads both ends, and the destination folder's rules are what the names are made of. Either end unreadable is refused as `read_file` refuses it, before anything is looked at — where before, on a draft, a file the caller could not open could be moved and the folder's rules read off the answer. A folder the caller may read still moves with everything in it, files they may not read included.

The app's move confirmation shows the same answer. `GET /access/prospective` returns `changes` beside its two holder lists and refuses (403) a caller who may not read the destination folder, as it already refused one who may not read what moves; the dialog renders `changes` instead of diffing the lists, which named a writer leaving a folder everyone reads as losing `read` it keeps and could not name a person the destination denies.

The changes come from a new `IAccessControl.prospectiveHolderChanges`, using the same proposed relocation as `prospectiveHolders`. Everyone a rule on either side names, as a grant or a denial, and every listed holder is put to both sides' resolvers, and counts as losing (or gaining) a verb only when the resolver says so. A team handing a folder to another team in a knowledge base everyone reads shows only the change in who may edit, and someone the destination denies by name is named, even when their only access before was `everyone`.
