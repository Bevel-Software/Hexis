---
'@bevel-software/platform-core-backend': minor
---

`move_file` now tells an agent what the app's move confirmation tells a person: who loses and who gains opening or editing the file or folder. The dry run (and an unconfirmed move) answers `holderChanges: { lose, gain }`, each entry `{ kind, name, email?, verb }`, from the same `prospectiveHolders` lookup and under the same rule as the app's route: only to a caller who may read what moves. A move that changes anyone's access, not only the caller's, now wants `confirm: true`, and the description asks the agent to tell the person who loses and who gains before it confirms. While `everyone` may open the thing on the far side, nobody is listed as losing `read`, so a team handing a folder to another team in a knowledge base everyone reads shows only the change in who may edit.
