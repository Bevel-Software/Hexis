---
'@bevel-software/platform-core-backend': minor
---

`move_file` now tells an agent what the app's move confirmation tells a person: who loses and who gains opening or editing the file or folder. The dry run (and an unconfirmed move) answers `holderChanges: { lose, gain }`, each entry `{ kind, name, email?, verb }`, under the same rule as the app's route: only to a caller who may read what moves. A move that changes anyone's access, not only the caller's, now wants `confirm: true`, and the description asks the agent to tell the person who loses and who gains before it confirms.

The changes come from a new `IAccessControl.prospectiveHolderChanges`, using the same proposed relocation as `prospectiveHolders`. Everyone a rule on either side names, as a grant or a denial, and every listed holder is put to both sides' resolvers, and counts as losing (or gaining) a verb only when the resolver says so. A team handing a folder to another team in a knowledge base everyone reads shows only the change in who may edit, and someone the destination denies by name is named, even when their only access before was `everyone`.
