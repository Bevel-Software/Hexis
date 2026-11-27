---
'@bevel-software/platform-core-frontend': patch
---

The access verbs now say what they let someone do where a person picks or reads them. In Manage access, each verb in an opened picker (beside the add field, and on a grantee row) shows a muted line under it: Can read "Open and read it", Can edit "Read, change, approve, manage access; no download", Can download "Read and save a copy", Owner "Can edit and download; the one people ask". Each request choice shows its own line under it. A reader who cannot change the access sees each row's verbs as a quiet button that opens the same picker read-only, with every line and nothing to pick. The lines are also the accessible description of those items, the request radios and the closed verb buttons. A row's own note ("from Sales", "restricted here") comes first in an item's description. A disabled item dims its label, not its line. The note for a reader who cannot change the access now says "Only people with edit access can manage access here." The closed dialog shows none of the lines.

The Library's Owner pill keeps its tooltip, and the card or plugin row that carries it is described by its line for assistive tech; on a plugin the line adds that an owner may delete it. `MenuItem` takes an optional `description`: a muted line under the label, kept out of the item's accessible name. Who may do what is unchanged.
